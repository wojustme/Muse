import {
  AlertCircle,
  ArrowLeft,
  Check,
  Globe2,
  Loader2,
  LogOut,
  MessageSquare,
  MonitorSmartphone,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  SendHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AuthUser } from "@muse/shared";
import {
  authHeaders,
  eventsUrl,
  fetchMe,
  loadClientId,
  logout,
  postActiveSession,
  postApprovalDecision,
} from "./auth/client";
import { LoginScreen } from "./auth/LoginScreen";
import { MuseMark, MuseWordmark } from "./BrandMark";
import { resolveServerUrl } from "./config/server-url";
import { detectPlatform, platformOsLabel } from "./platform";
import {
  useRemoteDevices,
  type RemoteSelection,
} from "./remote/useRemoteDevices";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
  toolCalls?: ToolRuntimeCall[];
  // 流式接收中：用于渲染打字机光标，接收完成后置为 false。
  streaming?: boolean;
};

type ToolRuntimeCall = {
  id: string;
  name: string;
  source?: string;
  riskLevel?: "read" | "write" | "dangerous";
  requiresApproval?: boolean;
  status: "running" | "awaiting-approval" | "succeeded" | "failed";
  input?: unknown;
  output?: unknown;
  error?: string;
};

// 手机端审批弹窗数据：来自服务端 SSE 的 approval-request 事件。
type ApprovalPrompt = {
  approvalId: string;
  eventId: string;
  toolName: string;
  riskLevel: "read" | "write" | "dangerous";
  workspaceName?: string;
  inputPreview: {
    path?: string;
    command?: string;
    cwd?: string;
    bytes?: number;
    patchPreview?: string;
    contentPreview?: string;
  };
  expiresAt: string;
};

type ModelSelection = {
  provider: string;
  name: string;
  displayName?: string;
};

type ModelOption = ModelSelection & {
  capabilities?: string[];
};

type Session = {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  model: ModelSelection | null;
  messages: Message[];
  messagesLoaded: boolean;
  isDraft?: boolean;
};

type ServerSession = {
  id: string;
  title: string;
  updatedAt: string;
  createdAt?: string;
  modelProvider?: string;
  modelName?: string;
  lastMessagePreview?: string;
  messageCount?: number;
};

type ServerMessage = {
  id: string;
  role: "user" | "assistant";
  content?: string;
  parts?: Array<{ type: string; text?: string }>;
  createdAt?: string;
};

// 移动端上报的 client 上下文。服务端 chat 路由据此生成 system prompt。
function buildClientContext(remote: RemoteSelection | null) {
  const platform = detectPlatform();
  return {
    app: "Muse Mobile",
    runtime: "tauri-webview",
    os: platformOsLabel(platform),
    platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    // 借用桌面工具时，把远程设备信息透传给模型，让它知道文件/命令类工具会在桌面执行。
    localToolsHost: remote
      ? {
          status: "remote",
          deviceId: remote.deviceId,
          workspaceId: remote.workspaceId,
          workspaceName: remote.workspaceName,
        }
      : undefined,
  };
}

function modelKey(model: ModelSelection): string {
  return `${model.provider}:${model.name}`;
}

function modelLabel(model: ModelSelection | null | undefined): string {
  if (!model) {
    return "未选择模型";
  }
  return model.displayName || `${model.provider}/${model.name}`;
}

function createDraftSession(model: ModelSelection | null): Session {
  return {
    id: crypto.randomUUID(),
    title: "新对话",
    preview: "准备开始一个新的 session。",
    updatedAt: "Now",
    model,
    messages: [],
    messagesLoaded: true,
    isDraft: true,
  };
}

function titleFromPrompt(prompt: string): string {
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  return trimmed.length > 22
    ? `${trimmed.slice(0, 22)}...`
    : trimmed || "新对话";
}

function formatTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Now";
  }

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) {
    return "Now";
  }
  if (diffMs < 3_600_000) {
    return `${Math.max(1, Math.floor(diffMs / 60_000))}m ago`;
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "2-digit",
  }).format(date);
}

async function fetchModels(): Promise<ModelOption[]> {
  const response = await fetch(`${resolveServerUrl()}/api/models`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`获取模型列表失败（${response.status}）`);
  }

  const data = (await response.json()) as { models?: ModelOption[] };
  return data.models?.length
    ? data.models.map((model) => ({
        ...model,
        capabilities: model.capabilities ?? [],
      }))
    : [];
}

async function fetchSessions(
  defaultSelection?: ModelSelection | null,
): Promise<Session[]> {
  const response = await fetch(`${resolveServerUrl()}/api/sessions`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`获取会话列表失败（${response.status}）`);
  }

  const data = (await response.json()) as { sessions?: ServerSession[] };
  return (data.sessions ?? []).map((session) =>
    sessionFromServer(session, defaultSelection),
  );
}

async function deleteSessionRequest(sessionId: string): Promise<void> {
  const response = await fetch(
    `${resolveServerUrl()}/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      headers: authHeaders(),
    },
  );
  if (!response.ok) {
    throw new Error(`删除会话失败（${response.status}）`);
  }
}

async function renameSessionRequest(
  sessionId: string,
  title: string,
): Promise<ServerSession> {
  const response = await fetch(
    `${resolveServerUrl()}/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ title }),
    },
  );
  if (!response.ok) {
    throw new Error(`重命名会话失败（${response.status}）`);
  }
  const data = (await response.json()) as { session: ServerSession };
  return data.session;
}

function sessionFromServer(
  session: ServerSession,
  defaultSelection?: ModelSelection | null,
  messages: Message[] = [],
  messagesLoaded = false,
): Session {
  const model =
    session.modelProvider && session.modelName
      ? {
          provider: session.modelProvider,
          name: session.modelName,
        }
      : (defaultSelection ?? null);

  return {
    id: session.id,
    title: session.title,
    preview: session.lastMessagePreview ?? "打开 session 继续对话。",
    updatedAt: formatTime(session.updatedAt),
    model,
    messages,
    messagesLoaded,
    isDraft: false,
  };
}

function messageText(message: ServerMessage): string {
  const partText = message.parts
    ?.filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n")
    .trim();

  return partText || message.content || "";
}

function initialsFromName(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  const first = [...trimmed][0];
  return first ? first.toUpperCase() : "M";
}

function UserAvatar({
  user,
  className,
}: {
  user: AuthUser;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(user.avatarUrl) && !failed;

  return (
    <span
      className={className ? `account-avatar ${className}` : "account-avatar"}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          alt=""
          onError={() => setFailed(true)}
          referrerPolicy="no-referrer"
          src={user.avatarUrl}
        />
      ) : (
        <span className="account-avatar-fallback">
          {initialsFromName(user.displayName)}
        </span>
      )}
    </span>
  );
}

function MessageText({ message }: { message: Message }) {
  if (message.role === "assistant") {
    return (
      <>
        <div className="message-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.text}
          </ReactMarkdown>
        </div>
        <ToolCallList calls={message.toolCalls ?? []} />
        {message.streaming ? (
          <span className="typing-caret" aria-hidden="true" />
        ) : null}
      </>
    );
  }

  return (
    <p>
      {message.text}
      {message.streaming ? (
        <span className="typing-caret" aria-hidden="true" />
      ) : null}
    </p>
  );
}

function toolValuePreview(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolCallList({ calls }: { calls: ToolRuntimeCall[] }) {
  if (!calls.length) {
    return null;
  }

  return (
    <div className="tool-call-list" aria-label="Tool calls">
      {calls.map((call) => {
        const input = toolValuePreview(call.input);
        const output = toolValuePreview(call.output);
        return (
          <details
            className={`tool-call tool-call-${call.status}`}
            key={call.id}
            open={
              call.status === "running" ||
              call.status === "awaiting-approval" ||
              call.status === "failed"
            }
          >
            <summary>
              <span className={`tool-call-status ${call.status}`}>
                {call.status === "running" ||
                call.status === "awaiting-approval" ? (
                  <Loader2 aria-hidden="true" size={13} strokeWidth={2.2} />
                ) : call.status === "succeeded" ? (
                  <Check aria-hidden="true" size={13} strokeWidth={2.2} />
                ) : (
                  <AlertCircle aria-hidden="true" size={13} strokeWidth={2.2} />
                )}
              </span>
              <Terminal aria-hidden="true" size={14} strokeWidth={2.1} />
              <span className="tool-call-name">{call.name}</span>
              <span className={`tool-call-risk ${call.riskLevel ?? "read"}`}>
                {call.status === "awaiting-approval"
                  ? "awaiting"
                  : call.requiresApproval
                    ? "approval"
                    : (call.riskLevel ?? "read")}
              </span>
            </summary>
            <div className="tool-call-body">
              {input ? (
                <div>
                  <span>Input</span>
                  <pre>{input}</pre>
                </div>
              ) : null}
              {output ? (
                <div>
                  <span>Output</span>
                  <pre>{output}</pre>
                </div>
              ) : null}
              {call.error ? (
                <div>
                  <span>Error</span>
                  <pre>{call.error}</pre>
                </div>
              ) : null}
            </div>
          </details>
        );
      })}
    </div>
  );
}

async function fetchSessionMessages(sessionId: string): Promise<{
  session: ServerSession;
  messages: Message[];
}> {
  const response = await fetch(
    `${resolveServerUrl()}/api/sessions/${encodeURIComponent(
      sessionId,
    )}/messages`,
    { headers: authHeaders() },
  );

  if (!response.ok) {
    throw new Error(`获取消息历史失败（${response.status}）`);
  }

  const data = (await response.json()) as {
    session: ServerSession;
    messages?: ServerMessage[];
  };

  return {
    session: data.session,
    messages: (data.messages ?? []).map((message) => ({
      id: message.id,
      role: message.role,
      text: messageText(message),
      createdAt: message.createdAt,
    })),
  };
}

// 把服务端消息合并进本地当前会话，用于跨端实时同步（轮询拉取）。
// 规则：服务端为权威内容；保留本地正在流式/尚未持久化的消息；两端都有的保留本地 toolCalls。
function mergeServerMessages(local: Message[], server: Message[]): Message[] {
  const localById = new Map(local.map((message) => [message.id, message]));
  const serverIds = new Set(server.map((message) => message.id));

  const merged: Message[] = server.map((serverMessage) => {
    const existing = localById.get(serverMessage.id);
    if (!existing) {
      return serverMessage;
    }
    if (existing.streaming) {
      return existing;
    }
    return {
      ...serverMessage,
      toolCalls: existing.toolCalls ?? serverMessage.toolCalls,
    };
  });

  for (const message of local) {
    if (!serverIds.has(message.id)) {
      merged.push(message);
    }
  }

  return merged;
}

// 判断两组消息是否等价（避免轮询无变化时触发无谓 re-render）。
function sameMessages(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right || left.id !== right.id || left.text !== right.text) {
      return false;
    }
  }
  return true;
}

// SSE 事件形态：与后端 chat 路由的 writeSseEvent 一一对应。
type ChatStreamEvent =
  | { type: "start"; id: string; sessionId: string; session?: ServerSession }
  | { type: "delta"; text: string }
  | {
      type: "tool-start";
      id: string;
      name: string;
      source?: string;
      riskLevel?: "read" | "write" | "dangerous";
      requiresApproval?: boolean;
      input?: unknown;
    }
  | {
      type: "tool-result";
      id: string;
      name: string;
      status: "succeeded" | "failed";
      output?: unknown;
      error?: string;
    }
  | {
      type: "approval-request";
      approvalId: string;
      eventId: string;
      toolName: string;
      riskLevel: "read" | "write" | "dangerous";
      workspaceId?: string;
      workspaceName?: string;
      inputPreview: {
        path?: string;
        command?: string;
        cwd?: string;
        bytes?: number;
        patchPreview?: string;
        contentPreview?: string;
      };
      expiresAt: string;
    }
  | {
      type: "approval-resolved";
      approvalId: string;
      eventId: string;
      decision: "approved" | "rejected";
      decidedBy?: string;
    }
  | {
      type: "done";
      id: string;
      sessionId: string;
      parts?: Array<{ type: string; text?: string }>;
      session?: ServerSession;
    }
  | { type: "error"; error?: string; message?: string };

// 读取 text/event-stream，按 `data: <json>` 逐条解析并回调，供打字机渲染使用。
async function consumeChatStream(
  response: Response,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("当前环境不支持流式响应");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (chunk: string) => {
    const dataLines = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    if (!dataLines.length) {
      return;
    }

    const payload = dataLines.join("");
    if (!payload) {
      return;
    }

    try {
      onEvent(JSON.parse(payload) as ChatStreamEvent);
    } catch {
      // 忽略无法解析的心跳/空块。
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      flush(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim()) {
    flush(buffer);
  }
}

// 认证门：无有效登录态时展示 LoginScreen，否则进入聊天界面。
export function App() {
  const [authState, setAuthState] = useState<"checking" | "in" | "out">(
    "checking",
  );
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 启动检查超时兜底：真机若 serverUrl 仍是默认 127.0.0.1，/api/auth/me 会
    // 打向手机自身并长时间挂起（fetch 无超时），导致永远停在“正在检查登录状态…”。
    // 超时即视为未登录，落到登录页，让用户先填局域网服务端地址再登录。
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setAuthState("out");
      }
    }, 3500);
    void fetchMe()
      .then((me) => {
        if (cancelled) {
          return;
        }
        clearTimeout(timeout);
        if (me) {
          setUser(me);
          setAuthState("in");
        } else {
          setAuthState("out");
        }
      })
      .catch(() => {
        if (!cancelled) {
          clearTimeout(timeout);
          setAuthState("out");
        }
      });
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, []);

  if (authState === "checking") {
    return (
      <main className="login-screen">
        <div className="login-qr-placeholder">正在检查登录状态…</div>
      </main>
    );
  }

  if (authState === "out" || !user) {
    return (
      <LoginScreen
        onAuthenticated={(_token, me) => {
          setUser(me);
          setAuthState("in");
        }}
      />
    );
  }

  return (
    <ChatApp
      user={user}
      onLogout={async () => {
        await logout();
        setUser(null);
        setAuthState("out");
      }}
    />
  );
}

function ChatApp({
  user,
  onLogout,
}: {
  user: AuthUser;
  onLogout: () => void | Promise<void>;
}) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [input, setInput] = useState("");
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isRefreshingSessions, setIsRefreshingSessions] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelSelection | null>(
    null,
  );
  const [notice, setNotice] = useState<string>("");
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const [pendingDeleteSession, setPendingDeleteSession] =
    useState<Session | null>(null);
  // 移动端抽屉：会话列表、远程设备两个面板。
  const [drawer, setDrawer] = useState<"none" | "sessions" | "remote">("none");
  // 联网检索开关：用户在 composer 点击 Search 时切换，仅对本客户端生效。
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  // 顶栏右侧「⋯」下拉菜单开合。
  const [menuOpen, setMenuOpen] = useState(false);
  // 正在重命名的会话（null 表示未打开重命名弹窗）。
  const [renameTarget, setRenameTarget] = useState<Session | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
    null,
  );
  // 当前待审批的本地工具调用（来自 SSE approval-request）。null 表示无弹窗。
  const [approvalPrompt, setApprovalPrompt] = useState<ApprovalPrompt | null>(
    null,
  );
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const composerComposingRef = useRef(false);
  const composerCompositionEndedAtRef = useRef(0);
  // 稳定的客户端标识：事件流去重与上报当前会话用。
  const clientIdRef = useRef<string>(loadClientId());
  const clientId = clientIdRef.current;
  // 事件流是否已连通：连通时降级兜底轮询频率。
  const [eventsConnected, setEventsConnected] = useState(false);

  // 远程桌面设备（借用工具）。仅在打开远程抽屉时按需拉取。
  const remote = useRemoteDevices(drawer === "remote");

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setIsBootstrapping(true);
      setNotice("");

      try {
        const loadedModels = await fetchModels();
        const nextModel = loadedModels[0] ?? null;
        const loadedSessions = await fetchSessions(nextModel);
        let nextSessions = loadedSessions.length
          ? loadedSessions
          : nextModel
            ? [createDraftSession(nextModel)]
            : [];

        if (nextSessions[0] && !nextSessions[0].messagesLoaded) {
          const loadedMessages = await fetchSessionMessages(nextSessions[0].id);
          nextSessions = nextSessions.map((session) =>
            session.id === nextSessions[0]?.id
              ? sessionFromServer(
                  loadedMessages.session,
                  nextModel,
                  loadedMessages.messages,
                  true,
                )
              : session,
          );
        }

        if (cancelled) {
          return;
        }

        setModels(loadedModels);
        setSelectedModel(nextSessions[0]?.model ?? nextModel);
        setSessions(nextSessions);
        setActiveSessionId(nextSessions[0]?.id ?? "");

        if (!loadedModels.length) {
          setNotice("后端未返回可用模型，请先确认当前账号的模型授权。");
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        setNotice(error instanceof Error ? error.message : "初始化失败");
        setModels([]);
        setSessions([]);
        setSelectedModel(null);
        setActiveSessionId("");
      } finally {
        if (!cancelled) {
          setIsBootstrapping(false);
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  const activeSession = useMemo(
    () =>
      sessions.find((session) => session.id === activeSessionId) ??
      sessions[0] ??
      null,
    [activeSessionId, sessions],
  );

  const messages = activeSession?.messages ?? [];

  const lastMessage = messages[messages.length - 1];
  useEffect(() => {
    const node = conversationRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages.length, lastMessage?.text, activeSessionId]);

  // 跨端同步兜底轮询：事件流连通时降到 20s（防丢事件），未连通时 2s 近实时。
  // 发送/流式期间暂停，草稿会话无需轮询。
  const activeSessionIsDraft = activeSession?.isDraft ?? true;
  useEffect(() => {
    if (isSending || activeSessionIsDraft || !activeSessionId) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const intervalMs = eventsConnected ? 20_000 : 2000;

    const poll = async () => {
      try {
        const loaded = await fetchSessionMessages(activeSessionId);
        if (cancelled) {
          return;
        }
        setSessions((current) =>
          current.map((session) => {
            if (session.id !== activeSessionId) {
              return session;
            }
            const merged = mergeServerMessages(
              session.messages,
              loaded.messages,
            );
            if (sameMessages(session.messages, merged)) {
              return session;
            }
            return { ...session, messages: merged, messagesLoaded: true };
          }),
        );
      } catch {
        // 轮询失败静默重试。
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void poll(), intervalMs);
        }
      }
    };

    timer = setTimeout(() => void poll(), intervalMs);

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [activeSessionId, activeSessionIsDraft, isSending, eventsConnected]);

  // 实时事件流：订阅 /api/events，接收对方端（桌面/手机）在同一 session 的消息推送。
  // 用 fetch + ReadableStream（原生 EventSource 不支持自定义 Authorization 头）。
  useEffect(() => {
    let cancelled = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const applyEvent = (event: {
      type?: string;
      sessionId?: string;
      message?: Message;
      session?: {
        id: string;
        title?: string;
        updatedAt?: string;
        lastMessagePreview?: string;
      };
      originClientId?: string;
    }) => {
      if (event.originClientId && event.originClientId === clientId) {
        return; // 自己发的，已在本地渲染。
      }
      if (event.type === "message.created" && event.sessionId && event.message) {
        const incoming = event.message;
        const sessionId = event.sessionId;
        setSessions((current) =>
          current.map((session) => {
            if (session.id !== sessionId) {
              return session;
            }
            const merged = mergeServerMessages(session.messages, [incoming]);
            if (sameMessages(session.messages, merged)) {
              return session;
            }
            return {
              ...session,
              messages: merged,
              messagesLoaded: true,
              preview: incoming.text || session.preview,
              updatedAt: "Now",
            };
          }),
        );
      } else if (event.type === "session.updated" && event.session) {
        const updated = event.session;
        setSessions((current) =>
          current.map((session) =>
            session.id === updated.id
              ? {
                  ...session,
                  title: updated.title ?? session.title,
                  updatedAt: updated.updatedAt
                    ? formatTime(updated.updatedAt)
                    : session.updatedAt,
                  preview: updated.lastMessagePreview ?? session.preview,
                }
              : session,
          ),
        );
      }
    };

    const connect = async () => {
      try {
        const response = await fetch(eventsUrl(clientId), {
          headers: authHeaders(),
        });
        if (!response.ok || !response.body) {
          throw new Error(`events ${response.status}`);
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        if (!cancelled) {
          setEventsConnected(true);
          retry = 0;
        }
        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
            const dataLine = chunk
              .split("\n")
              .find((line) => line.startsWith("data:"));
            if (!dataLine) {
              continue;
            }
            try {
              applyEvent(JSON.parse(dataLine.slice(5).trim()));
            } catch {
              // 忽略 hello/心跳等非 JSON 或无关负载。
            }
          }
        }
      } catch {
        // 连接失败走重连。
      } finally {
        if (!cancelled) {
          setEventsConnected(false);
          retry = Math.min(retry + 1, 4);
          const delay = [1000, 2000, 5000, 10_000, 10_000][retry] ?? 10_000;
          retryTimer = setTimeout(() => void connect(), delay);
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      void reader?.cancel().catch(() => {});
    };
  }, [clientId]);

  // 上报"当前打开的会话页"：仅当对端也在看同一 session 时服务端才推送该会话消息。
  // 切换会话 / 落到草稿 / 卸载都会重新上报。
  useEffect(() => {
    const sessionId = activeSessionIsDraft ? null : activeSessionId || null;
    void postActiveSession(clientId, sessionId);
    return () => {
      // 组件卸载（登出等）时上报离开会话页。
      void postActiveSession(clientId, null);
    };
  }, [clientId, activeSessionId, activeSessionIsDraft]);


  const persistedSessions = useMemo(
    () => sessions.filter((session) => !session.isDraft),
    [sessions],
  );

  function mergeRefreshedSessions(
    current: Session[],
    refreshedSessions: Session[],
  ): Session[] {
    const drafts = current.filter((session) => session.isDraft);
    const refreshed = refreshedSessions.map((refreshedSession) => {
      const existing = current.find((item) => item.id === refreshedSession.id);
      return existing
        ? {
            ...refreshedSession,
            messages: existing.messages,
            messagesLoaded: existing.messagesLoaded,
          }
        : refreshedSession;
    });

    return [...drafts, ...refreshed];
  }

  async function refreshSessionList() {
    if (isRefreshingSessions || isBootstrapping) {
      return;
    }

    setIsRefreshingSessions(true);
    setNotice("");

    try {
      const refreshedSessions = await fetchSessions(selectedModel);
      setSessions((current) => {
        const next = mergeRefreshedSessions(current, refreshedSessions);
        setActiveSessionId((currentActiveId) =>
          next.some((session) => session.id === currentActiveId)
            ? currentActiveId
            : (next.find((session) => !session.isDraft)?.id ??
              next[0]?.id ??
              ""),
        );
        return next;
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "刷新会话列表失败");
    } finally {
      setIsRefreshingSessions(false);
    }
  }

  function startNewSession() {
    if (!selectedModel) {
      setNotice("没有可用模型，无法创建新会话。");
      return;
    }

    setNotice("");
    setInput("");
    setDrawer("none");

    if (activeSession?.isDraft && activeSession.messages.length === 0) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }

    const nextSession = createDraftSession(selectedModel);
    setSessions((current) => [
      nextSession,
      ...current.filter(
        (session) => !session.isDraft || session.messages.length > 0,
      ),
    ]);
    setActiveSessionId(nextSession.id);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function switchSession(session: Session) {
    setActiveSessionId(session.id);
    setSelectedModel(session.model ?? models[0] ?? null);
    setInput("");
    setDrawer("none");

    if (!session.messagesLoaded) {
      void fetchSessionMessages(session.id)
        .then((result) => {
          setSessions((current) =>
            current.map((item) =>
              item.id === session.id
                ? sessionFromServer(
                    result.session,
                    session.model,
                    result.messages,
                    true,
                  )
                : item,
            ),
          );
        })
        .catch((error: unknown) => {
          setNotice(
            error instanceof Error ? error.message : "加载消息历史失败",
          );
        });
    }
  }

  function removeSessionFromState(sessionId: string) {
    setSessions((current) => {
      const next = current.filter((session) => session.id !== sessionId);
      setActiveSessionId((currentActiveId) =>
        currentActiveId === sessionId
          ? (next.find((session) => !session.isDraft)?.id ?? next[0]?.id ?? "")
          : currentActiveId,
      );
      return next;
    });
  }

  function requestDeleteSession(session: Session) {
    if (deletingSessionId) {
      return;
    }
    if (session.isDraft) {
      removeSessionFromState(session.id);
      return;
    }
    setPendingDeleteSession(session);
  }

  async function confirmDeleteSession() {
    const session = pendingDeleteSession;
    if (!session) {
      return;
    }

    setPendingDeleteSession(null);
    setDeletingSessionId(session.id);
    setNotice("");

    try {
      await deleteSessionRequest(session.id);
      removeSessionFromState(session.id);
      const refreshedSessions = await fetchSessions(selectedModel);
      setSessions((current) =>
        refreshedSessions.map((refreshed) => {
          const existing = current.find((item) => item.id === refreshed.id);
          return existing
            ? {
                ...refreshed,
                messages: existing.messages,
                messagesLoaded: existing.messagesLoaded,
              }
            : refreshed;
        }),
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除会话失败");
    } finally {
      setDeletingSessionId(null);
    }
  }

  // 打开当前会话的重命名弹窗（草稿会话也可改本地标题）。
  function openRenameDialog() {
    setMenuOpen(false);
    if (!activeSession) {
      return;
    }
    setRenameTarget(activeSession);
    setRenameDraft(activeSession.title);
  }

  async function confirmRenameSession() {
    const session = renameTarget;
    if (!session) {
      return;
    }
    const title = renameDraft.replace(/\s+/g, " ").trim();
    if (!title) {
      setNotice("会话标题不能为空。");
      return;
    }
    if (title === session.title) {
      setRenameTarget(null);
      return;
    }

    setRenamingSessionId(session.id);
    setNotice("");
    try {
      if (session.isDraft) {
        setSessions((current) =>
          current.map((item) =>
            item.id === session.id ? { ...item, title } : item,
          ),
        );
      } else {
        const renamed = await renameSessionRequest(session.id, title);
        setSessions((current) =>
          current.map((item) =>
            item.id === session.id
              ? {
                  ...item,
                  title: renamed.title,
                  updatedAt: formatTime(renamed.updatedAt),
                }
              : item,
          ),
        );
      }
      setRenameTarget(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重命名会话失败");
    } finally {
      setRenamingSessionId(null);
    }
  }

  function updateActiveModel(modelKeyValue: string) {
    const nextModel = models.find((model) => modelKey(model) === modelKeyValue);
    if (!nextModel) {
      return;
    }

    setSelectedModel(nextModel);
    setSessions((current) =>
      current.map((session) =>
        session.id === activeSession?.id
          ? { ...session, model: nextModel }
          : session,
      ),
    );
  }

  function appendMessage(
    sessionId: string,
    message: Message,
    titleWhenEmpty?: string,
  ) {
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              title:
                titleWhenEmpty && session.messages.length === 0
                  ? titleWhenEmpty
                  : session.title,
              messages: [...session.messages, message],
              messagesLoaded: true,
              preview: message.text,
              updatedAt: "Now",
            }
          : session,
      ),
    );
  }

  function updateMessage(
    sessionId: string,
    messageId: string,
    updater: (message: Message) => Message,
  ) {
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              messages: session.messages.map((message) =>
                message.id === messageId ? updater(message) : message,
              ),
            }
          : session,
      ),
    );
  }

  async function sendCurrentMessage() {
    const text = input.trim();
    if (!text || isSending) {
      return;
    }
    if (!selectedModel) {
      setNotice("没有可用模型，无法发送消息。");
      return;
    }

    setInput("");
    setIsSending(true);
    setNotice("");

    try {
      let targetSession = activeSession;

      if (!targetSession) {
        const draft = createDraftSession(selectedModel);
        targetSession = draft;
        setSessions((current) => [draft, ...current]);
        setActiveSessionId(draft.id);
      }

      const targetSessionId = targetSession.id;
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        text,
      };

      appendMessage(targetSessionId, userMessage, titleFromPrompt(text));

      const remoteSelection = remote.selection;

      const response = await fetch(`${resolveServerUrl()}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          sessionId: targetSessionId,
          clientId,
          model: selectedModel,
          client: buildClientContext(remoteSelection),
          // 选择了远程桌面设备时借用其工具；否则为纯云端对话。
          localTools: remoteSelection
            ? {
                deviceId: remoteSelection.deviceId,
                workspaceId: remoteSelection.workspaceId,
              }
            : undefined,
          // 用户开启 WebSearch 开关时请求联网检索。
          webSearch: webSearchEnabled,
          message: {
            id: userMessage.id,
            role: "user",
            parts: [{ type: "text", text }],
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }

      let assistantMessageId: string = crypto.randomUUID();
      let assistantInserted = false;
      let streamError: string | null = null;

      const ensureAssistantMessage = () => {
        if (!assistantInserted) {
          appendMessage(targetSessionId, {
            id: assistantMessageId,
            role: "assistant",
            text: "",
            streaming: true,
          });
          assistantInserted = true;
        }
      };

      const syncPersistedSession = (persistedSession?: ServerSession) => {
        if (!persistedSession) {
          return;
        }
        setSessions((current) =>
          current.map((session) =>
            session.id === targetSessionId
              ? {
                  ...session,
                  isDraft: false,
                  title: persistedSession.title ?? session.title,
                  updatedAt: persistedSession.updatedAt
                    ? formatTime(persistedSession.updatedAt)
                    : session.updatedAt,
                  preview:
                    persistedSession.lastMessagePreview ?? session.preview,
                }
              : session,
          ),
        );
      };

      await consumeChatStream(response, (event) => {
        switch (event.type) {
          case "start": {
            assistantMessageId = event.id ?? assistantMessageId;
            ensureAssistantMessage();
            syncPersistedSession(event.session);
            break;
          }
          case "delta": {
            ensureAssistantMessage();
            updateMessage(targetSessionId, assistantMessageId, (message) => ({
              ...message,
              text: message.text + event.text,
            }));
            break;
          }
          case "tool-start": {
            ensureAssistantMessage();
            updateMessage(targetSessionId, assistantMessageId, (message) => ({
              ...message,
              toolCalls: [
                ...(message.toolCalls ?? []).filter(
                  (toolCall) => toolCall.id !== event.id,
                ),
                {
                  id: event.id,
                  name: event.name,
                  source: event.source,
                  riskLevel: event.riskLevel,
                  requiresApproval: event.requiresApproval,
                  status: "running",
                  input: event.input,
                },
              ],
            }));
            break;
          }
          case "tool-result": {
            ensureAssistantMessage();
            updateMessage(targetSessionId, assistantMessageId, (message) => ({
              ...message,
              toolCalls: (message.toolCalls ?? []).map((toolCall) =>
                toolCall.id === event.id
                  ? {
                      ...toolCall,
                      status: event.status,
                      output: event.output,
                      error: event.error,
                    }
                  : toolCall,
              ),
            }));
            break;
          }
          case "approval-request": {
            // 收到审批请求：把工具卡片标记为等待审批，并弹出审批弹窗。
            ensureAssistantMessage();
            updateMessage(targetSessionId, assistantMessageId, (message) => ({
              ...message,
              toolCalls: (message.toolCalls ?? []).map((toolCall) =>
                toolCall.id === event.eventId
                  ? { ...toolCall, status: "awaiting-approval" }
                  : toolCall,
              ),
            }));
            setApprovalPrompt({
              approvalId: event.approvalId,
              eventId: event.eventId,
              toolName: event.toolName,
              riskLevel: event.riskLevel,
              workspaceName: event.workspaceName,
              inputPreview: event.inputPreview,
              expiresAt: event.expiresAt,
            });
            break;
          }
          case "approval-resolved": {
            // 审批已定：关闭弹窗（若匹配），并收敛工具卡片状态。
            setApprovalPrompt((current) =>
              current && current.approvalId === event.approvalId
                ? null
                : current,
            );
            updateMessage(targetSessionId, assistantMessageId, (message) => ({
              ...message,
              toolCalls: (message.toolCalls ?? []).map((toolCall) =>
                toolCall.id === event.eventId &&
                toolCall.status === "awaiting-approval"
                  ? {
                      ...toolCall,
                      status: event.decision === "approved" ? "running" : "failed",
                      error:
                        event.decision === "approved"
                          ? toolCall.error
                          : `审批未通过（${event.decidedBy ?? "rejected"}）`,
                    }
                  : toolCall,
              ),
            }));
            break;
          }
          case "done": {
            ensureAssistantMessage();
            const finalText = event.parts?.find(
              (part) => part.type === "text",
            )?.text;
            updateMessage(targetSessionId, assistantMessageId, (message) => ({
              ...message,
              text: finalText ?? message.text,
              streaming: false,
            }));
            syncPersistedSession(event.session);
            break;
          }
          case "error": {
            streamError = event.message ?? event.error ?? "发送失败";
            break;
          }
          default:
            break;
        }
      });

      if (streamError) {
        if (assistantInserted) {
          updateMessage(targetSessionId, assistantMessageId, (message) => ({
            ...message,
            text: message.text || "（生成失败）",
            streaming: false,
          }));
        }
        // 流结束仍挂着审批弹窗则关闭（避免悬挂）。
        setApprovalPrompt(null);
        throw new Error(streamError);
      }

      if (assistantInserted) {
        updateMessage(targetSessionId, assistantMessageId, (message) =>
          message.streaming ? { ...message, streaming: false } : message,
        );
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "发送失败");
    } finally {
      setIsSending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendCurrentMessage();
  }

  function isComposerComposing(
    event?: KeyboardEvent<HTMLTextAreaElement>,
  ): boolean {
    return (
      composerComposingRef.current ||
      Boolean(event?.nativeEvent.isComposing) ||
      Date.now() - composerCompositionEndedAtRef.current < 150
    );
  }

  function handleComposerCompositionStart() {
    composerComposingRef.current = true;
  }

  function handleComposerCompositionEnd() {
    composerComposingRef.current = false;
    composerCompositionEndedAtRef.current = Date.now();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || isComposerComposing(event)) {
      return;
    }
    event.preventDefault();
    void sendCurrentMessage();
  }

  // 提交审批决策：乐观关闭弹窗，服务端 approval-resolved 会再收敛工具卡片状态。
  async function submitApproval(decision: "approved" | "rejected") {
    const prompt = approvalPrompt;
    if (!prompt || approvalSubmitting) {
      return;
    }
    setApprovalSubmitting(true);
    try {
      await postApprovalDecision(prompt.approvalId, decision);
      setApprovalPrompt(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "提交审批失败");
    } finally {
      setApprovalSubmitting(false);
    }
  }

  const isCommandApproval =
    approvalPrompt?.toolName === "workspace.run_command";
  const approvalTitle = approvalPrompt
    ? isCommandApproval
      ? "允许 Muse 执行此命令？"
      : `允许 Muse 执行 ${approvalPrompt.toolName}？`
    : "";

  const remoteLabel = remote.selection
    ? `${remote.selection.deviceName} · ${remote.selection.workspaceName}`
    : "未连接桌面";

  return (
    <main className="m-app">
      <header className="m-topbar">
        <button
          className="m-icon-button"
          onClick={() => setDrawer("sessions")}
          title="会话列表"
          type="button"
        >
          <MessageSquare aria-hidden="true" size={20} strokeWidth={2.1} />
          <span className="sr-only">会话列表</span>
        </button>

        <div className="m-topbar-title">
          <MuseMark size={20} spark={false} />
          <span>{activeSession?.title ?? "新对话"}</span>
        </div>

        <div className="m-topbar-right">
          <button
            className="m-icon-button"
            onClick={startNewSession}
            title="新对话"
            type="button"
          >
            <Plus aria-hidden="true" size={20} strokeWidth={2.2} />
            <span className="sr-only">新对话</span>
          </button>

          <div className="m-menu-wrap">
            <button
              className={`m-icon-button ${menuOpen ? "active" : ""}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((value) => !value)}
              title="更多"
              type="button"
            >
              <MoreHorizontal aria-hidden="true" size={20} strokeWidth={2.1} />
              <span className="sr-only">更多</span>
            </button>

            {menuOpen ? (
              <>
                <div
                  className="m-menu-backdrop"
                  onClick={() => setMenuOpen(false)}
                  role="presentation"
                />
                <div className="m-menu" role="menu">
                  <button
                    className="m-menu-item"
                    onClick={openRenameDialog}
                    role="menuitem"
                    type="button"
                  >
                    <Pencil aria-hidden="true" size={16} strokeWidth={2.1} />
                    <span>重命名</span>
                  </button>
                  <button
                    className="m-menu-item danger"
                    onClick={() => {
                      setMenuOpen(false);
                      if (activeSession) {
                        requestDeleteSession(activeSession);
                      }
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={16} strokeWidth={2.1} />
                    <span>删除</span>
                  </button>
                  <button
                    className={`m-menu-item ${remote.selection ? "active" : ""}`}
                    onClick={() => {
                      setMenuOpen(false);
                      setDrawer("remote");
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <MonitorSmartphone
                      aria-hidden="true"
                      size={16}
                      strokeWidth={2.1}
                    />
                    <span>{remote.selection ? "桌面已连接" : "连接桌面端"}</span>
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <section className="m-canvas" aria-label="Chat">
        {notice ? (
          <div className="app-notice" role="status">
            <AlertCircle aria-hidden="true" size={16} strokeWidth={2.1} />
            <span>{notice}</span>
            <button
              aria-label="Dismiss notice"
              onClick={() => setNotice("")}
              type="button"
            >
              <X aria-hidden="true" size={15} strokeWidth={2.1} />
            </button>
          </div>
        ) : null}

        <div className="m-conversation" ref={conversationRef}>
          {isBootstrapping ? (
            <div className="m-loading">
              <Loader2 aria-hidden="true" className="spin" size={18} />
              <span>正在加载…</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">
                <Sparkles aria-hidden="true" size={22} strokeWidth={2.1} />
              </span>
              <h2>开始一个新的 AI Chat</h2>
              <p>选择模型，输入问题，当前会话的上下文会持续保留。</p>
            </div>
          ) : (
            <div className="message-list" aria-live="polite">
              {messages.map((message) => (
                <article
                  className={`message-row message-row-${message.role}`}
                  key={message.id}
                >
                  <span className="message-avatar" aria-hidden="true">
                    {message.role === "assistant" ? (
                      <MuseMark size={30} spark={false} />
                    ) : (
                      <UserAvatar user={user} className="message-avatar-img" />
                    )}
                  </span>
                  <div className={`message message-${message.role}`}>
                    <MessageText message={message} />
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <div className="m-dock">
          <form className="m-composer" onSubmit={handleSubmit}>
            <textarea
              aria-label="Message"
              onCompositionEnd={handleComposerCompositionEnd}
              onCompositionStart={handleComposerCompositionStart}
              onKeyDown={handleComposerKeyDown}
              onChange={(event) => setInput(event.target.value)}
              disabled={!selectedModel || isBootstrapping}
              placeholder="发消息给 Muse…"
              ref={inputRef}
              rows={2}
              value={input}
            />

            <div className="m-composer-footer">
              <button
                className={`m-chip ${webSearchEnabled ? "active" : ""}`}
                aria-pressed={webSearchEnabled}
                onClick={() => setWebSearchEnabled((value) => !value)}
                title={webSearchEnabled ? "联网检索已开启" : "开启联网检索"}
                type="button"
              >
                <Globe2 aria-hidden="true" size={16} strokeWidth={2.1} />
                <span>联网</span>
              </button>

              <label className="m-model-select">
                <Sparkles aria-hidden="true" size={15} strokeWidth={2.2} />
                <select
                  aria-label="Model"
                  disabled={isBootstrapping || !models.length}
                  onChange={(event) => updateActiveModel(event.target.value)}
                  value={selectedModel ? modelKey(selectedModel) : ""}
                >
                  {models.length ? null : (
                    <option value="">
                      {isBootstrapping ? "加载模型中" : "无可用模型"}
                    </option>
                  )}
                  {models.map((model) => (
                    <option key={modelKey(model)} value={modelKey(model)}>
                      {modelLabel(model)}
                    </option>
                  ))}
                </select>
              </label>

              <button
                className="send-button"
                disabled={
                  isSending ||
                  !input.trim() ||
                  !selectedModel ||
                  isBootstrapping
                }
                type="submit"
              >
                {isSending ? (
                  <Loader2 aria-hidden="true" className="spin" size={20} />
                ) : (
                  <SendHorizontal
                    aria-hidden="true"
                    size={20}
                    strokeWidth={2}
                  />
                )}
                <span className="sr-only">发送</span>
              </button>
            </div>
          </form>
        </div>
      </section>

      {drawer !== "none" ? (
        <div
          className="m-drawer-backdrop"
          onClick={() => setDrawer("none")}
          role="presentation"
        >
          <aside
            className="m-drawer"
            onClick={(event) => event.stopPropagation()}
          >
            {drawer === "sessions" ? (
              <SessionsDrawer
                user={user}
                sessions={persistedSessions}
                activeSessionId={activeSession?.id ?? ""}
                isRefreshing={isRefreshingSessions}
                deletingSessionId={deletingSessionId}
                onClose={() => setDrawer("none")}
                onRefresh={() => void refreshSessionList()}
                onSwitch={switchSession}
                onDelete={requestDeleteSession}
                onLogout={onLogout}
              />
            ) : (
              <RemoteDrawer
                remoteLabel={remoteLabel}
                devices={remote.devices}
                loading={remote.loading}
                error={remote.error}
                selection={remote.selection}
                onClose={() => setDrawer("none")}
                onRefresh={() => void remote.refresh()}
                onSelect={(next) => {
                  remote.select(next);
                  setDrawer("none");
                }}
              />
            )}
          </aside>
        </div>
      ) : null}

      {pendingDeleteSession ? (
        <div
          aria-labelledby="delete-session-title"
          aria-modal="true"
          className="approval-backdrop"
          role="dialog"
        >
          <section className="approval-dialog">
            <div className="approval-header">
              <div>
                <span>删除会话</span>
                <h2 id="delete-session-title">{pendingDeleteSession.title}</h2>
              </div>
              <Trash2 aria-hidden="true" size={22} strokeWidth={2.1} />
            </div>
            <p className="approval-message">
              删除后该会话将从历史列表移除，此操作不可撤销。
            </p>
            <div className="approval-actions">
              <button
                className="approval-button secondary"
                onClick={() => setPendingDeleteSession(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="approval-button danger"
                onClick={() => void confirmDeleteSession()}
                type="button"
              >
                删除
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {renameTarget ? (
        <div
          aria-labelledby="rename-session-title"
          aria-modal="true"
          className="approval-backdrop"
          role="dialog"
        >
          <section className="approval-dialog">
            <div className="approval-header">
              <div>
                <span>重命名会话</span>
                <h2 id="rename-session-title">{renameTarget.title}</h2>
              </div>
              <Pencil aria-hidden="true" size={22} strokeWidth={2.1} />
            </div>
            <input
              className="m-rename-input"
              aria-label="会话标题"
              autoFocus
              disabled={renamingSessionId === renameTarget.id}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void confirmRenameSession();
                }
              }}
              placeholder="输入会话标题"
              value={renameDraft}
            />
            <div className="approval-actions">
              <button
                className="approval-button secondary"
                onClick={() => setRenameTarget(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="approval-button primary"
                disabled={renamingSessionId === renameTarget.id}
                onClick={() => void confirmRenameSession()}
                type="button"
              >
                保存
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {approvalPrompt ? (
        <div
          aria-labelledby="approval-title"
          aria-modal="true"
          className="approval-backdrop"
          role="dialog"
        >
          <section className="approval-dialog">
            <div className="approval-header">
              <div>
                <span className={`approval-risk ${approvalPrompt.riskLevel}`}>
                  {approvalPrompt.riskLevel}
                </span>
                <h2 id="approval-title">{approvalTitle}</h2>
              </div>
              {isCommandApproval ? (
                <Terminal aria-hidden="true" size={22} strokeWidth={2.1} />
              ) : (
                <AlertCircle aria-hidden="true" size={22} strokeWidth={2.1} />
              )}
            </div>

            <p className="approval-message">
              该操作将在桌面端「{approvalPrompt.workspaceName ?? "工作区"}
              」执行，确认后由桌面执行并回传结果。
            </p>

            <dl className="approval-details">
              {approvalPrompt.inputPreview.command ? (
                <div>
                  <dt>命令</dt>
                  <dd>
                    <pre>{approvalPrompt.inputPreview.command}</pre>
                  </dd>
                </div>
              ) : null}
              {approvalPrompt.inputPreview.cwd ? (
                <div>
                  <dt>工作目录</dt>
                  <dd>{approvalPrompt.inputPreview.cwd}</dd>
                </div>
              ) : null}
              {approvalPrompt.inputPreview.path ? (
                <div>
                  <dt>路径</dt>
                  <dd>{approvalPrompt.inputPreview.path}</dd>
                </div>
              ) : null}
              {typeof approvalPrompt.inputPreview.bytes === "number" ? (
                <div>
                  <dt>字节</dt>
                  <dd>{approvalPrompt.inputPreview.bytes}</dd>
                </div>
              ) : null}
              {approvalPrompt.inputPreview.contentPreview ? (
                <div>
                  <dt>内容预览</dt>
                  <dd>
                    <pre>{approvalPrompt.inputPreview.contentPreview}</pre>
                  </dd>
                </div>
              ) : null}
              {approvalPrompt.inputPreview.patchPreview ? (
                <div>
                  <dt>补丁预览</dt>
                  <dd>
                    <pre>{approvalPrompt.inputPreview.patchPreview}</pre>
                  </dd>
                </div>
              ) : null}
            </dl>

            <div className="approval-actions">
              <button
                className="approval-button secondary"
                disabled={approvalSubmitting}
                onClick={() => void submitApproval("rejected")}
                type="button"
              >
                {isCommandApproval ? "不运行" : "拒绝"}
              </button>
              <button
                className="approval-button primary"
                disabled={approvalSubmitting}
                onClick={() => void submitApproval("approved")}
                type="button"
              >
                {isCommandApproval ? "运行命令" : "允许"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function SessionsDrawer({
  user,
  sessions,
  activeSessionId,
  isRefreshing,
  deletingSessionId,
  onClose,
  onRefresh,
  onSwitch,
  onDelete,
  onLogout,
}: {
  user: AuthUser;
  sessions: Session[];
  activeSessionId: string;
  isRefreshing: boolean;
  deletingSessionId: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSwitch: (session: Session) => void;
  onDelete: (session: Session) => void;
  onLogout: () => void | Promise<void>;
}) {
  return (
    <>
      <div className="m-drawer-head">
        <MuseWordmark size={30} />
        <button
          className="m-icon-button"
          onClick={onClose}
          title="关闭"
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={20} strokeWidth={2.1} />
          <span className="sr-only">关闭</span>
        </button>
      </div>

      <div className="m-drawer-account">
        <UserAvatar user={user} />
        <span className="account-name">{user.displayName ?? "Muse 用户"}</span>
        <button
          className="account-logout"
          onClick={() => void onLogout()}
          title="退出登录"
          type="button"
        >
          <LogOut aria-hidden="true" size={16} strokeWidth={2.1} />
          <span className="sr-only">退出登录</span>
        </button>
      </div>

      <div className="m-drawer-section-head">
        <span>会话</span>
        <button
          disabled={isRefreshing}
          onClick={onRefresh}
          title="刷新会话列表"
          type="button"
        >
          <RefreshCw
            aria-hidden="true"
            className={isRefreshing ? "spin" : undefined}
            size={15}
            strokeWidth={2.1}
          />
          <span className="sr-only">刷新会话列表</span>
        </button>
      </div>

      <nav className="m-session-list" aria-label="History">
        {sessions.length === 0 ? (
          <div className="history-state">还没有会话</div>
        ) : null}
        {sessions.map((session) => (
          <div
            className={`m-session-card ${
              session.id === activeSessionId ? "active" : ""
            }`}
            key={session.id}
          >
            <button
              className="m-session-open"
              onClick={() => onSwitch(session)}
              type="button"
            >
              <span className="m-session-title">{session.title}</span>
              <span className="m-session-preview">{session.preview}</span>
              <span className="m-session-meta">
                {session.updatedAt} · {modelLabel(session.model)}
              </span>
            </button>
            <button
              className="session-delete"
              disabled={deletingSessionId === session.id}
              onClick={() => onDelete(session)}
              title="删除会话"
              type="button"
            >
              {deletingSessionId === session.id ? (
                <Loader2 aria-hidden="true" className="spin" size={15} />
              ) : (
                <Trash2 aria-hidden="true" size={15} strokeWidth={2.1} />
              )}
              <span className="sr-only">删除会话</span>
            </button>
          </div>
        ))}
      </nav>
    </>
  );
}

function RemoteDrawer({
  remoteLabel,
  devices,
  loading,
  error,
  selection,
  onClose,
  onRefresh,
  onSelect,
}: {
  remoteLabel: string;
  devices: ReturnType<typeof useRemoteDevices>["devices"];
  loading: boolean;
  error: string;
  selection: RemoteSelection | null;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (selection: RemoteSelection | null) => void;
}) {
  return (
    <>
      <div className="m-drawer-head">
        <div className="m-drawer-head-title">
          <MonitorSmartphone aria-hidden="true" size={20} strokeWidth={2.1} />
          <span>连接桌面端</span>
        </div>
        <button
          className="m-icon-button"
          onClick={onClose}
          title="关闭"
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={20} strokeWidth={2.1} />
          <span className="sr-only">关闭</span>
        </button>
      </div>

      <p className="m-drawer-hint">
        选择一台在线的 Muse 桌面端及其工作区，AI
        的文件与命令类工具会在该桌面执行，写入和命令会在桌面弹出审批。
      </p>

      <div className="m-drawer-section-head">
        <span>当前：{remoteLabel}</span>
        <button
          disabled={loading}
          onClick={onRefresh}
          title="刷新设备"
          type="button"
        >
          <RefreshCw
            aria-hidden="true"
            className={loading ? "spin" : undefined}
            size={15}
            strokeWidth={2.1}
          />
          <span className="sr-only">刷新设备</span>
        </button>
      </div>

      {error ? <div className="history-state">{error}</div> : null}

      <nav className="m-remote-list" aria-label="Remote devices">
        <button
          className={`m-remote-item ${selection ? "" : "active"}`}
          onClick={() => onSelect(null)}
          type="button"
        >
          <span className="m-remote-name">纯云端对话</span>
          <span className="m-remote-sub">不借用任何桌面工具</span>
        </button>

        {!loading && devices.length === 0 ? (
          <div className="history-state">没有在线的桌面端</div>
        ) : null}

        {devices.map((device) =>
          device.workspaces.length ? (
            device.workspaces.map((workspace) => {
              const active =
                selection?.deviceId === device.deviceId &&
                selection?.workspaceId === workspace.workspaceId;
              return (
                <button
                  className={`m-remote-item ${active ? "active" : ""}`}
                  key={`${device.deviceId}:${workspace.workspaceId}`}
                  onClick={() =>
                    onSelect({
                      deviceId: device.deviceId,
                      workspaceId: workspace.workspaceId,
                      workspaceName: workspace.displayName,
                      deviceName: device.name,
                    })
                  }
                  type="button"
                >
                  <span className="m-remote-name">
                    {device.name}
                    {active ? (
                      <Check aria-hidden="true" size={15} strokeWidth={2.2} />
                    ) : null}
                  </span>
                  <span className="m-remote-sub">
                    {workspace.displayName} · {device.platform}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="m-remote-item disabled" key={device.deviceId}>
              <span className="m-remote-name">{device.name}</span>
              <span className="m-remote-sub">未挂载工作区</span>
            </div>
          ),
        )}
      </nav>
    </>
  );
}
