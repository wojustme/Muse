import {
  AlertCircle,
  Bot,
  ChevronDown,
  Clock3,
  Cpu,
  Globe2,
  History,
  Library,
  LayoutList,
  Loader2,
  LogOut,
  MessageSquare,
  Paperclip,
  PanelRight,
  Plus,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Sparkles,
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
import type { AuthUser } from "@muse/shared";
import { authHeaders, fetchMe, logout } from "./auth/client";
import { LoginScreen } from "./auth/LoginScreen";
import {
  LocalToolBridge,
  type LocalToolApprovalRequest,
  type LocalToolBridgeSnapshot,
  type WorkspaceBinding,
} from "./local-tools/bridge";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
  // 流式接收中：用于渲染打字机光标，接收完成后置为 false。
  streaming?: boolean;
};

type ModelSelection = {
  provider: string;
  name: string;
  displayName?: string;
};

type ModelOption = ModelSelection & {
  capabilities?: string[];
};

type ApprovalPrompt = LocalToolApprovalRequest & {
  resolve: (approved: boolean) => void;
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

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://127.0.0.1:8787";
const defaultWorkspace: WorkspaceBinding = {
  workspaceId: "downloads",
  displayName: "Downloads",
  rootPath: "/Users/bytedance/Downloads",
};

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
  const response = await fetch(`${serverUrl}/api/models`, {
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
  const response = await fetch(`${serverUrl}/api/sessions`, {
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

async function fetchSessionMessages(sessionId: string): Promise<{
  session: ServerSession;
  messages: Message[];
}> {
  const response = await fetch(
    `${serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
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

// SSE 事件形态：与后端 chat 路由的 writeSseEvent 一一对应。
type ChatStreamEvent =
  | { type: "start"; id: string; sessionId: string; session?: ServerSession }
  | { type: "delta"; text: string }
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
    // SSE 以空行分隔事件；每个事件可能有多行，取其中的 data: 负载拼接。
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
    void fetchMe()
      .then((me) => {
        if (cancelled) {
          return;
        }
        if (me) {
          setUser(me);
          setAuthState("in");
        } else {
          setAuthState("out");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAuthState("out");
        }
      });
    return () => {
      cancelled = true;
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
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState(sessions[0]?.id ?? "");
  const [selectedModel, setSelectedModel] = useState<ModelSelection | null>(
    null,
  );
  const [searchText, setSearchText] = useState("");
  const [notice, setNotice] = useState<string>("");
  const [localToolSnapshot, setLocalToolSnapshot] =
    useState<LocalToolBridgeSnapshot | null>(null);
  const [approvalPrompt, setApprovalPrompt] = useState<ApprovalPrompt | null>(
    null,
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const localToolBridgeRef = useRef<LocalToolBridge | null>(null);

  useEffect(() => {
    const bridge = new LocalToolBridge({
      serverUrl,
      workspace: defaultWorkspace,
      onStatus: setLocalToolSnapshot,
      onApproval: (request) =>
        new Promise<boolean>((resolve) => {
          setApprovalPrompt({
            ...request,
            resolve,
          });
        }),
    });
    localToolBridgeRef.current = bridge;
    setLocalToolSnapshot(bridge.snapshot());
    bridge.connect();

    return () => {
      bridge.disconnect();
      setApprovalPrompt((current) => {
        current?.resolve(false);
        return null;
      });
      if (localToolBridgeRef.current === bridge) {
        localToolBridgeRef.current = null;
      }
    };
  }, []);

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
    [activeSessionId, selectedModel, sessions],
  );

  const messages = activeSession?.messages ?? [];

  // 消息增长或流式 delta 到达时，保持滚动到底部，跟随打字机输出。
  const lastMessage = messages[messages.length - 1];
  useEffect(() => {
    const node = conversationRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages.length, lastMessage?.text, activeSessionId]);

  const filteredSessions = useMemo(() => {
    // 草稿会话（尚未发送首条消息）不进入左侧历史列表，仅作为当前活动会话展示。
    const persisted = sessions.filter((session) => !session.isDraft);
    const keyword = searchText.trim().toLowerCase();

    if (!keyword) {
      return persisted;
    }

    return persisted.filter((session) =>
      [session.title, session.preview, modelLabel(session.model)]
        .join(" ")
        .toLowerCase()
        .includes(keyword),
    );
  }, [searchText, sessions]);

  function startNewSession() {
    if (isCreatingSession) {
      return;
    }
    if (!selectedModel) {
      setNotice("没有可用模型，无法创建新会话。");
      return;
    }

    setNotice("");
    setInput("");

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

  function updateActiveModel(modelKeyValue: string) {
    const nextModel = models.find((model) => modelKey(model) === modelKeyValue);

    if (!nextModel) {
      return;
    }

    setSelectedModel(nextModel);
    setSessions((current) =>
      current.map((session) =>
        session.id === activeSession?.id
          ? {
              ...session,
              model: nextModel,
            }
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

  // 按 messageId 更新会话内的某条消息（打字机 delta / 定稿时使用）。
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
        // 没有任何会话时，先建一个本地草稿并加入列表（仍不落库）。
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

      const response = await fetch(`${serverUrl}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          sessionId: targetSessionId,
          model: selectedModel,
          localTools: localToolSnapshot
            ? {
                deviceId: localToolSnapshot.deviceId,
                workspaceId: localToolSnapshot.workspace.workspaceId,
              }
            : undefined,
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

      // 先插入一个空的、标记为 streaming 的 assistant 占位气泡，随 delta 增长。
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
          case "done": {
            ensureAssistantMessage();
            const finalText =
              event.parts?.find((part) => part.type === "text")?.text;
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
        // 回收未产出内容的占位气泡，并提示错误。
        if (assistantInserted) {
          updateMessage(targetSessionId, assistantMessageId, (message) => ({
            ...message,
            text: message.text || "（生成失败）",
            streaming: false,
          }));
        }
        throw new Error(streamError);
      }

      // 兜底：若流意外结束仍处于 streaming 态，清掉光标。
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

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }

    event.preventDefault();

    void sendCurrentMessage();
  }

  function resolveApproval(approved: boolean) {
    setApprovalPrompt((current) => {
      current?.resolve(approved);
      return null;
    });
  }

  return (
    <main className="app-layout">
      <nav className="app-rail" aria-label="Workspace">
        <div className="rail-logo">M</div>
        <button className="rail-button active" title="Chat" type="button">
          <MessageSquare aria-hidden="true" size={20} strokeWidth={2.1} />
          <span className="sr-only">Chat</span>
        </button>
        <button className="rail-button" title="Agents" type="button">
          <Bot aria-hidden="true" size={20} strokeWidth={2.1} />
          <span className="sr-only">Agents</span>
        </button>
        <button className="rail-button" title="Library" type="button">
          <Library aria-hidden="true" size={20} strokeWidth={2.1} />
          <span className="sr-only">Library</span>
        </button>
        <button className="rail-button" title="Compute" type="button">
          <Cpu aria-hidden="true" size={20} strokeWidth={2.1} />
          <span className="sr-only">Compute</span>
        </button>
        <div className="rail-spacer" />
        <button className="rail-button" title="Settings" type="button">
          <Settings aria-hidden="true" size={20} strokeWidth={2.1} />
          <span className="sr-only">Settings</span>
        </button>
      </nav>

      <aside className="session-sidebar" aria-label="Chat sessions">
        <div className="sidebar-brand">
          <div className="brand-logo">M</div>
          <div className="brand-copy">
            <strong>Muse</strong>
            <span>AI Chat</span>
          </div>
        </div>

        <div className="sidebar-account">
          <span className="account-name">
            {user.displayName ?? "Muse 用户"}
          </span>
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

        <button
          className="new-chat-button"
          disabled={isCreatingSession || isBootstrapping || !selectedModel}
          onClick={startNewSession}
          type="button"
        >
          {isCreatingSession ? (
            <Loader2 aria-hidden="true" className="spin" size={18} />
          ) : (
            <Plus aria-hidden="true" size={18} strokeWidth={2.2} />
          )}
          <span>New chat</span>
        </button>

        <label className="session-search">
          <Search aria-hidden="true" size={17} strokeWidth={2.1} />
          <input
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search sessions"
            type="search"
            value={searchText}
          />
        </label>

        <nav className="history-list" aria-label="History">
          <div className="history-header">
            <span>Sessions</span>
            <strong>{filteredSessions.length}</strong>
          </div>
          {isBootstrapping ? (
            <div className="history-state">
              <Loader2 aria-hidden="true" className="spin" size={15} />
              <span>Loading sessions</span>
            </div>
          ) : null}
          {!isBootstrapping && filteredSessions.length === 0 ? (
            <div className="history-state">No matched sessions</div>
          ) : null}
          {filteredSessions.map((session) => (
            <button
              className={`session-card ${
                session.id === activeSession?.id ? "active" : ""
              }`}
              key={session.id}
              onClick={() => switchSession(session)}
              type="button"
            >
              <span className="session-icon">
                <MessageSquare aria-hidden="true" size={16} strokeWidth={2.1} />
              </span>
              <span className="session-card-body">
                <span className="session-card-title">{session.title}</span>
                <span className="session-card-preview">{session.preview}</span>
                <span className="session-card-meta">
                  <Clock3 aria-hidden="true" size={12} strokeWidth={2.1} />
                  {session.updatedAt}
                  <span>{modelLabel(session.model)}</span>
                </span>
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="chat-shell">
        <header className="topbar">
          <div className="session-title-block">
            <span className="section-kicker">
              <LayoutList aria-hidden="true" size={15} strokeWidth={2.2} />
              Session
            </span>
            <h1>{activeSession?.title ?? "新对话"}</h1>
          </div>
        </header>

        <section className="chat-canvas" aria-label="Chat">
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
          <div className="conversation-scroll" ref={conversationRef}>
            {messages.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon">
                  <Sparkles aria-hidden="true" size={22} strokeWidth={2.1} />
                </span>
                <h2>开始一个新的 AI Chat session</h2>
                <p>选择模型，输入问题，当前 session 的上下文会持续保留。</p>
              </div>
            ) : (
              <div className="message-list" aria-live="polite">
                {messages.map((message) => (
                  <article
                    className={`message message-${message.role}`}
                    key={message.id}
                  >
                    <div className="message-role">
                      {message.role === "assistant" ? "Muse" : "You"}
                    </div>
                    <p>
                      {message.text}
                      {message.streaming ? (
                        <span className="typing-caret" aria-hidden="true" />
                      ) : null}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </div>

          <div className="bottom-dock">
            <form className="composer" onSubmit={handleSubmit}>
              <textarea
                aria-label="Message"
                onKeyDown={handleComposerKeyDown}
                onChange={(event) => setInput(event.target.value)}
                disabled={!selectedModel || isBootstrapping}
                placeholder="What would you like to know?"
                ref={inputRef}
                rows={3}
                value={input}
              />

              <div className="composer-footer">
                <div className="composer-tools">
                  <button className="tool-button icon-only" type="button">
                    <Paperclip aria-hidden="true" size={19} strokeWidth={2.1} />
                    <span className="sr-only">Attach</span>
                  </button>

                  <button className="tool-button" type="button">
                    <Globe2 aria-hidden="true" size={20} strokeWidth={2.1} />
                    <span>Search</span>
                  </button>
                </div>

                <div className="composer-actions">
                  <label className="model-select composer-model-select">
                    <Sparkles aria-hidden="true" size={17} strokeWidth={2.2} />
                    <select
                      aria-label="Model"
                      disabled={isBootstrapping || !models.length}
                      onChange={(event) =>
                        updateActiveModel(event.target.value)
                      }
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
                    <ChevronDown
                      aria-hidden="true"
                      size={16}
                      strokeWidth={2.2}
                    />
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
                      <Loader2 aria-hidden="true" className="spin" size={21} />
                    ) : (
                      <SendHorizontal
                        aria-hidden="true"
                        size={22}
                        strokeWidth={2}
                      />
                    )}
                    <span className="sr-only">
                      {isSending ? "Sending" : "Send"}
                    </span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </section>
      </section>

      <aside className="context-panel" aria-label="Session context">
        <div className="context-card session-summary">
          <div className="context-card-header">
            <span>
              <PanelRight aria-hidden="true" size={15} strokeWidth={2.2} />
              Session
            </span>
          </div>
          <h2>{activeSession?.title ?? "新对话"}</h2>
          <dl className="session-facts">
            <div>
              <dt>Model</dt>
              <dd>{modelLabel(selectedModel)}</dd>
            </div>
            <div>
              <dt>Messages</dt>
              <dd>{messages.length}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{activeSession?.updatedAt ?? "Now"}</dd>
            </div>
          </dl>
        </div>

        <div className="context-card">
          <div className="context-card-header">
            <span>
              <ShieldCheck aria-hidden="true" size={15} strokeWidth={2.2} />
              Runtime
            </span>
          </div>
          <div className="runtime-list">
            <div>
              <span className="runtime-dot ready" />
              <span>Server</span>
              <strong>Ready</strong>
            </div>
            <div>
              <span className="runtime-dot" />
              <span>Auth</span>
              <strong>{user.identities[0]?.provider ?? "local"}</strong>
            </div>
            <div>
              <span className="runtime-dot" />
              <span>Memory</span>
              <strong>Session</strong>
            </div>
            <div>
              <span
                className={`runtime-dot ${
                  localToolSnapshot?.status === "ready" ? "ready" : ""
                }`}
              />
              <span>Local Tools</span>
              <strong>{localToolSnapshot?.status ?? "disabled"}</strong>
            </div>
            <div>
              <span className="runtime-dot ready" />
              <span>Workspace</span>
              <strong>{localToolSnapshot?.workspace.displayName ?? "-"}</strong>
            </div>
            <div>
              <span
                className={`runtime-dot ${approvalPrompt ? "warning" : ""}`}
              />
              <span>Approval</span>
              <strong>{approvalPrompt ? "Waiting" : "Idle"}</strong>
            </div>
          </div>
        </div>

        <div className="context-card">
          <div className="context-card-header">
            <span>
              <History aria-hidden="true" size={15} strokeWidth={2.2} />
              Activity
            </span>
          </div>
          <div className="activity-list">
            {messages.slice(-4).length ? (
              messages.slice(-4).map((message) => (
                <div className="activity-item" key={message.id}>
                  <strong>
                    {message.role === "assistant" ? "Muse" : "You"}
                  </strong>
                  <span>{message.text}</span>
                </div>
              ))
            ) : (
              <div className="activity-empty">No activity yet</div>
            )}
          </div>
        </div>
      </aside>

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
                <span>{approvalPrompt.riskLevel}</span>
                <h2 id="approval-title">{approvalPrompt.title}</h2>
              </div>
              <ShieldCheck aria-hidden="true" size={22} strokeWidth={2.1} />
            </div>
            <dl className="approval-details">
              {approvalPrompt.details.map((detail) => (
                <div key={detail.label}>
                  <dt>{detail.label}</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>
            <div className="approval-actions">
              <button
                className="approval-button secondary"
                onClick={() => resolveApproval(false)}
                type="button"
              >
                Reject
              </button>
              <button
                className="approval-button primary"
                onClick={() => resolveApproval(true)}
                type="button"
              >
                Allow
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
