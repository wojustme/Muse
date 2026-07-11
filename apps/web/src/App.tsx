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
  Monitor,
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

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
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
  model: ModelSelection;
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

const fallbackModels: ModelOption[] = [
  {
    provider: "openai",
    name: "gpt-4o-mini",
    capabilities: ["streaming", "tools", "vision"],
  },
  {
    provider: "deepseek",
    name: "deepseek-chat",
    capabilities: ["streaming"],
  },
  {
    provider: "glm",
    name: "glm-4-flash",
    capabilities: ["streaming"],
  },
];

const defaultModel = fallbackModels[0] as ModelOption;

function modelKey(model: ModelSelection): string {
  return `${model.provider}:${model.name}`;
}

function modelLabel(model: ModelSelection): string {
  return `${model.provider}/${model.name}`;
}

function createDraftSession(model: ModelSelection): Session {
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
    : fallbackModels;
}

async function fetchSessions(
  defaultSelection: ModelSelection,
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
  defaultSelection: ModelSelection,
  messages: Message[] = [],
  messagesLoaded = false,
): Session {
  return {
    id: session.id,
    title: session.title,
    preview: session.lastMessagePreview ?? "打开 session 继续对话。",
    updatedAt: formatTime(session.updatedAt),
    model: {
      provider: session.modelProvider ?? defaultSelection.provider,
      name: session.modelName ?? defaultSelection.name,
    },
    messages,
    messagesLoaded,
    isDraft: false,
  };
}

async function createServerSession(model: ModelSelection): Promise<ServerSession> {
  const response = await fetch(`${serverUrl}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ model }),
  });
  if (!response.ok) {
    throw new Error(`创建会话失败（${response.status}）`);
  }

  const data = (await response.json()) as { session: ServerSession };
  return data.session;
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
  const [models, setModels] = useState<ModelOption[]>(fallbackModels);
  const [sessions, setSessions] = useState<Session[]>(() => [
    createDraftSession(defaultModel),
  ]);
  const [input, setInput] = useState("");
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState(sessions[0]?.id ?? "");
  const [selectedModel, setSelectedModel] =
    useState<ModelSelection>(defaultModel);
  const [searchText, setSearchText] = useState("");
  const [notice, setNotice] = useState<string>("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setIsBootstrapping(true);
      setNotice("");

      try {
        const loadedModels = await fetchModels();
        const nextModel = loadedModels[0] ?? defaultModel;
        const loadedSessions = await fetchSessions(nextModel);
        let nextSessions = loadedSessions.length
          ? loadedSessions
          : [createDraftSession(nextModel)];

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
      } catch (error) {
        if (cancelled) {
          return;
        }

        setNotice(error instanceof Error ? error.message : "初始化失败");
        setModels(fallbackModels);
        setSessions([createDraftSession(defaultModel)]);
        setSelectedModel(defaultModel);
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
      createDraftSession(selectedModel),
    [activeSessionId, selectedModel, sessions],
  );

  const messages = activeSession.messages;

  const filteredSessions = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();

    if (!keyword) {
      return sessions;
    }

    return sessions.filter((session) =>
      [session.title, session.preview, modelLabel(session.model)]
        .join(" ")
        .toLowerCase()
        .includes(keyword),
    );
  }, [searchText, sessions]);

  async function startNewSession() {
    if (isCreatingSession) {
      return;
    }

    setIsCreatingSession(true);
    setNotice("");

    try {
      const session = await createServerSession(selectedModel);
      const nextSession = sessionFromServer(session, selectedModel, [], true);

      setSessions((current) => [nextSession, ...current]);
      setActiveSessionId(nextSession.id);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "创建会话失败。",
      );
    } finally {
      setInput("");
      setIsCreatingSession(false);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function switchSession(session: Session) {
    setActiveSessionId(session.id);
    setSelectedModel(session.model);
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
    const nextModel =
      models.find((model) => modelKey(model) === modelKeyValue) ?? defaultModel;

    setSelectedModel(nextModel);
    setSessions((current) =>
      current.map((session) =>
        session.id === activeSession.id
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

  async function sendCurrentMessage() {
    const text = input.trim();
    if (!text || isSending) {
      return;
    }

    setInput("");
    setIsSending(true);
    setNotice("");

    try {
      let targetSession = activeSession;

      if (targetSession.isDraft) {
        const created = await createServerSession(selectedModel);
        targetSession = sessionFromServer(created, selectedModel, [], true);
        setSessions((current) =>
          current.map((session) =>
            session.id === activeSession.id ? targetSession : session,
          ),
        );
        setActiveSessionId(targetSession.id);
      }

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        text,
      };

      appendMessage(targetSession.id, userMessage, titleFromPrompt(text));

      const response = await fetch(`${serverUrl}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          sessionId: targetSession.id,
          model: selectedModel,
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

      const data = await response.json();
      const assistantText =
        data.parts?.find((part: { type: string }) => part.type === "text")
          ?.text ?? "No response text returned.";

      appendMessage(targetSession.id, {
        id: data.id ?? crypto.randomUUID(),
        role: "assistant",
        text: assistantText,
      });
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

  return (
    <main className="app-layout">
      <header className="window-titlebar">
        <div className="traffic-lights" aria-hidden="true">
          <span className="traffic-close" />
          <span className="traffic-minimize" />
          <span className="traffic-maximize" />
        </div>
        <div className="window-title">
          <Monitor aria-hidden="true" size={14} strokeWidth={2.2} />
          <span>Muse Web</span>
        </div>
        <div className="window-status">
          <span className="status-dot" />
          Local server
        </div>
      </header>

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
          disabled={isCreatingSession}
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
                session.id === activeSession.id ? "active" : ""
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
            <h1>{activeSession.title}</h1>
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
          <div className="conversation-scroll">
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
                    <p>{message.text}</p>
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
                      onChange={(event) =>
                        updateActiveModel(event.target.value)
                      }
                      value={modelKey(selectedModel)}
                    >
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
                    disabled={isSending || !input.trim()}
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
          <h2>{activeSession.title}</h2>
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
              <dd>{activeSession.updatedAt}</dd>
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
    </main>
  );
}
