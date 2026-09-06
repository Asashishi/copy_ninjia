import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import type { ChatMember } from "grammy/types";
import { diskIORuntime } from "../../packages/cache/main/diskIO";
import { wedChats, wedRuntime } from "../../packages/cache/main/wed";
import { wedMemberReview } from "../../packages/cache/main/wedMemberReview";
import { resetWedMemberStates, wedMemberStates } from "../../packages/cache/main/wedMembers";
import { telegramApiState } from "../../packages/cache/perThread/telegramApi";
import { enableWedMemberReview } from "../../packages/commands/wed/memberReview";
import { observeWedMembers } from "../../packages/commands/wed/members";
import { flushWedMembers, hydrateWedMembers, removeWedMember } from "../../packages/commands/wed/persistence";
import { drainWedRuntime, initWedRuntime, quiesceWedRuntime } from "../../packages/commands/wed/runtime";
import { WED_OPERATION_TIMEOUT_MS } from "../../packages/consts/wed";
import * as diskIO from "../../packages/infra/diskIO";
import { logger } from "../../packages/infra/logger";
import { getOrCreateChatState } from "../../packages/infra/storage/stateStore";
import * as monotonic from "../../packages/libs/monotonicDeadline";

const DAY: string = "2026-09-07";
const MIDNIGHT: number = Date.parse(`${DAY}T00:00:00+09:00`);
const probe = mock(async (_chatId: number, userId: number, _signal?: AbortSignal): Promise<ChatMember> => member(userId));
const post = spyOn(diskIO, "postDiskIO");
const errorLog = spyOn(logger, "error");
const now = spyOn(monotonic, "monotonicNow");
const gates: ReturnType<typeof Promise.withResolvers<ChatMember>>[] = [];

function member(userId: number, status: ChatMember["status"] = "member", present: boolean = true): ChatMember {
  return { status, user: { id: userId, first_name: "群友", is_bot: false }, is_member: present } as ChatMember;
}

function midnight(day: string = DAY): void {
  for (const listener of diskIORuntime.midnightMaintenanceListeners) listener({ type: "midnightMaintenance", day });
}

function heldProbe(): ReturnType<typeof Promise.withResolvers<ChatMember>> {
  const gate = Promise.withResolvers<ChatMember>();
  gates.push(gate);
  probe.mockImplementationOnce((): Promise<ChatMember> => gate.promise);
  return gate;
}

/** 假时钟推进后排空 API 归一化、复核与任务登记的 Promise 续体。 */
async function tick(milliseconds: number = 0): Promise<void> {
  if (milliseconds > 0) jest.advanceTimersByTime(milliseconds);
  for (let turn: number = 0; turn < 20; turn++) await Promise.resolve();
}

function speak(userId: number): void {
  const chat = { id: -1001, type: "supergroup" };
  observeWedMembers({ chat, message: { chat, from: { id: userId, is_bot: false }, text: "hi" } } as never);
}

beforeEach((): void => {
  jest.useFakeTimers({ now: MIDNIGHT });
  now.mockImplementation((): number => Date.now());
  initWedRuntime();
  getOrCreateChatState(-1001).isInitEnabled = true;
  hydrateWedMembers(new Map([[-1001, new Set([1, 2])]]));
  for (const fn of [probe, post, errorLog]) fn.mockClear();
  probe.mockImplementation(async (_chatId: number, userId: number): Promise<ChatMember> => member(userId));
  post.mockReturnValue(true);
  errorLog.mockImplementation((): void => {});
  telegramApiState.current = { getChatMember: probe } as never;
});

afterEach(async (): Promise<void> => {
  quiesceWedRuntime();
  for (const gate of gates) gate.resolve(member(1));
  await Promise.allSettled(wedRuntime.current!.tasks);
  resetWedMemberStates();
  gates.length = 0;
  telegramApiState.current = null;
  jest.useRealTimers();
});

test("统一午夜通知等待 Bot 就绪，同日去重，次日继续；无需交互缓存", async (): Promise<void> => {
  hydrateWedMembers(new Map([[-1001, new Set([1])]]));
  midnight();
  expect(wedChats.size).toBe(0);
  expect(probe).not.toHaveBeenCalled();
  expect(wedMemberReview.current!.pendingDay).toBe(DAY);
  enableWedMemberReview();
  await tick();
  expect(probe).toHaveBeenCalledTimes(1);
  expect(wedRuntime.current!.tasks.size).toBe(0);
  midnight();
  enableWedMemberReview();
  await tick();
  expect(probe).toHaveBeenCalledTimes(1);
  await tick(86_400_000);
  midnight("2026-09-08");
  await tick();
  expect(probe).toHaveBeenCalledTimes(2);
});

test("所有群共用每秒五个 ID 的限速，只移除明确离群者并复用最终 Set 落盘", async (): Promise<void> => {
  const first: Set<number> = new Set<number>([1, 2, 3, 4]);
  const second: Set<number> = new Set<number>([5, 6, 7]);
  hydrateWedMembers(new Map([[-1001, first], [-1002, second]]));
  const starts: number[] = [];
  probe.mockImplementation(async (_chatId: number, userId: number): Promise<ChatMember> => {
    starts.push(Date.now() - MIDNIGHT);
    if (userId === 7) throw new Error("injected membership lookup failure");
    return member(userId, userId === 2 ? "left" : userId === 3 ? "kicked"
      : userId === 4 || userId === 5 ? "restricted" : "member", userId !== 4);
  });
  enableWedMemberReview();
  midnight();
  await tick();
  await tick(199);
  expect(starts).toEqual([0]);
  await tick(1);
  for (let index: number = 0; index < 5; index++) await tick(200);
  expect(starts).toEqual([0, 200, 400, 600, 800, 1_000, 1_200]);
  expect(probe.mock.calls.map(([chatId, userId]) => [chatId, userId])).toEqual([
    [-1001, 1], [-1001, 2], [-1001, 3], [-1001, 4], [-1002, 5], [-1002, 6], [-1002, 7],
  ]);
  expect(wedMemberStates.get(-1001)!.members).toBe(first);
  expect([...first]).toEqual([1]);
  expect([...second]).toEqual([5, 6, 7]);
  expect(errorLog).toHaveBeenCalledTimes(1);
  expect(flushWedMembers()).toBeTrue();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith({ type: "wedMembers", chatId: -1001, revision: 3, members: [1] });
});

test("慢查询后不补发积压，跨日整轮不重叠", async (): Promise<void> => {
  hydrateWedMembers(new Map([[-1001, new Set([1, 2, 3])]]));
  const gate = heldProbe();
  enableWedMemberReview();
  midnight();
  await tick(86_400_000);
  midnight("2026-09-08");
  expect(probe).toHaveBeenCalledTimes(1);
  expect(wedRuntime.current!.tasks.size).toBe(1);
  gate.resolve(member(1));
  await tick();
  expect(probe).toHaveBeenCalledTimes(2);
  await tick(199);
  expect(probe).toHaveBeenCalledTimes(2);
  await tick(1);
  expect(probe).toHaveBeenCalledTimes(3);
  expect(wedRuntime.current!.tasks.size).toBe(0);
});

test("查询耗时不足一毫秒也不会把下一次查询提前到 200 毫秒以内", async (): Promise<void> => {
  let fraction: number = 0;
  now.mockImplementation((): number => Date.now() + fraction);
  probe.mockImplementationOnce(async (_chatId: number, userId: number): Promise<ChatMember> => {
    fraction = 0.5;
    return member(userId);
  });
  enableWedMemberReview();
  midnight();
  await tick();
  await tick(199);
  expect(probe).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(probe).toHaveBeenCalledTimes(2);
});

test("查询超时后的离群回包无效，继续查询其余成员", async (): Promise<void> => {
  const gate = heldProbe();
  enableWedMemberReview();
  midnight();
  const signal: AbortSignal = probe.mock.calls[0]![2]!;
  await tick(WED_OPERATION_TIMEOUT_MS);
  expect(signal.aborted).toBeTrue();
  gate.resolve(member(1, "left"));
  await tick();
  expect(wedMemberStates.get(-1001)!.members.has(1)).toBeTrue();
  expect(probe).toHaveBeenCalledTimes(2);
  expect(post).not.toHaveBeenCalled();
});

test("停机取消限速等待，最终 Set 由原排空入口投递，迟到午夜通知不重启", async (): Promise<void> => {
  probe.mockResolvedValueOnce(member(1, "left"));
  enableWedMemberReview();
  midnight();
  await tick();
  expect(wedMemberStates.get(-1001)!.members.has(1)).toBeFalse();
  expect(await drainWedRuntime(1_000)).toBe("flushed");
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith({ type: "wedMembers", chatId: -1001, revision: 1, members: [2] });
  midnight("2026-09-08");
  enableWedMemberReview();
  await tick(1_000);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(wedMemberReview.current).toBeNull();
});

test("停机在途查询必须结算后才能重建，取消后的离群回包不修改 Set", async (): Promise<void> => {
  const gate = heldProbe();
  enableWedMemberReview();
  midnight();
  const signal: AbortSignal = probe.mock.calls[0]![2]!;
  quiesceWedRuntime();
  expect(signal.aborted).toBeTrue();
  expect(await drainWedRuntime(0)).toBe("timedOut");
  expect((): void => initWedRuntime()).toThrow("unsettled");
  gate.resolve(member(1, "left"));
  await tick();
  expect([...wedMemberStates.get(-1001)!.members]).toEqual([1, 2]);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(await drainWedRuntime(0)).toBe("flushed");
  initWedRuntime();
  expect(wedMemberReview.current!.ready).toBeFalse();
});

test("重新接管成员集合时结束旧遍历，旧回包不能删除新集合的 ID", async (): Promise<void> => {
  const gate = heldProbe();
  enableWedMemberReview();
  midnight();
  const replacement: Set<number> = new Set<number>([1, 3]);
  hydrateWedMembers(new Map([[-1001, replacement]]));
  gate.resolve(member(1, "left"));
  await tick(200);
  expect([...replacement]).toEqual([1, 3]);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(wedRuntime.current!.tasks.size).toBe(0);
});

test.each(["speech", "chat_member", "service"])("查询期间的 %s 在群观察否决迟到离群结果", async (kind): Promise<void> => {
  hydrateWedMembers(new Map([[-1001, new Set([1])]]));
  const gate = heldProbe();
  enableWedMemberReview();
  midnight();
  const chat = { id: -1001, type: "supergroup" };
  if (kind === "speech") speak(1);
  else if (kind === "chat_member") observeWedMembers({ chat, chatMember: { new_chat_member: member(1) } } as never);
  else observeWedMembers({ chat, message: { chat, new_chat_members: [member(1).user] } } as never);
  gate.resolve(member(1, "left"));
  await tick();
  expect(wedMemberStates.get(-1001)!.members.has(1)).toBeTrue();
  expect(wedMemberStates.get(-1001)!.dirty).toBeFalse();
});

test("每群快照有限，跳过已删除成员，新发言 ID 留到下一轮", async (): Promise<void> => {
  hydrateWedMembers(new Map([[-1001, new Set([1, 2, 3])]]));
  const gate = heldProbe();
  enableWedMemberReview();
  midnight();
  removeWedMember(-1001, 2);
  speak(4);
  gate.resolve(member(1));
  await tick();
  await tick(200);
  expect(probe.mock.calls.map((call) => call[1])).toEqual([1, 3]);
  expect([...wedMemberStates.get(-1001)!.members]).toEqual([1, 3, 4]);
});
