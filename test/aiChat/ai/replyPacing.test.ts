import { beforeEach, expect, mock, test } from "bun:test";

const sleep = mock(async (_ms: number, _signal?: AbortSignal): Promise<void> => {});
mock.module("../../../packages/libs/sleep", () => ({ sleep }));

const { createDirectPacing, createSimulatedPause } = await import("../../../packages/aiChat/ai/tools/replyToolset/pacing");
const { REPLY_INVALIDATED_TOOL_ERROR } = await import("../../../packages/consts/tools");
import type { ChatActionControl, ChatActionPhase } from "../../../packages/types/aiChat/chatAction";

const phases: ChatActionPhase[] = [];
/** 心跳替身切到非 idle 挡时返回的剩余静默。 */
let restMs: number = 0;
const chatAction: ChatActionControl = {
  set: (phase: ChatActionPhase): number => {
    phases.push(phase);
    return phase === "idle" ? 0 : restMs;
  },
  settle: async (): Promise<void> => {},
};

function sleepDurations(): unknown[] {
  return sleep.mock.calls.map((call: unknown[]) => call[0]);
}

beforeEach(() => {
  phases.length = 0;
  restMs = 0;
  sleep.mockReset();
});

test("有序并行轮：每个动作都切挡并停顿", async () => {
  const pause = createSimulatedPause(chatAction);
  expect(await pause("typing", 1_200)).toBeNull();
  expect(await pause("choose_sticker", 800)).toBeNull();
  expect(phases).toEqual(["typing", "choose_sticker"]);
  expect(sleepDurations()).toEqual([1_200, 800]);
});

test("停顿顺延心跳返回的剩余静默，挡位的可见时长不变", async () => {
  restMs = 300;
  const pause = createSimulatedPause(chatAction);
  expect(await pause("typing", 1_200)).toBeNull();
  expect(sleepDurations()).toEqual([1_500]);
});

test("直接轮：「正在输入」请求交回的第一条文字只切挡，同一动作里的下一次停顿与后续动作照常停顿", async () => {
  const pacing = createDirectPacing(chatAction);
  pacing.beforeModelRequest("typing");
  const text = pacing.startAction(true);
  const sticker = pacing.startAction(false);
  pacing.chainStarted();
  expect(await text("typing", 1_200)).toBeNull();
  expect(await text("typing", 900)).toBeNull();
  expect(await sticker("choose_sticker", 800)).toBeNull();
  pacing.chainDrained();
  expect(phases).toEqual(["typing", "typing", "typing", "choose_sticker"]);
  expect(sleepDurations()).toEqual([900, 800]);
});

test("直接轮：「正在输入」请求交回的第一个动作不是文字时，它的「正在输入」停顿照常等待", async () => {
  const pacing = createDirectPacing(chatAction);
  pacing.beforeModelRequest("typing");
  // 生图：先亮发送图片，图片落地后独立图注再亮「正在输入」。
  const image = pacing.startAction(false);
  pacing.chainStarted();
  chatAction.set("upload_photo");
  chatAction.set("idle");
  expect(await image("typing", 400)).toBeNull();
  expect(phases).toEqual(["typing", "upload_photo", "idle", "typing"]);
  expect(sleepDurations()).toEqual([400]);
});

test("直接轮：挑贴纸请求亮选择状态且贴纸照常停顿；不亮状态的请求交回的文字照常停顿", async () => {
  const pacing = createDirectPacing(chatAction);
  pacing.beforeModelRequest("choose_sticker");
  const sticker = pacing.startAction(false);
  pacing.chainStarted();
  expect(await sticker("choose_sticker", 700)).toBeNull();
  pacing.chainDrained();
  pacing.beforeModelRequest("idle");
  const text = pacing.startAction(true);
  pacing.chainStarted();
  expect(await text("typing", 500)).toBeNull();
  expect(phases).toEqual(["choose_sticker", "choose_sticker", "typing"]);
  expect(sleepDurations()).toEqual([700, 500]);
});

test("直接轮：同批前一个动作接走请求挡位后，「正在输入」请求交回的文字也照常停顿", async () => {
  const pacing = createDirectPacing(chatAction);
  pacing.beforeModelRequest("typing");
  pacing.startAction(false);
  pacing.chainStarted();
  expect(await pacing.startAction(true)("typing", 600)).toBeNull();
  expect(phases).toEqual(["typing", "typing"]);
  expect(sleepDurations()).toEqual([600]);
});

test("直接轮：串行链忙时请求的挡位不亮，链排空后亮起，模型阶段结束时收回", async () => {
  const pacing = createDirectPacing(chatAction);
  pacing.beforeModelRequest("typing");
  const first = pacing.startAction(true);
  pacing.chainStarted();
  expect(await first("typing", 1_000)).toBeNull();
  // 链还在发第一条时模型已被再请求：挑贴纸的挡位不盖掉链上的状态。
  pacing.beforeModelRequest("choose_sticker");
  expect(phases).toEqual(["typing", "typing"]);
  chatAction.set("idle");
  pacing.chainDrained();
  expect(phases).toEqual(["typing", "typing", "idle", "choose_sticker"]);
  pacing.endModel();
  expect(phases).toEqual(["typing", "typing", "idle", "choose_sticker", "idle"]);
  expect(sleepDurations()).toEqual([]);
});

test("直接轮：后台补发的步骤不接走请求挡位，链排空后请求的挡位重新亮起", () => {
  const pacing = createDirectPacing(chatAction);
  pacing.beforeModelRequest("choose_sticker");
  // 转入后台的语音合成好后排进链：链上的步骤掌管状态，结束时切回 idle。
  pacing.chainStarted();
  chatAction.set("record_voice");
  chatAction.set("idle");
  pacing.chainDrained();
  // 链上的步骤已经盖掉请求的挡位：模型阶段结束前只由排空重新亮起的那一次收回。
  pacing.endModel();
  pacing.endModel();
  expect(phases).toEqual(["choose_sticker", "record_voice", "idle", "choose_sticker", "idle"]);
});

test("直接轮：模型阶段结束时只收回还没被动作接走的请求挡位", () => {
  const pacing = createDirectPacing(chatAction);
  pacing.endModel();
  pacing.beforeModelRequest("typing");
  pacing.startAction(false);
  pacing.chainStarted();
  pacing.endModel();
  pacing.chainDrained();
  pacing.beforeModelRequest("idle");
  pacing.endModel();
  expect(phases).toEqual(["typing"]);

  phases.length = 0;
  pacing.beforeModelRequest("choose_sticker");
  pacing.endModel();
  pacing.endModel();
  expect(phases).toEqual(["choose_sticker", "idle"]);
});

test("直接轮：不亮状态的请求收回上一次请求亮着、没被动作接走的挡位", () => {
  const pacing = createDirectPacing(chatAction);
  pacing.beforeModelRequest("choose_sticker");
  pacing.beforeModelRequest("idle");
  pacing.beforeModelRequest("idle");
  pacing.endModel();
  expect(phases).toEqual(["choose_sticker", "idle"]);
});

test("停顿期间本轮作废时交回作废错误", async () => {
  const controller = new AbortController();
  controller.abort();
  sleep.mockImplementation(async (_ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted === true) throw new Error("aborted");
  });
  const pacing = createDirectPacing(chatAction, controller.signal);
  expect(JSON.parse((await pacing.startAction(false)("typing", 100))!).error).toBe(REPLY_INVALIDATED_TOOL_ERROR);
});
