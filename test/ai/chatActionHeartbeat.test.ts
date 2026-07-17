import { describe, expect, mock, test } from "bun:test";

/** chatActionHeartbeat 的生产默认依赖会经 infra/telegram 引入日志转发；测试只
 * 验证心跳控制器本身，禁止启动真实 diskIO Worker。 */
mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: mock((..._args: unknown[]): void => {}),
  onDiskIORespawn: mock((..._args: unknown[]): void => {}),
  relayLogMessage: mock((..._args: unknown[]): void => {}),
}));

const { startChatActionHeartbeat } = await import("../../src/ai/chatActionHeartbeat");
import type { ChatActionHeartbeatDependencies } from "../../src/ai/chatActionHeartbeat";
import type { ChatActionHeartbeatEntry } from "../../src/types";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dependencies(
  sendTyping: (chatId: number) => Promise<boolean>,
  sendChooseSticker: (chatId: number) => Promise<boolean>,
  maxConsecutiveFailures: number = 3
): ChatActionHeartbeatDependencies {
  return {
    entries: new Map<number, ChatActionHeartbeatEntry>(),
    intervalMs: 60_000,
    maxConsecutiveFailures,
    sendTyping,
    sendChooseSticker,
  };
}

describe("chatActionHeartbeat", () => {
  test("切换挡位时立即发送对应状态，idle 后 settle 等齐在途请求", async () => {
    const choose = deferred<boolean>();
    const sendTyping = mock(async (_chatId: number): Promise<boolean> => true);
    const sendChooseSticker = mock((_chatId: number): Promise<boolean> => choose.promise);
    const deps = dependencies(sendTyping, sendChooseSticker);
    const heartbeat = startChatActionHeartbeat(123, deps);

    expect(sendTyping).toHaveBeenCalledWith(123);
    heartbeat.set("choose_sticker");
    expect(sendChooseSticker).toHaveBeenCalledWith(123);
    heartbeat.set("idle");

    let settled: boolean = false;
    const waiting = heartbeat.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    choose.resolve(true);
    await waiting;
    await heartbeat.stop();
    expect(deps.entries.size).toBe(0);
  });

  test("条目因失败被移除后，发送前 settle 仍等待本代其他请求，防止消息后迟到", async () => {
    const typing = deferred<boolean>();
    const choose = deferred<boolean>();
    const deps = dependencies(() => typing.promise, () => choose.promise, 1);
    const heartbeat = startChatActionHeartbeat(456, deps);
    heartbeat.set("choose_sticker");

    typing.resolve(false);
    await typing.promise;
    await Promise.resolve();
    expect(deps.entries.has(456)).toBe(false);

    let settled: boolean = false;
    const waiting = heartbeat.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    choose.resolve(true);
    await waiting;
    expect(settled).toBe(true);
    await heartbeat.stop();
  });

  test("异常中断时 stop 先移除心跳，再等待已经发出的状态请求落定", async () => {
    const typing = deferred<boolean>();
    const deps = dependencies(() => typing.promise, async () => true);
    const heartbeat = startChatActionHeartbeat(789, deps);

    let stopped: boolean = false;
    const stopping = heartbeat.stop().then(() => {
      stopped = true;
    });
    expect(deps.entries.has(789)).toBe(false);
    await Promise.resolve();
    expect(stopped).toBe(false);

    typing.resolve(true);
    await stopping;
    expect(stopped).toBe(true);
  });

  test("单次失败不中断心跳，达到连续失败阈值才止损", async () => {
    const sendTyping = mock(async (_chatId: number): Promise<boolean> => false);
    const deps = dependencies(sendTyping, async () => true, 3);
    const heartbeat = startChatActionHeartbeat(321, deps);

    await Promise.resolve();
    expect(deps.entries.has(321)).toBe(true);
    heartbeat.set("typing");
    await Promise.resolve();
    expect(deps.entries.has(321)).toBe(true);
    heartbeat.set("typing");
    await Promise.resolve();
    expect(deps.entries.has(321)).toBe(false);

    await heartbeat.stop();
  });
});
