/**
 * Anti-Raid Worker 事件在主线程的分派：黑名单移除回执、广告确证与 ad=true 判定
 * 都经 handleAntiRaidWorkerEvent 交给各自的下游 owner，且不回投 Worker。
 */

import { beforeEach, expect, mock, test } from "bun:test";
import type { AdDetectedEvent, AdVerdictTrueEvent } from "../../packages/types/antiRaid/adDetect";
import type { BlockedMembersRemovedEvent } from "../../packages/types/antiRaid/events";

const settleBlockedRemoval = mock((_event: BlockedMembersRemovedEvent): void => {});
const recordBlocklistParticipantReadability = mock((_event: BlockedMembersRemovedEvent): void => {});
const handleAdDetected = mock((_event: AdDetectedEvent): void => {});
const handleAdVerdictTrue = mock((_event: AdVerdictTrueEvent): void => {});

const realSweep = await import("../../packages/infra/blocklist/sweep");
const realParticipantInvalid = await import("../../packages/infra/blocklist/participantInvalid");
const realAdDetect = await import("../../packages/antiRaid/adDetect");
mock.module("../../packages/infra/blocklist/sweep", () => ({ ...realSweep, settleBlockedRemoval }));
mock.module("../../packages/infra/blocklist/participantInvalid", () => ({
  ...realParticipantInvalid,
  recordBlocklistParticipantReadability,
}));
mock.module("../../packages/antiRaid/adDetect", () => ({
  ...realAdDetect,
  handleAdDetected,
  handleAdVerdictTrue,
}));

const { handleAntiRaidWorkerEvent } = await import("../../packages/antiRaid/workerBridge/events");

const posted: unknown[] = [];
function postToWorker(message: unknown): void {
  posted.push(message);
}

beforeEach(() => {
  posted.length = 0;
  for (const mocked of [
    settleBlockedRemoval,
    recordBlocklistParticipantReadability,
    handleAdDetected,
    handleAdVerdictTrue,
  ]) mocked.mockClear();
});

test("黑名单移除回执先结算 outbox，再记录销号可读性", () => {
  const order: string[] = [];
  settleBlockedRemoval.mockImplementationOnce((): void => { order.push("settle"); });
  recordBlocklistParticipantReadability.mockImplementationOnce((): void => { order.push("readability"); });
  const event = { type: "blockedMembersRemoved", chatId: -1001, removalId: 3 } as unknown as BlockedMembersRemovedEvent;

  handleAntiRaidWorkerEvent(event, postToWorker);

  expect(settleBlockedRemoval).toHaveBeenCalledWith(event);
  expect(recordBlocklistParticipantReadability).toHaveBeenCalledWith(event);
  expect(order).toEqual(["settle", "readability"]);
  expect(posted).toEqual([]);
});

test("广告确证交给 handleAdDetected，ad=true 判定交给 handleAdVerdictTrue", () => {
  const detected = { type: "adDetected", chatId: -1001, senderId: 7 } as unknown as AdDetectedEvent;
  const verdict = { type: "adVerdictTrue", chatId: -1001, senderId: 7 } as unknown as AdVerdictTrueEvent;

  handleAntiRaidWorkerEvent(detected, postToWorker);
  handleAntiRaidWorkerEvent(verdict, postToWorker);

  expect(handleAdDetected.mock.calls).toEqual([[detected]]);
  expect(handleAdVerdictTrue.mock.calls).toEqual([[verdict]]);
  expect(settleBlockedRemoval).not.toHaveBeenCalled();
  expect(posted).toEqual([]);
});
