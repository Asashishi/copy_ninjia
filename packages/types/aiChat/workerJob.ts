/** 主线程交给 AI Worker 的可取消任务（语音合成、摘要组稿）共用的协议类型。 */

import type { AiChatWorkerMessage } from "./protocol";

/** 可取消任务的通用失败原因：Worker 不可用或同步拒收、调用方取消、等待超时。 */
export type AiWorkerJobFailureReason = "worker unavailable" | "aborted" | "timed out";

/** 可取消任务的通用失败结局；各任务的结果联合都包含它。 */
export interface AiWorkerJobFailure {
  readonly ok: false;
  readonly reason: AiWorkerJobFailureReason;
}

/** 主线程发起可取消任务的注入项：投递函数与 Worker 此刻是否可用。 */
export interface AiWorkerJobTransport {
  /** 向当前 AI Worker 投递；返回 false 表示同步拒绝。 */
  readonly post: (message: AiChatWorkerMessage) => boolean;
  readonly workerAvailable: boolean;
}
