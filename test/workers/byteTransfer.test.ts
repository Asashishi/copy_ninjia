import { afterAll, expect, test } from "bun:test";
import { superviseDuplexWorker } from "../../packages/infra/supervisedDuplexWorker";
import { telegramWorkerResponseTransfer } from "../../packages/infra/telegram/workerRequests";
import type { SupervisedWorkerHandle } from "../../packages/infra/supervisedWorker";
import type { TelegramWorkerRequest } from "../../packages/types/telegramWorker";
import type { WorkerDuplexInbound } from "../../packages/types/workerDuplex";

/**
 * 真实 Bun Worker 往返验证跨线程字节转移所有权：上传与下载回执都转移整块
 * ArrayBuffer，发送方原缓冲随即 detach；子视图与 SharedArrayBuffer 只复制可见区间。
 */

interface WorkerReport {
  readonly kind: string;
  readonly senderByteLength?: number;
  readonly otherView?: readonly number[];
  readonly stillReadable?: readonly number[];
  readonly bytes?: readonly number[] | null;
}

const uploads: number[][] = [];
const reports: WorkerReport[] = [];
let mainDownloadBytes: Uint8Array | null = null;

const handle: SupervisedWorkerHandle<WorkerDuplexInbound<unknown>> = superviseDuplexWorker<
  unknown,
  WorkerReport,
  TelegramWorkerRequest
>({
  url: new URL("../fixtures/byteTransferWorker.ts", import.meta.url).href,
  label: "Byte transfer test Worker",
  giveUpConsequence: "byte transfer test cannot continue",
  handleRequest: async (request: TelegramWorkerRequest): Promise<unknown> => {
    if (request.operation === "sendPhoto" || request.operation === "sendVoice") {
      uploads.push(Array.from(request.bytes));
      return { message_id: uploads.length };
    }
    if (request.operation === "downloadFile") {
      mainDownloadBytes = new Uint8Array([5, 6, 7]);
      return { status: "ok", bytes: mainDownloadBytes };
    }
    throw new Error(`unexpected operation ${request.operation}`);
  },
  responseTransfer: telegramWorkerResponseTransfer,
  onEvent: (report: WorkerReport): void => {
    reports.push(report);
  },
});
handle.init();

afterAll(async (): Promise<void> => {
  await handle.terminate();
});

async function runInWorker(kind: string): Promise<WorkerReport> {
  const before: number = reports.length;
  expect(handle.post({ kind })).toBeTrue();
  const deadline: number = Date.now() + 5_000;
  while (reports.length === before) {
    if (Date.now() > deadline) throw new Error(`Worker did not report ${kind}`);
    await Bun.sleep(5);
  }
  return reports.at(-1)!;
}

test("Worker 上传图片与语音后发送方缓冲被 detach，主线程收到原字节", async () => {
  for (const kind of ["uploadPhoto", "uploadVoice"]) {
    uploads.length = 0;
    const report: WorkerReport = await runInWorker(kind);
    expect(report.senderByteLength).toBe(0);
    expect(uploads).toEqual([[1, 2, 3, 4]]);
  }
});

test("下载回执转移后主线程侧缓冲被 detach，Worker 收到原字节", async () => {
  const report: WorkerReport = await runInWorker("download");
  expect(report.bytes).toEqual([5, 6, 7]);
  expect(mainDownloadBytes?.buffer.byteLength).toBe(0);
});

test("子视图只复制可见区间，原缓冲与其它视图照常可读", async () => {
  uploads.length = 0;
  const report: WorkerReport = await runInWorker("uploadSubview");
  expect(uploads).toEqual([[1, 2, 3, 4]]);
  expect(report.senderByteLength).toBe(8);
  expect(report.otherView).toEqual([9, 9]);
});

test("SharedArrayBuffer 走复制分支，原缓冲不受影响", async () => {
  uploads.length = 0;
  const report: WorkerReport = await runInWorker("uploadShared");
  expect(uploads).toEqual([[5, 6, 7, 8]]);
  expect(report.senderByteLength).toBe(4);
  expect(report.stillReadable).toEqual([5, 6, 7, 8]);
});
