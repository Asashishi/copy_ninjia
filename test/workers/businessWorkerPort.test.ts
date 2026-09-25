import { afterAll, beforeEach, expect, mock, test } from "bun:test";

interface PostedMessage {
  readonly args: readonly unknown[];
}

const posted: PostedMessage[] = [];
const workerGlobal = globalThis as unknown as {
  postMessage: (...args: unknown[]) => void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
};
const originalPostMessage = workerGlobal.postMessage;
workerGlobal.postMessage = (...args: unknown[]): void => {
  posted.push({ args });
};

const { installBusinessWorkerPort } = await import("../../packages/workers/businessWorkerPort");
const { requestMainThread } = await import("../../packages/libs/workerDuplex");
const { currentTelegramApi } = await import("../../packages/infra/telegram/client");
const { workerTelegramApi } = await import("../../packages/infra/telegram/workerClient");

const handled: unknown[] = [];
const handleMessage = mock((message: unknown): void => {
  handled.push(message);
});
installBusinessWorkerPort<unknown, unknown>(handleMessage);

function deliver(data: unknown): void {
  workerGlobal.onmessage!({ data } as MessageEvent<unknown>);
}

function lastRequestId(): number {
  const message = posted.at(-1)!.args[0] as { __duplex: string; requestId: number };
  expect(message.__duplex).toBe("request");
  return message.requestId;
}

beforeEach((): void => {
  posted.length = 0;
  handled.length = 0;
  handleMessage.mockClear();
});

afterAll((): void => {
  workerGlobal.postMessage = originalPostMessage;
  workerGlobal.onmessage = null;
});

test("安装经主线程代理的 Telegram 能力面", () => {
  expect(currentTelegramApi()).toBe(workerTelegramApi);
});

test("双工请求没有转移列表时只传消息本身，有转移列表时原样传给 postMessage", async () => {
  const plain: Promise<unknown> = requestMainThread({ operation: "plain" });
  expect(posted.at(-1)!.args).toHaveLength(1);
  deliver({ __duplex: "response", requestId: lastRequestId(), ok: true, value: 1, error: undefined });
  await expect(plain).resolves.toBe(1);

  const buffer: ArrayBuffer = new ArrayBuffer(8);
  const withTransfer: Promise<unknown> = requestMainThread({ operation: "bytes" }, undefined, [buffer]);
  expect(posted.at(-1)!.args).toHaveLength(2);
  expect(posted.at(-1)!.args[1]).toEqual([buffer]);
  deliver({ __duplex: "response", requestId: lastRequestId(), ok: true, value: 2, error: undefined });
  await expect(withTransfer).resolves.toBe(2);
});

test("入站消息按日志回执、双工回包、领域消息的顺序路由", async () => {
  deliver({ __logBatchAccepted: 1 });
  expect(handleMessage).not.toHaveBeenCalled();

  const pending: Promise<unknown> = requestMainThread({ operation: "route" });
  deliver({ __duplex: "response", requestId: lastRequestId(), ok: true, value: "done", error: undefined });
  await expect(pending).resolves.toBe("done");
  expect(handleMessage).not.toHaveBeenCalled();

  const domainMessage = { type: "domain", value: 3 };
  deliver(domainMessage);
  expect(handled).toEqual([domainMessage]);
});
