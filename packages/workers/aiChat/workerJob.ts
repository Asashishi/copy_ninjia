/**
 * AI Worker 侧执行主线程转交的可取消任务（语音合成 ./voiceSynthesis.ts、摘要组稿 ./webDigest.ts）
 * 的公共骨架：排空开始后到达的请求直接回「worker unavailable」；其余按 requestId 在调用方的在途表
 * 登记取消控制器，任务信号合入 Worker 统一生命周期信号（Worker 停止或进入排空时一并中止），执行
 * 结束后摘除自己的条目再回执。撤回消息由调用方按 requestId 中止在途表里的控制器。
 */

import { aiChatWorkerAbortController, aiChatWorkerQuiescing } from "../../cache/workers/aiChat/worker";
import { AI_WORKER_JOB_UNAVAILABLE } from "../../consts/aiChat/workerJob";
import type { AiWorkerJobFailure } from "../../types/aiChat/workerJob";

/** runAiWorkerJob 的入参。 */
export interface RunAiWorkerJobOptions<T> {
  /** 调用方 owner 的在途表（requestId → 取消控制器）。 */
  readonly jobs: Map<number, AbortController>;
  readonly requestId: number;
  /** 执行任务；必须自行把意外异常折算成结果，返回的 Promise 不得 reject。 */
  readonly run: (signal: AbortSignal) => Promise<T>;
  /** 回执结果给主线程。 */
  readonly publish: (result: T | AiWorkerJobFailure) => void;
}

/** 接纳一次任务；结算后摘除在途条目并回执。 */
export function runAiWorkerJob<T>({ jobs, requestId, run, publish }: RunAiWorkerJobOptions<T>): void {
  if (aiChatWorkerQuiescing.current) {
    publish(AI_WORKER_JOB_UNAVAILABLE);
    return;
  }
  const controller: AbortController = new AbortController();
  jobs.set(requestId, controller);
  void run(AbortSignal.any([controller.signal, aiChatWorkerAbortController.current.signal])).then((result: T): void => {
    if (jobs.get(requestId) === controller) jobs.delete(requestId);
    publish(result);
  });
}
