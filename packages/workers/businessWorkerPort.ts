import { acceptForwardedLogBatch } from "../infra/logger";
import { installTelegramApi } from "../infra/telegram/client";
import { workerTelegramApi } from "../infra/telegram/workerClient";
import {
  handleWorkerDuplexResponse,
  initializeWorkerDuplex,
  isWorkerDuplexResponse,
} from "../libs/workerDuplex";
import type { WorkerDuplexOutbound } from "../types/workerDuplex";

declare const self: Worker;

/**
 * 两条业务 Worker（AI 闲聊、Anti-Raid）共用的线程端口：装上经主线程代理的 Telegram
 * 能力面，以 `self.postMessage` 作为双工出口，并按固定顺序路由入站消息——主线程
 * 转发日志批次的回执、双工回包，其余交给领域处理器。只由两条 Worker 的线程启动入口
 * 调用；停止时由调用方把 `self.onmessage` 置空。
 */
export function installBusinessWorkerPort<TRequest, TMessage>(
  handleMessage: (message: TMessage) => void
): void {
  installTelegramApi(workerTelegramApi);
  initializeWorkerDuplex<TRequest>((
    message: WorkerDuplexOutbound<TRequest>,
    transfer?: Bun.Transferable[]
  ): void => {
    if (transfer === undefined) self.postMessage(message);
    else self.postMessage(message, transfer);
  });
  self.onmessage = (event: MessageEvent<unknown>): void => {
    if (acceptForwardedLogBatch(event.data)) return;
    if (isWorkerDuplexResponse(event.data)) {
      handleWorkerDuplexResponse(event.data);
      return;
    }
    handleMessage(event.data as TMessage);
  };
}
