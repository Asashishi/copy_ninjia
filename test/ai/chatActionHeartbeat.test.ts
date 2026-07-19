import { describe, expect, mock, test } from "bun:test";

/** chatActionHeartbeat 的生产默认依赖会经 infra/telegram 引入日志转发；测试只
 * 验证心跳控制器本身，禁止启动真实 diskIO Worker。 */
mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: mock((..._args: unknown[]): void => {}),
  onDiskIORespawn: mock((..._args: unknown[]): void => {}),
  relayLogMessage: mock((..._args: unknown[]): void => {}),
}));

const { startChatActionHeartbeat, pumpChatAction } = await import("../../src/ai/chatActionHeartbeat");
import type { ChatActionHeartbeatDependencies } from "../../src/ai/chatActionHeartbeat";
import type { ChatActionHeartbeatEntry } from "../../src/types";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 发送走条目上的串行链（微任务级排队），断言前先把已就绪的微任务全部
 *  排干；宏任务边界保证链上无阻塞的 run 都执行完。 */
function flush(): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, 0);
  });
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
  test("心跳从 idle 起步不发状态；切换挡位时补发对应状态，idle 后 settle 等齐在途请求", async () => {
    const choose = deferred<boolean>();
    const sendTyping = mock(async (_chatId: number): Promise<boolean> => true);
    const sendChooseSticker = mock((_chatId: number): Promise<boolean> => choose.promise);
    const deps = dependencies(sendTyping, sendChooseSticker);
    const heartbeat = startChatActionHeartbeat(123, deps);

    expect(heartbeat.current()).toBe("idle");
    expect(sendTyping).not.toHaveBeenCalled();
    expect(sendChooseSticker).not.toHaveBeenCalled();

    heartbeat.set("typing");
    expect(heartbeat.current()).toBe("typing");
    await flush();
    expect(sendTyping).toHaveBeenCalledWith(123);

    heartbeat.set("choose_sticker");
    expect(heartbeat.current()).toBe("choose_sticker");
    await flush();
    expect(sendChooseSticker).toHaveBeenCalledWith(123);

    heartbeat.set("idle");
    let settled: boolean = false;
    const waiting = heartbeat.settle().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    choose.resolve(true);
    await waiting;
    await heartbeat.stop();
    expect(deps.entries.size).toBe(0);
    expect(heartbeat.current()).toBe("idle");
  });

  test("串行链在执行时重读挡位：发送在途时排队的旧挡位请求随切 idle 坍缩跳过", async () => {
    const typing = deferred<boolean>();
    const sendChooseSticker = mock(async (_chatId: number): Promise<boolean> => true);
    const deps = dependencies(() => typing.promise, sendChooseSticker);
    const heartbeat = startChatActionHeartbeat(456, deps);

    heartbeat.set("typing");
    await flush();
    // typing 请求还挂在网络上时切到 choose_sticker 又立刻切回 idle：排队的
    // choose_sticker 补发执行时重读到 idle 挡，必须整个跳过，不能迟到盖回。
    heartbeat.set("choose_sticker");
    heartbeat.set("idle");

    typing.resolve(true);
    await heartbeat.settle();
    expect(sendChooseSticker).not.toHaveBeenCalled();
    await heartbeat.stop();
  });

  test("节流：同一挡位在间隔内重复 set 只发一次；切过 idle 后重新补发", async () => {
    const sendTyping = mock(async (_chatId: number): Promise<boolean> => true);
    const deps = dependencies(sendTyping, async () => true);
    const heartbeat = startChatActionHeartbeat(789, deps);

    heartbeat.set("typing");
    await flush();
    heartbeat.set("typing");
    await flush();
    expect(sendTyping).toHaveBeenCalledTimes(1);

    // 切 idle 意味着消息落地清掉了聊天状态，节流记忆随之重置：下一段窗口
    // 哪怕还是 typing 挡也要立即补发。
    heartbeat.set("idle");
    heartbeat.set("typing");
    await flush();
    expect(sendTyping).toHaveBeenCalledTimes(2);
    await heartbeat.stop();
  });

  test("挡位归属：并发轮先结束时收回自己的挡位，不遗留给还在跑的轮", async () => {
    const sendChooseSticker = mock(async (_chatId: number): Promise<boolean> => true);
    const deps = dependencies(async () => true, sendChooseSticker);
    const roundA = startChatActionHeartbeat(111, deps);
    const roundB = startChatActionHeartbeat(111, deps);

    roundA.set("choose_sticker");
    await flush();
    expect(sendChooseSticker).toHaveBeenCalledTimes(1);

    // A 轮在选择贴纸挡结束（翻了包没发贴纸）：挡位必须随 stop 收回 idle，
    // B 轮还持有条目，但不该继承 A 遗留的「正在选择贴纸…」被心跳一直重发。
    await roundA.stop();
    expect(deps.entries.get(111)?.action).toBe("idle");
    expect(deps.entries.has(111)).toBe(true);
    expect(roundB.current()).toBe("idle");

    await roundB.stop();
    expect(deps.entries.size).toBe(0);
  });

  test("挡位归属：非持有轮的 set(idle) 不掐灭持有轮亮着的窗口", async () => {
    const deps = dependencies(async () => true, async () => true);
    const roundA = startChatActionHeartbeat(222, deps);
    const roundB = startChatActionHeartbeat(222, deps);

    roundA.set("typing");
    roundB.set("idle");
    expect(deps.entries.get(222)?.action).toBe("typing");
    expect(roundA.current()).toBe("typing");
    // B 轮切非 idle 挡是后写覆盖（Telegram 同时只显示一种状态），归属随之
    // 转移，A 轮视角回到 idle。
    roundB.set("choose_sticker");
    expect(roundA.current()).toBe("idle");
    expect(roundB.current()).toBe("choose_sticker");

    await roundA.stop();
    await roundB.stop();
    expect(deps.entries.size).toBe(0);
  });

  test("发送挂起期间的连续 tick 合并为一发，恢复后不背靠背连发同一状态", async () => {
    const typing = deferred<boolean>();
    const sendTyping = mock((_chatId: number): Promise<boolean> => typing.promise);
    const deps = dependencies(sendTyping, async () => true);
    const heartbeat = startChatActionHeartbeat(654, deps);

    heartbeat.set("typing");
    await flush();
    expect(sendTyping).toHaveBeenCalledTimes(1);

    // 第一发挂在网络上时连续来三个 tick（生产里由 setInterval 驱动，这里
    // 直接调 pumpChatAction 确定性复现）：第一个排队，后两个合并进排队那发。
    const entry = deps.entries.get(654)!;
    pumpChatAction({ chatId: 654, entry, deduplicate: false, dependencies: deps });
    pumpChatAction({ chatId: 654, entry, deduplicate: false, dependencies: deps });
    pumpChatAction({ chatId: 654, entry, deduplicate: false, dependencies: deps });

    typing.resolve(true);
    await heartbeat.settle();
    // 在途那发 + 合并后补的一发，而不是 1 + 3。
    expect(sendTyping).toHaveBeenCalledTimes(2);
    await heartbeat.stop();
  });

  test("排队的切挡补发混入 tick 后降级为必发，强制刷新不被节流吞掉", async () => {
    const typing = deferred<boolean>();
    const sendTyping = mock((_chatId: number): Promise<boolean> => typing.promise);
    const deps = dependencies(sendTyping, async () => true);
    const heartbeat = startChatActionHeartbeat(987, deps);

    heartbeat.set("typing");
    await flush();
    // 可节流的切挡补发先排队，随后一个 tick 合并进来：第一发落定时刚记过
    // 节流账，排队那发若仍按可节流执行会被跳过，tick 的刷新语义要求必发。
    heartbeat.set("typing");
    pumpChatAction({
      chatId: 987,
      entry: deps.entries.get(987)!,
      deduplicate: false,
      dependencies: deps,
    });

    typing.resolve(true);
    await heartbeat.settle();
    expect(sendTyping).toHaveBeenCalledTimes(2);
    await heartbeat.stop();
  });

  test("条目因失败被移除后，串行链上排队的请求坍缩跳过，settle 不再悬挂", async () => {
    const typing = deferred<boolean>();
    const sendChooseSticker = mock(async (_chatId: number): Promise<boolean> => true);
    const deps = dependencies(() => typing.promise, sendChooseSticker, 1);
    const heartbeat = startChatActionHeartbeat(456, deps);
    heartbeat.set("typing");
    await flush();
    heartbeat.set("choose_sticker");

    typing.resolve(false);
    await flush();
    expect(deps.entries.has(456)).toBe(false);

    // 排队的 choose_sticker 补发执行时发现条目已被移除，直接跳过；settle
    // 等齐链上请求后正常返回。
    await heartbeat.settle();
    expect(sendChooseSticker).not.toHaveBeenCalled();
    expect(heartbeat.current()).toBe("idle");
    await heartbeat.stop();
  });

  test("异常中断时 stop 先移除心跳，再等待已经发出的状态请求落定", async () => {
    const typing = deferred<boolean>();
    const deps = dependencies(() => typing.promise, async () => true);
    const heartbeat = startChatActionHeartbeat(789, deps);
    heartbeat.set("typing");
    await flush();

    let stopped: boolean = false;
    const stopping = heartbeat.stop().then(() => {
      stopped = true;
    });
    expect(deps.entries.has(789)).toBe(false);
    await flush();
    expect(stopped).toBe(false);

    typing.resolve(true);
    await stopping;
    expect(stopped).toBe(true);
  });

  test("单次失败不中断心跳，达到连续失败阈值才止损；失败不落节流账", async () => {
    const sendTyping = mock(async (_chatId: number): Promise<boolean> => false);
    const deps = dependencies(sendTyping, async () => true, 3);
    const heartbeat = startChatActionHeartbeat(321, deps);

    // 节流记忆只记真正送达的状态：前一发失败后，同挡位补发不会被「刚发过」
    // 误拦，三连败照常累计到阈值。
    heartbeat.set("typing");
    await flush();
    expect(deps.entries.has(321)).toBe(true);
    heartbeat.set("typing");
    await flush();
    expect(deps.entries.has(321)).toBe(true);
    heartbeat.set("typing");
    await flush();
    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(deps.entries.has(321)).toBe(false);
    expect(heartbeat.current()).toBe("idle");

    await heartbeat.stop();
  });
});
