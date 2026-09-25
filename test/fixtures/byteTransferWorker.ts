/**
 * test/workers/byteTransfer.test.ts 专用的 Worker 入口：挂上业务 Worker 端口，按主线程
 * 指令经真实的 workerTelegramApi 上传或下载字节，并回报发送方缓冲在调用后的长度。
 */
import { installBusinessWorkerPort } from "../../packages/workers/businessWorkerPort";
import {
  downloadTelegramFileFromMain,
  workerTelegramApi,
} from "../../packages/infra/telegram/workerClient";
import type { TelegramWorkerDownloadFileResult } from "../../packages/types/telegramWorker";

declare const self: Worker;

type ByteTransferCommand =
  | { readonly kind: "uploadPhoto" }
  | { readonly kind: "uploadVoice" }
  | { readonly kind: "uploadSubview" }
  | { readonly kind: "uploadShared" }
  | { readonly kind: "download" };

async function run(command: ByteTransferCommand): Promise<void> {
  switch (command.kind) {
    case "uploadPhoto":
    case "uploadVoice": {
      const bytes: Uint8Array = new Uint8Array([1, 2, 3, 4]);
      const buffer: ArrayBuffer = bytes.buffer as ArrayBuffer;
      const file = { bytes, fileName: command.kind === "uploadPhoto" ? "photo.jpg" : "voice.ogg" };
      const sent: Promise<unknown> = command.kind === "uploadPhoto"
        ? workerTelegramApi.sendPhoto(-1001, file)
        : workerTelegramApi.sendVoice(-1001, file);
      const senderByteLength: number = buffer.byteLength;
      await sent;
      self.postMessage({ kind: command.kind, senderByteLength });
      return;
    }
    case "uploadSubview": {
      const backing: Uint8Array = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9]);
      const other: Uint8Array = backing.subarray(0, 2);
      await workerTelegramApi.sendPhoto(-1001, { bytes: backing.subarray(2, 6), fileName: "view.jpg" });
      self.postMessage({ kind: command.kind, senderByteLength: backing.buffer.byteLength, otherView: Array.from(other) });
      return;
    }
    case "uploadShared": {
      const shared: Uint8Array = new Uint8Array(new SharedArrayBuffer(4));
      shared.set([5, 6, 7, 8]);
      await workerTelegramApi.sendPhoto(-1001, { bytes: shared, fileName: "shared.jpg" });
      self.postMessage({ kind: command.kind, senderByteLength: shared.buffer.byteLength, stillReadable: Array.from(shared) });
      return;
    }
    case "download": {
      const result: TelegramWorkerDownloadFileResult = await downloadTelegramFileFromMain({ fileId: "file", purpose: "vision" });
      self.postMessage({ kind: command.kind, bytes: result.status === "ok" ? Array.from(result.bytes) : null });

    }
  }
}

installBusinessWorkerPort<unknown, ByteTransferCommand>((command: ByteTransferCommand): void => {
  void run(command);
});
