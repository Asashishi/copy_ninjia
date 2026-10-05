import type { AiWorkerJobFailure } from "../../types/aiChat/workerJob";

/**
 * 主线程交给 AI Worker 的可取消任务（语音合成、摘要组稿）共用的三种失败结局：Worker 不可用或
 * 同步拒收、调用方取消、等待超时。aiChat/workerJob.ts 与 workers/aiChat/workerJob.ts 的每次请求共用
 * 这几个只读对象，结果联合（VoiceSynthesisResult、WebDigestCompositionResult）都包含它们。
 */
export const AI_WORKER_JOB_UNAVAILABLE: Readonly<AiWorkerJobFailure> = { ok: false, reason: "worker unavailable" };
/** 同 AI_WORKER_JOB_UNAVAILABLE，调用方取消时的结局。 */
export const AI_WORKER_JOB_ABORTED: Readonly<AiWorkerJobFailure> = { ok: false, reason: "aborted" };
/** 同 AI_WORKER_JOB_UNAVAILABLE，主线程等待超时时的结局。 */
export const AI_WORKER_JOB_TIMED_OUT: Readonly<AiWorkerJobFailure> = { ok: false, reason: "timed out" };
