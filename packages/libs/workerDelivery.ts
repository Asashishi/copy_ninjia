/**
 * Worker 投递失败的可判别标记。
 *
 * 「消息压根没进 Worker 信箱」与「进去了但屏障/落盘没落定」是两件事，调用方
 * 必须分得开。两者都不能销毁 durable 重放镜像，但前者可直接判定本次调用没有
 * 启动副作用；后者只能等待回执或在 Worker 重建后按幂等协议重放。
 * @see ../../docs/cn/04-invariants.md
 */

/** 消息没能进 Worker 信箱；Worker 没收到，也就不会执行。 */
export class WorkerUndeliveredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerUndeliveredError";
  }
}
