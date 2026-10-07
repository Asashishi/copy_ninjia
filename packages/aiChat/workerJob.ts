/**
 * 主线程向 AI Worker 发起可取消任务（语音合成 aiChat/voiceSynthesis.ts、摘要组稿 aiChat/webDigest.ts）
 * 的公共骨架：Worker 不可用或调用方已取消时直接结算；否则在等待表登记一个等待者再投递开始消息，
 * 等待超时与调用方取消会再投一条撤回消息让 Worker 中止在途任务。等待与结算见
 * libs/workerRequestTable.ts，结算一律交回结果，不抛错。
 */

import { AI_WORKER_JOB_ABORTED, AI_WORKER_JOB_TIMED_OUT, AI_WORKER_JOB_UNAVAILABLE } from "../consts/aiChat/workerJob";
import { beginWorkerRequest } from "../libs/workerRequestTable";
import { logger } from "../infra/logger";
import type { AiChatWorkerMessage } from "../types/aiChat/protocol";
import type { AiWorkerJobFailure, AiWorkerJobTransport } from "../types/aiChat/workerJob";
import type { WorkerRequestTable } from "../types/workerRequest";

/** requestAiWorkerJob 的入参。 */
export interface RequestAiWorkerJobOptions<T> {
  readonly table: WorkerRequestTable<T | AiWorkerJobFailure>;
  readonly timeoutMs: number;
  readonly transport: AiWorkerJobTransport;
  /** 调用方取消信号；中止时立即按 aborted 结算并撤回 Worker 侧任务。 */
  readonly signal: AbortSignal | undefined;
  /** 用等待表发出的 requestId 组装开始消息。 */
  readonly start: (requestId: number) => AiChatWorkerMessage;
  /** 用同一 requestId 组装撤回消息。 */
  readonly cancel: (requestId: number) => AiChatWorkerMessage;
}

/** 发起一次可取消任务并等待结果。 */
export function requestAiWorkerJob<T>({
  table,
  timeoutMs,
  transport,
  signal,
  start,
  cancel,
}: RequestAiWorkerJobOptions<T>): Promise<T | AiWorkerJobFailure> {
  if (!transport.workerAvailable) return Promise.resolve(AI_WORKER_JOB_UNAVAILABLE);
  if (signal?.aborted === true) return Promise.resolve(AI_WORKER_JOB_ABORTED);
  return beginWorkerRequest<T | AiWorkerJobFailure>({
    table,
    timeoutMs,
    post: (requestId: number): boolean => transport.post(start(requestId)),
    onPostError: (error: unknown): void => {
      logger.error("Failed to post an AI Worker job request:", error);
    },
    cancel: (requestId: number): void => {
      transport.post(cancel(requestId));
    },
    abort: { signal, result: AI_WORKER_JOB_ABORTED },
    timedOut: AI_WORKER_JOB_TIMED_OUT,
    rejected: AI_WORKER_JOB_UNAVAILABLE,
  });
}
