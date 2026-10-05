import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";

const { startChatActionHeartbeat, pumpChatAction } = await import("../../../packages/aiChat/ai/chatActionHeartbeat");
import type {
  ChatActionHeartbeatDependencies,
  ChatActionSendRequest,
} from "../../../packages/aiChat/ai/chatActionHeartbeat";
import type { ChatActionHeartbeatEntry } from "../../../packages/types/aiChat/chatAction";
import { settleBackgroundWork } from "../../helpers/common";

type PhaseSender = (chatId: number, signal?: AbortSignal) => Promise<boolean>;

/** 心跳只有一个发送口（sendChatAction），按挡位分发是本文件自己的事：这样各用例
 *  仍能对「哪个挡位发出去了」单独设桩与断言。 */
function dependencies(
  sendTyping: PhaseSender,
  sendChooseSticker: PhaseSender,
  maxConsecutiveFailures: number = 3
): ChatActionHeartbeatDependencies & { sendUploadPhoto: PhaseSender } {
  const deps: ChatActionHeartbeatDependencies & { sendUploadPhoto: PhaseSender } = {
    entries: new Map<number, ChatActionHeartbeatEntry>(),
    intervalMs: 60_000,
    maxConsecutiveFailures,
    restMs: 0,
    sendUploadPhoto: async (): Promise<boolean> => true,
    sendChatAction: ({ action, chatId, signal }: ChatActionSendRequest): Promise<boolean> => {
      if (action === "typing") return sendTyping(chatId, signal);
      if (action === "upload_photo") return deps.sendUploadPhoto(chatId, signal);
      return sendChooseSticker(chatId, signal);
    },
  };
  return deps;
}

/** 假计时器下 settleBackgroundWork 的 setTimeout(0) 不会自行到点，改为排空微任务。 */
async function flushMicrotasks(): Promise<void> {
  for (let i: number = 0; i < 20; i++) await Promise.resolve();
}

describe("chatActionHeartbeat", () => {
  test("generation signal 贯穿状态请求，新 generation 不复用旧代心跳", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const sendTyping = mock(
      async (_chatId: number, signal?: AbortSignal): Promise<boolean> => {
        observedSignal = signal;
        return await new Promise<boolean>(
          (_resolve, reject: (reason?: unknown) => void): void => {
            signal?.addEventListener("abort", (): void => reject(signal.reason), { once: true });
          }
        );
      }
    );
    const deps = dependencies(sendTyping, async () => true);
    const first = startChatActionHeartbeat({ chatId: 100, messageThreadId: undefined, dependencies: deps, signal: firstController.signal });
    first.set("typing");
    await settleBackgroundWork();

    expect(observedSignal).toBe(firstController.signal);
    firstController.abort(new DOMException("invalidated", "AbortError"));
    await first.stop();

    const second = startChatActionHeartbeat({ chatId: 100, messageThreadId: undefined, dependencies: deps, signal: secondController.signal });
    expect(deps.entries.get(100)?.signal).toBe(secondController.signal);
    // 旧代句柄切挡不会写进新代条目。
    first.set("typing");
    expect(deps.entries.get(100)?.action).toBe("idle");
    await second.stop();
  });

  test("旧代未结束时同群新一代启动：清掉旧代的定时器，旧句柄 stop 不拆新条目", async () => {
    const clearIntervalSpy = spyOn(globalThis, "clearInterval");
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    try {
      const sendTyping = mock(async (_chatId: number): Promise<boolean> => true);
      const deps = dependencies(sendTyping, async () => true);
      deps.restMs = 60_000;
      const first = startChatActionHeartbeat({ chatId: 100, messageThreadId: undefined, dependencies: deps, signal: new AbortController().signal });
      first.set("typing");
      first.set("idle");
      // 静默期内切挡：旧代条目挂上推迟补发的 restTimer。
      first.set("typing");
      const previous: ChatActionHeartbeatEntry = deps.entries.get(100)!;
      expect(previous.restTimer).not.toBeNull();

      const second = startChatActionHeartbeat({ chatId: 100, messageThreadId: undefined, dependencies: deps, signal: new AbortController().signal });
      const current: ChatActionHeartbeatEntry = deps.entries.get(100)!;
      expect(current).not.toBe(previous);
      expect(current.refCount).toBe(1);
      expect(clearIntervalSpy).toHaveBeenCalledWith(previous.timer);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(previous.restTimer);

      await first.stop();
      expect(deps.entries.get(100)).toBe(current);
      second.set("typing");
      await second.stop();
      expect(deps.entries.has(100)).toBe(false);
    } finally {
      clearIntervalSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  test("心跳从 idle 起步不发状态；切换挡位时补发对应状态，idle 后 settle 等齐在途请求", async () => {
    const choose: PromiseWithResolvers<boolean> = Promise.withResolvers<boolean>();
    const sendTyping = mock(async (_chatId: number): Promise<boolean> => true);
    const sendUploadPhoto = mock(async (_chatId: number): Promise<boolean> => true);
    const sendChooseSticker = mock((_chatId: number): Promise<boolean> => choose.promise);
    const deps = dependencies(sendTyping, sendChooseSticker);
    deps.sendUploadPhoto = sendUploadPhoto;
    const heartbeat = startChatActionHeartbeat({ chatId: 123, messageThreadId: undefined, dependencies: deps });

    expect(deps.entries.get(123)?.action).toBe("idle");
    expect(sendTyping).not.toHaveBeenCalled();
    expect(sendUploadPhoto).not.toHaveBeenCalled();
    expect(sendChooseSticker).not.toHaveBeenCalled();

    heartbeat.set("typing");
    expect(deps.entries.get(123)?.action).toBe("typing");
    await settleBackgroundWork();
    expect(sendTyping).toHaveBeenCalledWith(123, undefined);

    heartbeat.set("upload_photo");
    expect(deps.entries.get(123)?.action).toBe("upload_photo");
    await settleBackgroundWork();
    expect(sendUploadPhoto).toHaveBeenCalledWith(123, undefined);

    heartbeat.set("choose_sticker");
    expect(deps.entries.get(123)?.action).toBe("choose_sticker");
    await settleBackgroundWork();
    expect(sendChooseSticker).toHaveBeenCalledWith(123, undefined);

    heartbeat.set("idle");
    let settled: boolean = false;
    const waiting = heartbeat.settle().then(() => {
      settled = true;
    });
    await settleBackgroundWork();
    expect(settled).toBe(false);

    choose.resolve(true);
    await waiting;
    await heartbeat.stop();
    expect(deps.entries.size).toBe(0);
  });

  test("串行链在执行时重读挡位：发送在途时排队的旧挡位请求随切 idle 坍缩跳过", async () => {
    const typing: PromiseWithResolvers<boolean> = Promise.withResolvers<boolean>();
    const sendChooseSticker = mock(async (_chatId: number): Promise<boolean> => true);
    const deps = dependencies(() => typing.promise, sendChooseSticker);
    const heartbeat = startChatActionHeartbeat({ chatId: 456, messageThreadId: undefined, dependencies: deps });

    heartbeat.set("typing");
    await settleBackgroundWork();
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
    const heartbeat = startChatActionHeartbeat({ chatId: 789, messageThreadId: undefined, dependencies: deps });

    heartbeat.set("typing");
    await settleBackgroundWork();
    heartbeat.set("typing");
    await settleBackgroundWork();
    expect(sendTyping).toHaveBeenCalledTimes(1);

    // 切 idle 会重置节流记忆：下一段窗口哪怕还是 typing 挡也要立即补发。
    heartbeat.set("idle");
    heartbeat.set("typing");
    await settleBackgroundWork();
    expect(sendTyping).toHaveBeenCalledTimes(2);
    await heartbeat.stop();
  });

  test("请求在途时切走挡位：这次送达不记节流，消息之后同挡位的补发立即发出", async () => {
    const first: PromiseWithResolvers<boolean> = Promise.withResolvers<boolean>();
    const sendTyping = mock((_chatId: number): Promise<boolean> => Promise.resolve(true));
    sendTyping.mockImplementationOnce((): Promise<boolean> => first.promise);
    const deps = dependencies(sendTyping, async () => true);
    const heartbeat = startChatActionHeartbeat({ chatId: 333, messageThreadId: undefined, dependencies: deps });

    heartbeat.set("typing");
    await settleBackgroundWork();
    // 发送前切 idle、等在途请求落定（消息随后落地会清掉状态）。
    heartbeat.set("idle");
    first.resolve(true);
    await heartbeat.settle();
    heartbeat.set("typing");
    await settleBackgroundWork();
    expect(sendTyping).toHaveBeenCalledTimes(2);
    await heartbeat.stop();
  });

  test("挡位归属：并发轮先结束时收回自己的挡位，不遗留给还在跑的轮", async () => {
    const sendChooseSticker = mock(async (_chatId: number): Promise<boolean> => true);
    const deps = dependencies(async () => true, sendChooseSticker);
    const roundA = startChatActionHeartbeat({ chatId: 111, messageThreadId: undefined, dependencies: deps });
    const roundB = startChatActionHeartbeat({ chatId: 111, messageThreadId: undefined, dependencies: deps });

    roundA.set("choose_sticker");
    await settleBackgroundWork();
    expect(sendChooseSticker).toHaveBeenCalledTimes(1);

    // A 轮在选择贴纸挡结束（翻了包没发贴纸）：挡位必须随 stop 收回 idle，
    // B 轮还持有条目，但不该继承 A 遗留的「正在选择贴纸…」被心跳一直重发。
    await roundA.stop();
    expect(deps.entries.get(111)?.action).toBe("idle");
    expect(deps.entries.has(111)).toBe(true);
    expect(deps.entries.get(111)?.owner).toBeNull();

    await roundB.stop();
    expect(deps.entries.size).toBe(0);
  });

  test("挡位归属：非持有轮的 set(idle) 不掐灭持有轮亮着的窗口", async () => {
    const deps = dependencies(async () => true, async () => true);
    const roundA = startChatActionHeartbeat({ chatId: 222, messageThreadId: undefined, dependencies: deps });
    const roundB = startChatActionHeartbeat({ chatId: 222, messageThreadId: undefined, dependencies: deps });

    roundA.set("typing");
    roundB.set("idle");
    expect(deps.entries.get(222)?.action).toBe("typing");
    // B 轮切非 idle 挡是后写覆盖（Telegram 同时只显示一种状态），归属随之
    // 转移，A 轮的 set(idle) 不再能收回 B 轮的挡位。
    roundB.set("choose_sticker");
    roundA.set("idle");
    expect(deps.entries.get(222)?.action).toBe("choose_sticker");

    await roundA.stop();
    await roundB.stop();
    expect(deps.entries.size).toBe(0);
  });

  test("发送挂起期间的连续 tick 合并为一发，恢复后不背靠背连发同一状态", async () => {
    const typing: PromiseWithResolvers<boolean> = Promise.withResolvers<boolean>();
    const sendTyping = mock((_chatId: number): Promise<boolean> => typing.promise);
    const deps = dependencies(sendTyping, async () => true);
    const heartbeat = startChatActionHeartbeat({ chatId: 654, messageThreadId: undefined, dependencies: deps });

    heartbeat.set("typing");
    await settleBackgroundWork();
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
    const typing: PromiseWithResolvers<boolean> = Promise.withResolvers<boolean>();
    const sendTyping = mock((_chatId: number): Promise<boolean> => typing.promise);
    const deps = dependencies(sendTyping, async () => true);
    const heartbeat = startChatActionHeartbeat({ chatId: 987, messageThreadId: undefined, dependencies: deps });

    heartbeat.set("typing");
    await settleBackgroundWork();
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
    const typing: PromiseWithResolvers<boolean> = Promise.withResolvers<boolean>();
    const sendChooseSticker = mock(async (_chatId: number): Promise<boolean> => true);
    const deps = dependencies(() => typing.promise, sendChooseSticker, 1);
    const heartbeat = startChatActionHeartbeat({ chatId: 456, messageThreadId: undefined, dependencies: deps });
    heartbeat.set("typing");
    await settleBackgroundWork();
    heartbeat.set("choose_sticker");

    typing.resolve(false);
    await settleBackgroundWork();
    expect(deps.entries.has(456)).toBe(false);

    // 排队的 choose_sticker 补发执行时发现条目已被移除，直接跳过；settle
    // 等齐链上请求后正常返回。
    await heartbeat.settle();
    expect(sendChooseSticker).not.toHaveBeenCalled();
    await heartbeat.stop();
  });

  test("异常中断时 stop 先移除心跳，再等待已经发出的状态请求落定", async () => {
    const typing: PromiseWithResolvers<boolean> = Promise.withResolvers<boolean>();
    const deps = dependencies(() => typing.promise, async () => true);
    const heartbeat = startChatActionHeartbeat({ chatId: 789, messageThreadId: undefined, dependencies: deps });
    heartbeat.set("typing");
    await settleBackgroundWork();

    let stopped: boolean = false;
    const stopping = heartbeat.stop().then(() => {
      stopped = true;
    });
    expect(deps.entries.has(789)).toBe(false);
    await settleBackgroundWork();
    expect(stopped).toBe(false);

    typing.resolve(true);
    await stopping;
    expect(stopped).toBe(true);
  });

  test("单次失败不中断心跳，达到连续失败阈值才止损；失败不落节流账", async () => {
    const sendTyping = mock(async (_chatId: number): Promise<boolean> => false);
    const deps = dependencies(sendTyping, async () => true, 3);
    const heartbeat = startChatActionHeartbeat({ chatId: 321, messageThreadId: undefined, dependencies: deps });

    // 节流记忆只记真正送达的状态：前一发失败后，同挡位补发不会被「刚发过」
    // 误拦，三连败照常累计到阈值。
    heartbeat.set("typing");
    await settleBackgroundWork();
    expect(deps.entries.has(321)).toBe(true);
    heartbeat.set("typing");
    await settleBackgroundWork();
    expect(deps.entries.has(321)).toBe(true);
    heartbeat.set("typing");
    await settleBackgroundWork();
    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(deps.entries.has(321)).toBe(false);

    await heartbeat.stop();
  });

  describe("状态之间的静默", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    test("切 idle 后静默期内切挡只登记挡位并返回剩余静默，到点补发当时的挡位", async () => {
      jest.useFakeTimers();
      const sendTyping = mock(async (_chatId: number): Promise<boolean> => true);
      const sendChooseSticker = mock(async (_chatId: number): Promise<boolean> => true);
      const deps = dependencies(sendTyping, sendChooseSticker);
      deps.restMs = 500;
      const heartbeat = startChatActionHeartbeat({ chatId: 505, messageThreadId: undefined, dependencies: deps });

      expect(heartbeat.set("typing")).toBe(0);
      await flushMicrotasks();
      expect(sendTyping).toHaveBeenCalledTimes(1);

      expect(heartbeat.set("idle")).toBe(0);
      jest.advanceTimersByTime(200);
      const rest: number = heartbeat.set("typing");
      expect(rest).toBeGreaterThanOrEqual(300);
      expect(rest).toBeLessThanOrEqual(301);
      heartbeat.set("choose_sticker");
      jest.advanceTimersByTime(299);
      await flushMicrotasks();
      expect(sendTyping).toHaveBeenCalledTimes(1);
      expect(sendChooseSticker).not.toHaveBeenCalled();

      jest.advanceTimersByTime(2);
      await flushMicrotasks();
      expect(sendTyping).toHaveBeenCalledTimes(1);
      expect(sendChooseSticker).toHaveBeenCalledTimes(1);
      await heartbeat.stop();
    });

    test("静默从最后一次切 idle 算起：落地后再切 idle 会顺延", async () => {
      jest.useFakeTimers();
      const sendTyping = mock(async (_chatId: number): Promise<boolean> => true);
      const deps = dependencies(sendTyping, async () => true);
      deps.restMs = 500;
      const heartbeat = startChatActionHeartbeat({ chatId: 506, messageThreadId: undefined, dependencies: deps });

      heartbeat.set("idle");
      jest.advanceTimersByTime(300);
      heartbeat.set("idle");
      heartbeat.set("typing");
      jest.advanceTimersByTime(300);
      await flushMicrotasks();
      expect(sendTyping).not.toHaveBeenCalled();

      jest.advanceTimersByTime(201);
      await flushMicrotasks();
      expect(sendTyping).toHaveBeenCalledTimes(1);
      await heartbeat.stop();
    });

    test("静默期内又切回 idle 的挡位到点不补发；非持有轮的 idle 不开始静默", async () => {
      jest.useFakeTimers();
      const sendTyping = mock(async (_chatId: number): Promise<boolean> => true);
      const sendChooseSticker = mock(async (_chatId: number): Promise<boolean> => true);
      const deps = dependencies(sendTyping, sendChooseSticker);
      deps.restMs = 500;
      const roundA = startChatActionHeartbeat({ chatId: 507, messageThreadId: undefined, dependencies: deps });
      const roundB = startChatActionHeartbeat({ chatId: 507, messageThreadId: undefined, dependencies: deps });

      roundA.set("typing");
      await flushMicrotasks();
      roundB.set("idle");
      expect(roundA.set("choose_sticker")).toBe(0);
      await flushMicrotasks();
      expect(sendTyping).toHaveBeenCalledTimes(1);
      expect(sendChooseSticker).toHaveBeenCalledTimes(1);

      roundA.set("idle");
      roundA.set("typing");
      roundA.set("idle");
      jest.advanceTimersByTime(600);
      await flushMicrotasks();
      expect(sendTyping).toHaveBeenCalledTimes(1);

      await roundA.stop();
      await roundB.stop();
    });

    test("静默开始前已排队的请求轮到时仍在静默期内就跳过，静默结束才补发当时的挡位", async () => {
      jest.useFakeTimers();
      const inFlight = Promise.withResolvers<boolean>();
      const sendTyping = mock((_chatId: number): Promise<boolean> => inFlight.promise);
      const sendChooseSticker = mock(async (_chatId: number): Promise<boolean> => true);
      const deps = dependencies(sendTyping, sendChooseSticker);
      deps.restMs = 500;
      const sendUploadPhoto = mock(async (): Promise<boolean> => true);
      deps.sendUploadPhoto = sendUploadPhoto;
      const heartbeat = startChatActionHeartbeat({ chatId: 509, messageThreadId: undefined, dependencies: deps });

      heartbeat.set("typing");
      await flushMicrotasks();
      expect(sendTyping).toHaveBeenCalledTimes(1);
      // 第一发还在途：这一发排在它后面。
      heartbeat.set("choose_sticker");
      heartbeat.set("idle");
      expect(heartbeat.set("upload_photo")).toBeGreaterThan(0);
      inFlight.resolve(true);
      await flushMicrotasks();
      expect(sendChooseSticker).not.toHaveBeenCalled();
      expect(sendUploadPhoto).not.toHaveBeenCalled();

      jest.advanceTimersByTime(501);
      await flushMicrotasks();
      expect(sendUploadPhoto).toHaveBeenCalledTimes(1);
      await heartbeat.stop();
    });

    test("静默期内不做定时重发，静默结束由推迟的补发接上", async () => {
      jest.useFakeTimers();
      const sendTyping = mock(async (_chatId: number): Promise<boolean> => true);
      const deps = dependencies(sendTyping, async () => true);
      deps.intervalMs = 100;
      deps.restMs = 500;
      const heartbeat = startChatActionHeartbeat({ chatId: 508, messageThreadId: undefined, dependencies: deps });

      heartbeat.set("typing");
      await flushMicrotasks();
      jest.advanceTimersByTime(100);
      await flushMicrotasks();
      expect(sendTyping).toHaveBeenCalledTimes(2);

      heartbeat.set("idle");
      heartbeat.set("typing");
      jest.advanceTimersByTime(400);
      await flushMicrotasks();
      expect(sendTyping).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(101);
      await flushMicrotasks();
      expect(sendTyping).toHaveBeenCalledTimes(3);
      await heartbeat.stop();
    });
  });
});
