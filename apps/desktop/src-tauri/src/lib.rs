use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryEntry {
    name: String,
    path: String,
    kind: String,
    size: Option<u64>,
    readonly: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    path: String,
    entries: Vec<DirectoryEntry>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileReadResult {
    path: String,
    content: String,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileWriteResult {
    path: String,
    created: bool,
    bytes_written: usize,
    previous_content: Option<String>,
    previous_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PatchApplyResult {
    path: String,
    bytes_written: usize,
    hunks_applied: usize,
    previous_content: String,
    previous_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    path: String,
    line: u32,
    preview: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    query: String,
    matches: Vec<SearchMatch>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandRunResult {
    command: String,
    cwd: String,
    exit_code: Option<i32>,
    timed_out: bool,
    duration_ms: u128,
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

fn is_denied_path(path: &Path) -> bool {
    path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy();
        value == ".env" || value.starts_with(".env.") || value == ".ssh" || value == "Keychains"
    })
}

fn canonicalize_inside_workspace(path: &str, workspace_root: &str) -> Result<PathBuf, String> {
    let root = Path::new(workspace_root)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let requested = Path::new(path);
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("Failed to resolve path: {error}"))?;

    if !resolved.starts_with(&root) {
        return Err("Path is outside the attached workspace.".to_string());
    }
    if is_denied_path(&resolved) {
        return Err("Path is denied by local tool policy.".to_string());
    }

    Ok(resolved)
}

fn resolve_write_path_inside_workspace(
    path: &str,
    workspace_root: &str,
) -> Result<PathBuf, String> {
    let root = Path::new(workspace_root)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let requested = Path::new(path);
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };

    if candidate.exists() {
        return canonicalize_inside_workspace(path, workspace_root);
    }

    let parent = candidate
        .parent()
        .ok_or_else(|| "Path has no parent directory.".to_string())?
        .canonicalize()
        .map_err(|error| format!("Failed to resolve parent directory: {error}"))?;

    if !parent.starts_with(&root) {
        return Err("Path is outside the attached workspace.".to_string());
    }
    if is_denied_path(&parent) || is_denied_path(&candidate) {
        return Err("Path is denied by local tool policy.".to_string());
    }

    Ok(parent.join(
        candidate
            .file_name()
            .ok_or_else(|| "Path has no file name.".to_string())?,
    ))
}

fn is_denied_command(command: &str) -> bool {
    let normalized = command.to_lowercase();
    [
        "sudo",
        "rm -rf",
        "git reset --hard",
        "git clean -fd",
        "chmod",
        "chown",
        "curl | sh",
        "curl|sh",
        "wget | sh",
        "wget|sh",
        "~/.ssh",
        "/.ssh",
        "library/keychains",
        ".env",
    ]
    .iter()
    .any(|pattern| normalized.contains(pattern))
}

fn truncate_text(bytes: &[u8], max_bytes: usize) -> (String, bool) {
    if bytes.len() <= max_bytes {
        return (String::from_utf8_lossy(bytes).to_string(), false);
    }

    let mut value = String::from_utf8_lossy(&bytes[..max_bytes]).to_string();
    value.push_str(&format!("\n[output truncated at {max_bytes} bytes]"));
    (value, true)
}

fn parse_hunk_old_start(header: &str) -> Result<usize, String> {
    let old_range = header
        .split_whitespace()
        .find(|part| part.starts_with('-'))
        .ok_or_else(|| "Patch hunk header is missing old range.".to_string())?;
    let start = old_range
        .trim_start_matches('-')
        .split(',')
        .next()
        .ok_or_else(|| "Patch hunk header has invalid old range.".to_string())?
        .parse::<usize>()
        .map_err(|error| format!("Patch hunk header has invalid old line: {error}"))?;

    Ok(start.saturating_sub(1))
}

fn apply_unified_patch(original: &str, patch: &str) -> Result<(String, usize), String> {
    let original_lines: Vec<&str> = original.split_inclusive('\n').collect();
    let mut output = String::new();
    let mut source_index = 0usize;
    let mut hunk_count = 0usize;
    let patch_lines: Vec<&str> = patch.lines().collect();
    let mut index = 0usize;

    while index < patch_lines.len() {
        let line = patch_lines[index];
        if line.starts_with("--- ") || line.starts_with("+++ ") || line.trim().is_empty() {
            index += 1;
            continue;
        }
        if !line.starts_with("@@") {
            return Err(format!("Unsupported patch line: {line}"));
        }

        let hunk_start = parse_hunk_old_start(line)?;
        if hunk_start < source_index {
            return Err("Patch hunks overlap or are out of order.".to_string());
        }

        while source_index < hunk_start && source_index < original_lines.len() {
            output.push_str(original_lines[source_index]);
            source_index += 1;
        }

        index += 1;
        hunk_count += 1;

        while index < patch_lines.len() && !patch_lines[index].starts_with("@@") {
            let patch_line = patch_lines[index];
            if patch_line == r"\ No newline at end of file" {
                index += 1;
                continue;
            }

            let (prefix, text) = patch_line.split_at(1);
            let text_with_newline = format!("{text}\n");
            match prefix {
                " " => {
                    let current = original_lines
                        .get(source_index)
                        .ok_or_else(|| "Patch context exceeds file length.".to_string())?;
                    if *current != text_with_newline {
                        return Err(format!(
                            "Patch context mismatch near line {}.",
                            source_index + 1
                        ));
                    }
                    output.push_str(current);
                    source_index += 1;
                }
                "-" => {
                    let current = original_lines
                        .get(source_index)
                        .ok_or_else(|| "Patch removal exceeds file length.".to_string())?;
                    if *current != text_with_newline {
                        return Err(format!(
                            "Patch removal mismatch near line {}.",
                            source_index + 1
                        ));
                    }
                    source_index += 1;
                }
                "+" => {
                    output.push_str(&text_with_newline);
                }
                _ => {
                    return Err(format!("Unsupported patch hunk line: {patch_line}"));
                }
            }

            index += 1;
        }
    }

    if hunk_count == 0 {
        return Err("Patch has no hunks.".to_string());
    }

    while source_index < original_lines.len() {
        output.push_str(original_lines[source_index]);
        source_index += 1;
    }

    Ok((output, hunk_count))
}

#[tauri::command]
fn list_workspace_directory(path: &str, workspace_root: &str) -> Result<DirectoryListing, String> {
    let resolved = canonicalize_inside_workspace(path, workspace_root)?;
    let mut entries = Vec::new();
    let mut truncated = false;

    for item in std::fs::read_dir(&resolved)
        .map_err(|error| format!("Failed to list directory: {error}"))?
    {
        if entries.len() >= 200 {
            truncated = true;
            break;
        }

        let item = item.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let metadata = item
            .metadata()
            .map_err(|error| format!("Failed to read directory entry metadata: {error}"))?;
        let kind = if metadata.is_dir() {
            "directory"
        } else if metadata.is_file() {
            "file"
        } else {
            "other"
        };
        let path = item
            .path()
            .canonicalize()
            .unwrap_or_else(|_| item.path())
            .display()
            .to_string();

        entries.push(DirectoryEntry {
            name: item.file_name().to_string_lossy().to_string(),
            path,
            kind: kind.to_string(),
            size: if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            },
            readonly: metadata.permissions().readonly(),
        });
    }

    entries.sort_by(|left, right| left.name.cmp(&right.name));

    Ok(DirectoryListing {
        path: resolved.display().to_string(),
        entries,
        truncated,
    })
}

#[tauri::command]
fn read_workspace_file(path: &str, workspace_root: &str) -> Result<FileReadResult, String> {
    const MAX_BYTES: usize = 32 * 1024;
    let resolved = canonicalize_inside_workspace(path, workspace_root)?;
    let metadata = fs::metadata(&resolved)
        .map_err(|error| format!("Failed to read file metadata: {error}"))?;

    if !metadata.is_file() {
        return Err("Path is not a file.".to_string());
    }

    let bytes = fs::read(&resolved).map_err(|error| format!("Failed to read file: {error}"))?;
    let truncated = bytes.len() > MAX_BYTES;
    let visible_bytes = if truncated {
        &bytes[..MAX_BYTES]
    } else {
        bytes.as_slice()
    };
    let content = String::from_utf8_lossy(visible_bytes).to_string();

    Ok(FileReadResult {
        path: resolved.display().to_string(),
        content,
        truncated,
    })
}

#[tauri::command]
fn write_workspace_file(
    path: &str,
    content: &str,
    workspace_root: &str,
) -> Result<FileWriteResult, String> {
    const MAX_WRITE_BYTES: usize = 256 * 1024;
    const MAX_PREVIOUS_BYTES: usize = 32 * 1024;

    if path.trim().is_empty() {
        return Err("Missing path.".to_string());
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("File content exceeds {MAX_WRITE_BYTES} bytes."));
    }

    let resolved = resolve_write_path_inside_workspace(path, workspace_root)?;
    let existed = resolved.exists();
    let (previous_content, previous_truncated) = if existed {
        let metadata = fs::metadata(&resolved)
            .map_err(|error| format!("Failed to read file metadata: {error}"))?;
        if !metadata.is_file() {
            return Err("Path is not a file.".to_string());
        }
        let previous = fs::read(&resolved)
            .map_err(|error| format!("Failed to read previous file content: {error}"))?;
        let (content, truncated) = truncate_text(&previous, MAX_PREVIOUS_BYTES);
        (Some(content), truncated)
    } else {
        (None, false)
    };

    fs::write(&resolved, content).map_err(|error| format!("Failed to write file: {error}"))?;

    Ok(FileWriteResult {
        path: resolved.display().to_string(),
        created: !existed,
        bytes_written: content.len(),
        previous_content,
        previous_truncated,
    })
}

#[tauri::command]
fn apply_workspace_patch(
    path: &str,
    patch: &str,
    workspace_root: &str,
) -> Result<PatchApplyResult, String> {
    const MAX_PATCH_BYTES: usize = 256 * 1024;
    const MAX_RESULT_BYTES: usize = 512 * 1024;
    const MAX_PREVIOUS_BYTES: usize = 32 * 1024;

    if path.trim().is_empty() {
        return Err("Missing path.".to_string());
    }
    if patch.trim().is_empty() {
        return Err("Missing patch.".to_string());
    }
    if patch.len() > MAX_PATCH_BYTES {
        return Err(format!("Patch exceeds {MAX_PATCH_BYTES} bytes."));
    }

    let resolved = canonicalize_inside_workspace(path, workspace_root)?;
    let metadata = fs::metadata(&resolved)
        .map_err(|error| format!("Failed to read file metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("Path is not a file.".to_string());
    }

    let previous = fs::read_to_string(&resolved)
        .map_err(|error| format!("Failed to read file as UTF-8 text: {error}"))?;
    let (next, hunk_count) = apply_unified_patch(&previous, patch)?;
    if next.len() > MAX_RESULT_BYTES {
        return Err(format!("Patched file exceeds {MAX_RESULT_BYTES} bytes."));
    }

    fs::write(&resolved, &next)
        .map_err(|error| format!("Failed to write patched file: {error}"))?;
    let (previous_content, previous_truncated) =
        truncate_text(previous.as_bytes(), MAX_PREVIOUS_BYTES);

    Ok(PatchApplyResult {
        path: resolved.display().to_string(),
        bytes_written: next.len(),
        hunks_applied: hunk_count,
        previous_content,
        previous_truncated,
    })
}

fn collect_files(root: &Path, output: &mut Vec<PathBuf>, limit: usize) -> Result<bool, String> {
    for item in
        fs::read_dir(root).map_err(|error| format!("Failed to search directory: {error}"))?
    {
        if output.len() >= limit {
            return Ok(true);
        }

        let item = item.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let path = item.path();
        let metadata = item
            .metadata()
            .map_err(|error| format!("Failed to read directory metadata: {error}"))?;
        if is_denied_path(&path) {
            continue;
        }
        if metadata.is_dir() {
            if collect_files(&path, output, limit)? {
                return Ok(true);
            }
        } else if metadata.is_file() {
            output.push(path);
        }
    }

    Ok(false)
}

#[tauri::command]
fn search_workspace_files(
    query: &str,
    path: &str,
    workspace_root: &str,
) -> Result<SearchResult, String> {
    const MAX_FILES: usize = 500;
    const MAX_MATCHES: usize = 80;
    const MAX_FILE_BYTES: u64 = 256 * 1024;

    let query = query.trim();
    if query.is_empty() {
        return Err("Missing search query.".to_string());
    }

    let root = canonicalize_inside_workspace(path, workspace_root)?;
    let mut files = Vec::new();
    let mut truncated = collect_files(&root, &mut files, MAX_FILES)?;
    let mut matches = Vec::new();

    for file in files {
        if matches.len() >= MAX_MATCHES {
            truncated = true;
            break;
        }

        let metadata = match fs::metadata(&file) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if metadata.len() > MAX_FILE_BYTES {
            continue;
        }
        let content = match fs::read_to_string(&file) {
            Ok(value) => value,
            Err(_) => continue,
        };
        for (index, line) in content.lines().enumerate() {
            if line.contains(query) {
                matches.push(SearchMatch {
                    path: file.display().to_string(),
                    line: (index + 1) as u32,
                    preview: line.chars().take(240).collect(),
                });
                if matches.len() >= MAX_MATCHES {
                    truncated = true;
                    break;
                }
            }
        }
    }

    Ok(SearchResult {
        query: query.to_string(),
        matches,
        truncated,
    })
}

#[tauri::command]
fn run_workspace_command(
    command: &str,
    cwd: &str,
    workspace_root: &str,
    timeout_ms: Option<u64>,
    max_output_bytes: Option<usize>,
) -> Result<CommandRunResult, String> {
    if command.trim().is_empty() {
        return Err("Missing command.".to_string());
    }
    if is_denied_command(command) {
        return Err("Command is denied by local tool policy.".to_string());
    }

    let resolved_cwd = canonicalize_inside_workspace(cwd, workspace_root)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15_000).clamp(1_000, 60_000));
    let max_output_bytes = max_output_bytes
        .unwrap_or(32 * 1024)
        .clamp(1_024, 256 * 1024);
    let started_at = Instant::now();
    let mut child = Command::new("/bin/bash")
        .arg("-lc")
        .arg(command)
        .current_dir(&resolved_cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to spawn command: {error}"))?;

    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(format!("Failed to wait for command: {error}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Failed to collect command output: {error}"))?;
    let (stdout, stdout_truncated) = truncate_text(&output.stdout, max_output_bytes);
    let (stderr, stderr_truncated) = truncate_text(&output.stderr, max_output_bytes);

    Ok(CommandRunResult {
        command: command.to_string(),
        cwd: resolved_cwd.display().to_string(),
        exit_code: output.status.code(),
        timed_out,
        duration_ms: started_at.elapsed().as_millis(),
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_workspace_directory,
            read_workspace_file,
            write_workspace_file,
            apply_workspace_patch,
            search_workspace_files,
            run_workspace_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running Muse desktop");
}
