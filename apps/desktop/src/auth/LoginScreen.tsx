import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthUser } from "@muse/shared";
import {
  type ChallengeResult,
  pollChallengeStatus,
  saveToken,
  startFeishuChallenge,
} from "../auth/client";

const POLL_INTERVAL_MS = 2000;

// idle: 正在创建 challenge；ready: 可点击登录；waiting: 已拉起浏览器并轮询；error: 失败。
type Phase = "idle" | "ready" | "waiting" | "error";

// 飞书浏览器授权登录页（macOS 桌面）。
// 桌面 OAuth 标准流：点击登录 -> 系统浏览器完成授权 -> 后台轮询 login_challenges 自动登录。
// 不使用手机扫码：授权回调指向 http://127.0.0.1，在手机上不可达。
export function LoginScreen({
  onAuthenticated,
}: {
  onAuthenticated: (token: string, user: AuthUser) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [challenge, setChallenge] = useState<ChallengeResult | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 创建一次 challenge，拿到 authUrl + state（此时还不轮询）。
  const prepareChallenge = useCallback(async () => {
    stopPolling();
    setPhase("idle");
    setErrorMsg("");
    try {
      const result = await startFeishuChallenge();
      setChallenge(result);
      setPhase("ready");
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "发起登录失败");
      setPhase("error");
    }
  }, [stopPolling]);

  // 首次进入自动准备好 challenge。
  useEffect(() => {
    void prepareChallenge();
    return stopPolling;
  }, [prepareChallenge, stopPolling]);

  // 拉起系统浏览器授权，并切到 waiting 开始轮询。
  const beginLogin = useCallback(async () => {
    if (!challenge) {
      return;
    }
    try {
      await openUrl(challenge.authUrl);
      setPhase("waiting");
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "无法打开浏览器");
      setPhase("error");
    }
  }, [challenge]);

  // waiting 阶段轮询扫码/授权结果。
  useEffect(() => {
    if (phase !== "waiting" || !challenge) {
      return;
    }

    let cancelled = false;

    const tick = async () => {
      try {
        const status = await pollChallengeStatus(challenge.state);
        if (cancelled) {
          return;
        }
        if (status.status === "authorized") {
          saveToken(status.token);
          onAuthenticated(status.token, status.user);
          return;
        }
        if (status.status === "expired") {
          setErrorMsg("登录已超时，请重新登录。");
          setPhase("error");
          return;
        }
        if (status.status === "failed") {
          setErrorMsg(
            status.errorCode === "IDENTITY_ALREADY_BOUND"
              ? "该飞书身份已绑定到其他账号。"
              : "登录失败，请重试。",
          );
          setPhase("error");
          return;
        }
        // pending：继续轮询。
        timerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);
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
  }, [phase, challenge, onAuthenticated, stopPolling]);

  return (
    <main className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-logo">M</div>
          <div className="brand-copy">
            <strong>Muse</strong>
            <span>AI Chat</span>
          </div>
        </div>

        <h1 className="login-title">飞书登录</h1>
        <p className="login-subtitle">
          点击下方按钮，在系统浏览器中完成飞书授权后自动返回。
        </p>

        <div className="login-status">
          {phase === "waiting" ? (
            <div className="login-status-waiting">
              <Loader2 aria-hidden="true" className="spin" size={18} />
              <span>已在浏览器中打开，请完成授权…</span>
            </div>
          ) : phase === "error" ? (
            <div className="login-status-error">{errorMsg}</div>
          ) : phase === "idle" ? (
            <div className="login-status-hint">正在准备登录…</div>
          ) : (
            <div className="login-status-hint">准备就绪，点击下方按钮登录。</div>
          )}
        </div>

        {phase === "error" ? (
          <button className="login-button" onClick={prepareChallenge} type="button">
            <RefreshCw aria-hidden="true" size={16} strokeWidth={2.2} />
            重试
          </button>
        ) : phase === "waiting" ? (
          <button
            className="login-button ghost"
            onClick={beginLogin}
            type="button"
          >
            <ExternalLink aria-hidden="true" size={16} strokeWidth={2.2} />
            重新打开浏览器
          </button>
        ) : (
          <button
            className="login-button"
            disabled={phase !== "ready"}
            onClick={beginLogin}
            type="button"
          >
            <ExternalLink aria-hidden="true" size={16} strokeWidth={2.2} />
            使用飞书登录
          </button>
        )}
      </div>
    </main>
  );
}
