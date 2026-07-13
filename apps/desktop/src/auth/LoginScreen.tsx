import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthUser } from "@muse/shared";
import { MuseWordmark } from "../BrandMark";
import {
  type ChallengeResult,
  devLogin,
  pollChallengeStatus,
  saveToken,
  startFeishuChallenge,
} from "../auth/client";

const POLL_INTERVAL_MS = 2000;
const canUseDevLogin = import.meta.env.DEV;

// idle: 正在发起登录；ready: 可点击登录；waiting: 已拉起浏览器并轮询；error: 失败。
type Phase = "idle" | "ready" | "waiting" | "error";

async function openExternalUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
    return;
  } catch (error) {
    console.warn("Tauri opener failed, falling back to window.open", error);
  }

  const opened = window.open(url, "_blank");
  if (!opened) {
    throw new Error("无法打开系统浏览器，请稍后重试");
  }
}

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

  // 创建一次 challenge，拿到 authUrl + state。
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

  // 首次进入只展示登录按钮；challenge 在用户点击时创建，避免先“准备”再登录的两段式交互。
  useEffect(() => {
    setPhase("ready");
    return stopPolling;
  }, [stopPolling]);

  // 点击后创建 challenge 并拉起系统浏览器授权，随后切到 waiting 开始轮询。
  const beginLogin = useCallback(async () => {
    try {
      stopPolling();
      setPhase("idle");
      setErrorMsg("");
      const activeChallenge = challenge ?? (await startFeishuChallenge());
      setChallenge(activeChallenge);
      await openExternalUrl(activeChallenge.authUrl);
      setPhase("waiting");
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "无法打开浏览器");
      setPhase("error");
    }
  }, [challenge, stopPolling]);

  const beginDevLogin = useCallback(async () => {
    try {
      setPhase("idle");
      setErrorMsg("");
      const result = await devLogin();
      onAuthenticated(result.token, result.user);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "开发登录失败");
      setPhase("error");
    }
  }, [onAuthenticated]);

  const resolveChallenge = useCallback(async (): Promise<boolean> => {
    if (!challenge) {
      return false;
    }

    const status = await pollChallengeStatus(challenge.state);
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
  }, [challenge, onAuthenticated]);

  useEffect(() => {
    if (phase !== "waiting") {
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "muse-auth-callback") {
        return;
      }
      void resolveChallenge().catch((error: unknown) => {
        setErrorMsg(error instanceof Error ? error.message : "轮询失败");
        setPhase("error");
      });
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [phase, resolveChallenge]);

  // waiting 阶段轮询扫码/授权结果。
  useEffect(() => {
    if (phase !== "waiting" || !challenge) {
      return;
    }

    let cancelled = false;

    const tick = async () => {
      try {
        const shouldContinue = await resolveChallenge();
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
            <div className="login-status-hint">正在打开飞书登录…</div>
          ) : (
            <div className="login-status-hint">点击下方按钮登录。</div>
          )}
        </div>

        {canUseDevLogin ? (
          <>
            <button
              className="login-button"
              onClick={beginDevLogin}
              type="button"
            >
              Dev Login
            </button>
            <button
              className="login-button ghost"
              disabled={phase === "idle"}
              onClick={beginLogin}
              type="button"
            >
              <ExternalLink aria-hidden="true" size={16} strokeWidth={2.2} />
              飞书登录
            </button>
          </>
        ) : phase === "error" ? (
          <button className="login-button" onClick={beginLogin} type="button">
            <ExternalLink aria-hidden="true" size={16} strokeWidth={2.2} />
            飞书登录
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
            飞书登录
          </button>
        )}
      </div>
    </main>
  );
}
