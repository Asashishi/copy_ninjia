/**
 * 发送调度器的固定种子随机回归：随机混合发送、相册、批量复制、删除、429、网络失败、调用方取消与
 * 中途排空，跑完后核对每聊天单槽在途与全部计数、车道、轮转队列、定时器归零。
 */

import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import type { RawApi, Transformer } from "grammy";
import { telegramOutboundGateState } from "../../packages/cache/main/telegram";
import { sendChatLanes, sendGlobalRing, sendSchedulerState } from "../../packages/cache/main/telegramSend";
import { telegramOutboundGate } from "../../packages/infra/telegram/outboundGate";
import { drainTelegramOutbound, initTelegramOutbound } from "../../packages/infra/telegram/outboundLifecycle";
import { resetTelegramOutboundGateState } from "../helpers/telegramOutboundGate";

type PreviousCall = Parameters<Transformer<RawApi>>[0];

/** 一组随机场景：种子与（可选的）中途排空步序号。 */
interface FuzzCase {
  readonly seed: number;
  readonly drainAtStep: number | undefined;
}

const STEPS: number = 200;
const SETTLE_ROUNDS: number = 400;
const CHATS: readonly (number | string)[] = [-1001, -1002, 42, "@Chan"];
const CASES: readonly FuzzCase[] = [
  { seed: 1, drainAtStep: undefined },
  { seed: 7, drainAtStep: undefined },
  { seed: 23, drainAtStep: undefined },
  { seed: 5, drainAtStep: 90 },
];

/** 线性同余伪随机数，输出 [0, 1)。 */
function random(seed: number): () => number {
  let state: number = seed >>> 0;
  return (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

async function flush(): Promise<void> {
  for (let tick: number = 0; tick < 12; tick++) await Promise.resolve();
}

beforeEach((): void => {
  jest.useFakeTimers();
  resetTelegramOutboundGateState();
  initTelegramOutbound();
});

afterEach(async (): Promise<void> => {
  await drainTelegramOutbound(0);
  resetTelegramOutboundGateState();
  jest.useRealTimers();
});

for (const { seed, drainAtStep } of CASES) {
  test(`种子 ${seed}${drainAtStep === undefined ? "" : `（第 ${drainAtStep} 步排空）`}：单槽在途，结束后计数与车道全部归零`, async (): Promise<void> => {
    const rand: () => number = random(seed);
    const inFlightByChat: Map<unknown, number> = new Map<unknown, number>();
    let maxInFlightPerChat: number = 0;
    const previous: PreviousCall = ((method: string, payload: { chat_id: unknown }): Promise<unknown> => {
      const counted: boolean = method !== "deleteMessage";
      const key: unknown = typeof payload.chat_id === "string" ? payload.chat_id.toLowerCase() : payload.chat_id;
      if (counted) {
        const current: number = (inFlightByChat.get(key) ?? 0) + 1;
        inFlightByChat.set(key, current);
        maxInFlightPerChat = Math.max(maxInFlightPerChat, current);
      }
      const delay: number = Math.floor(rand() * 50);
      const outcome: number = rand();
      return new Promise<unknown>((resolve: (value: unknown) => void, reject: (reason: unknown) => void): void => {
        setTimeout((): void => {
          if (counted) inFlightByChat.set(key, (inFlightByChat.get(key) ?? 1) - 1);
          if (outcome < 0.15) resolve({ ok: false, error_code: 429, parameters: { retry_after: 1 + Math.floor(rand() * 3) } });
          else if (outcome < 0.25) reject(new Error("network failure"));
          else resolve({ ok: true, result: { message_id: 1 } });
        }, delay);
      });
    }) as PreviousCall;
    const gate: Transformer<RawApi> = telegramOutboundGate();
    const requests: Promise<unknown>[] = [];
    let settled: number = 0;
    const track = (request: Promise<unknown>): void => {
      requests.push(request.then((): void => { settled++; }, (): void => { settled++; }));
    };

    for (let step: number = 0; step < STEPS; step++) {
      const action: number = rand();
      if (action < 0.7) {
        const chat: number | string = CHATS[Math.floor(rand() * CHATS.length)]!;
        const kind: number = rand();
        const method: keyof RawApi = kind < 0.1 ? "sendMediaGroup" : kind < 0.15 ? "copyMessages" : "sendMessage";
        const payload: Record<string, unknown> = { chat_id: chat, text: `m${step}` };
        if (method === "sendMediaGroup") payload.media = new Array(1 + Math.floor(rand() * 6)).fill({});
        if (method === "copyMessages") payload.message_ids = new Array(1 + Math.floor(rand() * 6)).fill(1);
        const controller: AbortController = new AbortController();
        track(gate(previous, method, payload as never, controller.signal as never) as Promise<unknown>);
        if (rand() < 0.15) setTimeout((): void => controller.abort(), Math.floor(rand() * 400));
      } else if (action < 0.8) {
        track(gate(previous, "deleteMessage", { chat_id: -1001, message_id: 1 } as never) as Promise<unknown>);
      }
      jest.advanceTimersByTime(Math.floor(rand() * 40));
      await flush();
      if (step === drainAtStep) {
        await drainTelegramOutbound(0);
        await flush();
      }
    }
    for (let round: number = 0; round < SETTLE_ROUNDS; round++) {
      jest.advanceTimersByTime(1_000);
      await flush();
    }
    // 模拟时钟推进完毕时每个请求都已结算；漏结算的请求让这条断言直接失败，而不是挂到用例超时。
    expect(settled).toBe(requests.length);
    expect(maxInFlightPerChat).toBeLessThanOrEqual(1);
    expect(telegramOutboundGateState.activeCount).toBe(0);
    expect(telegramOutboundGateState.retryPendingCount).toBe(0);
    expect(telegramOutboundGateState.lanes.message.activeCount).toBe(0);
    expect(telegramOutboundGateState.lanes.message.pendingCount).toBe(0);
    expect(telegramOutboundGateState.activeJobs.size).toBe(0);
    expect(sendSchedulerState.queuedTotal).toBe(0);
    expect(sendChatLanes.size).toBe(0);
    expect(sendGlobalRing.size).toBe(0);
    expect(sendSchedulerState.globalTimer).toBeNull();
  });
}
