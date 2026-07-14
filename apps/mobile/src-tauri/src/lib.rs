// Muse 移动端 Tauri 入口。
//
// 移动端本期不提供任何本地文件/命令工具（不注册 workspace tools）：
// 云端只读工具 + 联网搜索由服务端提供，文件/命令类工具借用桌面端执行。
// 因此这里只做最小初始化：opener 插件用于在系统浏览器完成飞书 OAuth 授权。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Muse mobile");
}
