import { randomUUID } from "node:crypto";
import type { ApprovalDecidedBy, ApprovalDecision } from "@muse/shared";

// 一次待审批调用的元信息与等待句柄。
type PendingApproval = {
  approvalId: string;
  userId: string;
  sessionId: string;
  runId: string;
  deviceId: string;
  eventId: string;
  toolName: string;
  createdAt: Date;
  expiresAt: Date;
  timer: NodeJS.Timeout | null;
  settled: boolean;
  resolve: (outcome: ApprovalOutcome) => void;
};

export type ApprovalOutcome = {
  decision: ApprovalDecision;
  decidedBy: ApprovalDecidedBy;
  reason?: string;
};

export type ApprovalRequestInput = {
  userId: string;
  sessionId: string;
  runId: string;
  deviceId: string;
  eventId: string;
  toolName: string;
  timeoutMs: number;
  // 发起方（手机/桌面浏览器）断开时立即取消审批，避免 Promise 悬挂到超时。
  abortSignal?: AbortSignal;
};

// 本地工具审批协调器。
//
// 与 LocalToolBroker 结构相似（pending Map + Promise resolve），但语义是「等待人工审批」
// 而非「等待工具执行结果」：
//   - key 为 approvalId，与具体 SSE/WS 连接解耦，因此手机可用独立 POST 回传、桌面可用 WS 回传；
//   - 任一端先回传即定（settled 去抖），后到者被忽略；
//   - 超时策略独立且远长于执行超时（人工审批需要时间）；
//   - 发起方连接断开（abortSignal）即取消，但执行方桌面掉线不影响审批（审批可能来自手机）。
export class ApprovalCoordinator {
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  // 登记一次待审批调用并返回 approvalId + 等待 Promise。
  // 调用方负责把 approvalId 通过 SSE / WS 分别下发给发起方与在线桌面。
  request(input: ApprovalRequestInput): {
    approvalId: string;
    expiresAt: Date;
    wait: Promise<ApprovalOutcome>;
  } {
    const approvalId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.timeoutMs);

    const wait = new Promise<ApprovalOutcome>((resolve) => {
      const settle = (outcome: ApprovalOutcome) => {
        const pending = this.pendingApprovals.get(approvalId);
        if (!pending || pending.settled) {
          return;
        }
        pending.settled = true;
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        this.pendingApprovals.delete(approvalId);
        input.abortSignal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };

      const onAbort = () => {
        settle({
          decision: "rejected",
          decidedBy: "disconnect",
          reason: "CLIENT_DISCONNECTED",
        });
      };

      const timer = setTimeout(() => {
        settle({
          decision: "rejected",
          decidedBy: "timeout",
          reason: "APPROVAL_TIMEOUT",
        });
      }, input.timeoutMs);

      this.pendingApprovals.set(approvalId, {
        approvalId,
        userId: input.userId,
        sessionId: input.sessionId,
        runId: input.runId,
        deviceId: input.deviceId,
        eventId: input.eventId,
        toolName: input.toolName,
        createdAt: now,
        expiresAt,
        timer,
        settled: false,
        resolve: settle,
      });

      if (input.abortSignal) {
        if (input.abortSignal.aborted) {
          onAbort();
        } else {
          input.abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });

    return { approvalId, expiresAt, wait };
  }

  // 供越权校验：回传者的 userId 必须等于登记时的 userId。
  getPending(approvalId: string): PendingApproval | null {
    return this.pendingApprovals.get(approvalId) ?? null;
  }

  // 任一端回传决策。命中已 settled 或不存在则返回 false（竞态去抖，后到者优雅失败）。
  resolve(
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: ApprovalDecidedBy,
  ): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.settled) {
      return false;
    }
    pending.resolve({ decision, decidedBy });
    return true;
  }

  // 发起方所在的 run 结束/异常时兜底取消该 run 的所有待审批。
  failRun(runId: string, reason = "RUN_ABORTED"): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      if (pending.runId !== runId) {
        continue;
      }
      pending.resolve({ decision: "rejected", decidedBy: "disconnect", reason });
    }
  }
}
