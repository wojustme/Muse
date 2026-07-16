import { ExternalLink, Loader2, Server } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthUser } from "@muse/shared";
import { MuseWordmark } from "../BrandMark";
import { openExternalAuthUrl } from "../platform/capabilities";
import {
  isValidServerUrl,
  resolveServerUrl,
  saveServerUrl,
} from "../config/server-url";
import {
  type ChallengeResult,
  devLogin,
  pollChallengeStatus,
  saveToken,
  startFeishuChallenge,
} from "./client";

const POLL_INTERVAL_MS = 2000;
const canUseDevLogin = import.meta.env.DEV;

// idle: 正在发起登录；ready: 可点击登录；waiting: 已拉起浏览器并轮询；error: 失败。
type Phase = "idle" | "ready" | "waiting" | "error";

// 移动端飞书登录页。
// WKWebView 不使用 window.open + postMessage，改为用系统外部浏览器完成授权，
// App 侧持续轮询 challenge 状态直到拿到 token。
// 额外提供服务端地址输入框——真机无法访问桌面开发机的 127.0.0.1。
export function LoginScreen({
  onAuthenticated,
}: {
  onAuthenticated: (token: string, user: AuthUser) => void;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [challenge, setChallenge] = useState<ChallengeResult | null>(null);
  const [serverUrl, setServerUrl] = useState<string>(resolveServerUrl());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  // 持久化服务端地址，challenge 缓存作废（地址变了要重新发起）。
  const commitServerUrl = useCallback(() => {
    if (!isValidServerUrl(serverUrl)) {
      setErrorMsg("请输入合法的服务端地址，例如 http://192.168.1.10:8787");
      setPhase("error");
      return false;
    }
    const saved = saveServerUrl(serverUrl);
    setServerUrl(saved);
    setChallenge(null);
    return true;
  }, [serverUrl]);

  const resolveChallenge = useCallback(
    async (active: ChallengeResult): Promise<boolean> => {
      const status = await pollChallengeStatus(active.state);
      if (status.status === "authorized") {
        saveToken(status.token);
        onAuthenticated(status.token, status.user);
        return false;
      }
      if (status.status === "expired") {
        setErrorMsg("登录已超时，请重新登录。");
        setPhase("error");
        return false;
      }
      if (status.status === "failed") {
        setErrorMsg(
          status.errorCode === "IDENTITY_ALREADY_BOUND"
            ? "该飞书身份已绑定到其他账号。"
            : "登录失败，请重试。",
        );
        setPhase("error");
        return false;
      }
      return true;
    },
    [onAuthenticated],
  );

  // 点击后创建 challenge，用系统浏览器拉起授权，随后进入 waiting 轮询。
  const beginLogin = useCallback(async () => {
    if (!commitServerUrl()) {
      return;
    }
    try {
      stopPolling();
      setPhase("idle");
      setErrorMsg("");
      const active = await startFeishuChallenge();
      setChallenge(active);
      await openExternalAuthUrl(active.authUrl);
      setPhase("waiting");
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "发起登录失败");
      setPhase("error");
    }
  }, [commitServerUrl, stopPolling]);

  const beginDevLogin = useCallback(async () => {
    if (!commitServerUrl()) {
      return;
    }
    try {
      setPhase("idle");
      setErrorMsg("");
      const result = await devLogin();
      onAuthenticated(result.token, result.user);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "开发登录失败");
      setPhase("error");
    }
  }, [commitServerUrl, onAuthenticated]);

  // waiting 阶段轮询授权结果。
  useEffect(() => {
    if (phase !== "waiting" || !challenge) {
      return;
    }

    let cancelled = false;

    const tick = async () => {
      try {
        const shouldContinue = await resolveChallenge(challenge);
        if (cancelled) {
          return;
        }
        if (shouldContinue) {
          timerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setErrorMsg(error instanceof Error ? error.message : "轮询失败");
        setPhase("error");
      }
    };

    timerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [phase, challenge, resolveChallenge, stopPolling]);

  return (
    <main className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <MuseWordmark size={40} />
        </div>

        <h1 className="login-title">飞书登录</h1>
        <p className="login-subtitle">
          点击下方按钮，在系统浏览器中完成飞书授权后，返回 App 即可自动登录。
        </p>

        <label className="login-server">
          <span className="login-server-label">
            <Server aria-hidden="true" size={14} strokeWidth={2.1} />
            服务端地址
          </span>
          <input
            autoCapitalize="none"
            autoCorrect="off"
            inputMode="url"
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="http://192.168.1.10:8787"
            spellCheck={false}
            type="url"
            value={serverUrl}
          />
        </label>

        <div className="login-status">
          {phase === "waiting" ? (
            <div className="login-status-waiting">
              <Loader2 aria-hidden="true" className="spin" size={18} />
              <span>已在浏览器中打开，请完成授权后返回…</span>
            </div>
          ) : phase === "error" ? (
            <div className="login-status-error">{errorMsg}</div>
          ) : phase === "idle" ? (
            <div className="login-status-hint">正在打开飞书登录…</div>
          ) : (
            <div className="login-status-hint">点击下方按钮登录。</div>
          )}
        </div>

        <button
          className="login-button"
          disabled={phase === "idle"}
          onClick={() => void beginLogin()}
          type="button"
        >
          <ExternalLink aria-hidden="true" size={16} strokeWidth={2.2} />
          {phase === "waiting" ? "重新打开浏览器" : "飞书登录"}
        </button>

        {canUseDevLogin ? (
          <button
            className="login-button ghost"
            onClick={() => void beginDevLogin()}
            type="button"
          >
            Dev Login
          </button>
        ) : null}
      </div>
    </main>
  );
}
