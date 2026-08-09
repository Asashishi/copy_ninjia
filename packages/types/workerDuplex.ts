/** 主线程与业务 Worker 双工请求/回执的共享线协议。 */

/** Worker 请求主线程执行一项能力。 */
export interface WorkerDuplexRequest<TRequest> {
  readonly __duplex: "request";
  readonly requestId: number;
  readonly request: TRequest;
}

/** Worker 取消一项尚未结算的主线程能力请求。 */
export interface WorkerDuplexCancel {
  readonly __duplex: "cancel";
  readonly requestId: number;
}

/** 跨线程传递的最小错误形态；不得携带请求 payload 或敏感 URL。 */
export interface WorkerDuplexError {
  readonly name: string;
  readonly message: string;
  readonly telegramErrorCode: number | undefined;
  readonly telegramDescription: string | undefined;
}

/** 主线程对 Worker 能力请求的统一回执；所有字段固定出现以保持对象 shape。 */
export interface WorkerDuplexResponse {
  readonly __duplex: "response";
  readonly requestId: number;
  readonly ok: boolean;
  readonly value: unknown;
  readonly error: WorkerDuplexError | undefined;
}

/** Worker 发往主线程的双工控制消息。 */
export type WorkerDuplexOutbound<TRequest> =
  | WorkerDuplexRequest<TRequest>
  | WorkerDuplexCancel;

/** 主线程发往 Worker 的业务消息或双工回执。 */
export type WorkerDuplexInbound<TMessage> = TMessage | WorkerDuplexResponse;
