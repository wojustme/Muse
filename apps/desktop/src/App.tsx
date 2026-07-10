import {
  ChevronDown,
  Clock3,
  Globe2,
  LayoutList,
  LogOut,
  MessageSquare,
  Paperclip,
  Plus,
  Search,
  SendHorizontal,
  Sparkles,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { AuthUser } from "@muse/shared";
import { authHeaders, fetchMe, logout } from "./auth/client";
import { LoginScreen } from "./auth/LoginScreen";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type Session = {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  model: string;
  messages: Message[];
};

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://127.0.0.1:8787";

const models = ["gpt-5-mini", "deepseek-chat", "glm-4.5", "claude-sonnet"];

const sessions: Session[] = [
  {
    id: "local-session",
    title: "新对话",
    preview: "准备开始一个新的 session。",
    updatedAt: "Now",
    model: "gpt-5-mini",
    messages: [],
  },
  {
    id: "desktop-plan",
    title: "桌面端架构讨论",
    preview: "Tauri、Node 服务边界，以及本地能力规划。",
    updatedAt: "Yesterday",
    model: "deepseek-chat",
    messages: [
      {
        id: "desktop-plan-user",
        role: "user",
        text: "Tauri v2 作为 macOS 和 Windows 桌面端基础有没有问题？",
      },
      {
        id: "desktop-plan-assistant",
        role: "assistant",
        text: "可以直接上 Tauri v2。它同时支持 macOS 和 Windows，前端复用 React，系统能力通过 Rust command 暴露给客户端，后续接入本地操作能力也比较自然。",
      },
    ],
  },
  {
    id: "agent-roadmap",
    title: "AI Agent 演进路线",
    preview: "从 Chat 到 session 记忆，再到工具调用与本地操作。",
    updatedAt: "Jul 8",
    model: "glm-4.5",
    messages: [
      {
        id: "roadmap-user",
        role: "user",
        text: "先做 AI-Chat，再逐步演化到 AI-Agent，研发顺序怎么安排？",
      },
      {
        id: "roadmap-assistant",
        role: "assistant",
        text: "第一阶段先完成多模型聊天、session 管理和历史查看；第二阶段抽象 Agent SDK 与工具调用；第三阶段再把桌面端系统能力接入对话流。",
      },
    ],
  },
];

const defaultSession = sessions[0] as Session;

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
  const [sessionMessages, setSessionMessages] = useState<
    Record<string, Message[]>
  >(() =>
    Object.fromEntries(
      sessions.map((session) => [session.id, session.messages]),
    ),
  );
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState("local-session");
  const [selectedModel, setSelectedModel] = useState(defaultSession.model);
  const [searchText, setSearchText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const activeSession = useMemo(
    () =>
      sessions.find((session) => session.id === activeSessionId) ??
      defaultSession,
    [activeSessionId],
  );

  const messages = sessionMessages[activeSession.id] ?? [];

  const filteredSessions = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();

    if (!keyword) {
      return sessions;
    }

    return sessions.filter((session) =>
      [session.title, session.preview, session.model]
        .join(" ")
        .toLowerCase()
        .includes(keyword),
    );
  }, [searchText]);

  function startNewSession() {
    setActiveSessionId("local-session");
    setSelectedModel(defaultSession.model);
    setSessionMessages((current) => ({
      ...current,
      "local-session": [],
    }));
    setInput("");
    inputRef.current?.focus();
  }

  function switchSession(session: Session) {
    setActiveSessionId(session.id);
    setSelectedModel(session.model);
    setInput("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = input.trim();
    if (!text || isSending) {
      return;
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text,
    };

    setSessionMessages((current) => ({
      ...current,
      [activeSession.id]: [...(current[activeSession.id] ?? []), userMessage],
    }));
    setInput("");
    setIsSending(true);

    try {
      const response = await fetch(`${serverUrl}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          sessionId: activeSession.id,
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

      setSessionMessages((current) => ({
        ...current,
        [activeSession.id]: [
          ...(current[activeSession.id] ?? []),
          {
            id: data.id ?? crypto.randomUUID(),
            role: "assistant",
            text: assistantText,
          },
        ],
      }));
    } catch (error) {
      setSessionMessages((current) => ({
        ...current,
        [activeSession.id]: [
          ...(current[activeSession.id] ?? []),
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text:
              error instanceof Error
                ? `Request failed: ${error.message}`
                : "Request failed.",
          },
        ],
      }));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="app-layout">
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
          onClick={startNewSession}
          type="button"
        >
          <Plus aria-hidden="true" size={18} strokeWidth={2.2} />
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
                  <span>{session.model}</span>
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

          <div className="topbar-actions">
            <label className="model-select">
              <Sparkles aria-hidden="true" size={17} strokeWidth={2.2} />
              <select
                aria-label="Model"
                onChange={(event) => setSelectedModel(event.target.value)}
                value={selectedModel}
              >
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" size={16} strokeWidth={2.2} />
            </label>
          </div>
        </header>

        <section className="chat-canvas" aria-label="Chat">
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

                  <span className="active-model">
                    <Sparkles aria-hidden="true" size={16} strokeWidth={2.1} />
                    {selectedModel}
                  </span>
                </div>

                <button
                  className="send-button"
                  disabled={isSending || !input.trim()}
                  type="submit"
                >
                  <SendHorizontal
                    aria-hidden="true"
                    size={22}
                    strokeWidth={2}
                  />
                  <span className="sr-only">
                    {isSending ? "Sending" : "Send"}
                  </span>
                </button>
              </div>
            </form>
          </div>
        </section>
      </section>
    </main>
  );
}
