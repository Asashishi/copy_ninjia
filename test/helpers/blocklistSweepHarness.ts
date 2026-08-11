/**
 * 黑名单清扫三个用例文件共用的替身、状态与隔离钩子。
 *
 * 单文件曾超过 1000 行（AGENTS.md 要求必须拆分），而这套 mock.module 装配、
 * Worker 回执工厂与 beforeEach 复位三份用例都要用。
 */

import { beforeEach, expect, mock } from "bun:test";
import type { BlockedMemberRemover } from "../../packages/types/blocklist";
import {
  blockedIdentityTestView as blockedUserIds,
  readBlockedIdentityTestIds,
} from "./identityStorage";

export { blockedUserIds };

export const configuredBlockedIds: {
  add(id: number): void;
  clear(): void;
} = {
  add(id: number): void {
    blockedUserIds.set(id, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
  },
  clear(): void {},
};

export const states = new Map<number, Record<string, unknown>>();
export const getChatMember = mock(async (): Promise<{ status: string }> => ({ status: "administrator" }));
export const persistAuthoritativeState = mock(async (): Promise<void> => {});
/**
 * 处置的执行 owner 替身：主线程侧只该「投出去」，不该自己打 API。
 * 返回值是**真正投出去的条数**（见 types/blocklist.ts 的 BlockedMemberRemover）：
 * 默认整批都投出去，零投递由个别用例单独 mock。
 */
export const remover = mock(async (...args: unknown[]): Promise<number> =>
  (args[0] as readonly unknown[]).length);
export const postDiskIO = mock((..._args: unknown[]): boolean => true);
/**
 * 黑名单主键读的当前实现。SQLite 迁移之后它是**跨线程 request/reply**，Disk I/O
 * 自愈窗口里会直接 reject（见 infra/diskIO.ts），因此用例要能切换成失败。
 */
const readBlocklistIds: { current: () => Promise<readonly number[]> } = {
  current: async (): Promise<readonly number[]> => readBlockedIdentityTestIds(),
};

mock.module("../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../packages/infra/telegram/mainClient", () => ({
  bot: { botInfo: { id: 99 }, api: { getChatMember } },
}));
mock.module("../../packages/infra/diskIO", () => ({
  postDiskIO,
  onDiskIORespawn: (): void => {},
  onIdentityStoragePersisted: (): void => {},
  readBlocklistIds: (): Promise<readonly number[]> => readBlocklistIds.current(),
  relayLogMessage: (): boolean => true,
  flushDiskIO: async (): Promise<string> => "flushed",
  // /block 只等黑名单这一个领域的落盘回执（见 confirmBlocklistPersisted）。
  flushDiskIODomain: async (): Promise<string> => "flushed",
  flushDiskIODomainOutcome: async (): Promise<{ result: string }> => ({ result: "flushed" }),
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getAllChatStates: (): ReadonlyMap<number, Record<string, unknown>> => states,
  getChatState: (chatId: number): Record<string, unknown> => states.get(chatId) ?? {},
  getOrCreateChatState: (chatId: number): Record<string, unknown> => {
    const current = states.get(chatId) ?? {};
    states.set(chatId, current);
    return current;
  },
  clearChatStateField: (): boolean => false,
  pruneDepartedChatState: (): void => {},
  persistAuthoritativeState,
  saveStateInBackground: (): void => {},
}));
mock.module("../../packages/infra/chatTeardown", () => ({
  teardownRegisteredChat: async (): Promise<void> => {},
  registerChatTeardown: (): void => {},
}));

/**
 * 被测模块由各用例文件自行 `await import` 之后注入。
 *
 * 助手模块**不能**自己 await import：那些模块都依赖上面 mock.module 装上的替身，
 * 而带顶层 await 的助手一旦被用例文件静态或动态导入，Bun 会让它的导出停在 TDZ
 * （实测：`Cannot access 'x' before initialization`）。注入还顺带把「本文件用到
 * 哪些被测出口」写成了类型。
 */
export interface BlocklistSweepDeps {
  readonly quiesceBlocklistSweepScheduler: () => void;
  readonly registerBlockedMemberRemover: (remover: BlockedMemberRemover) => void;
  readonly settleBlockedRemoval: (event: never) => void;
  readonly blocklistSweepState: Map<number, unknown>;
  readonly pendingBlockedRemovals: Map<number, unknown>;
}

const deps: { current: BlocklistSweepDeps | null } = { current: null };

function requireDeps(): BlocklistSweepDeps {
  if (deps.current === null) {
    throw new Error("installBlocklistSweepHooks must run before the harness helpers.");
  }
  return deps.current;
}

/** 上一次投出去的那批处置的编号。 */
export function lastRemovalId(): number {
  return (remover.mock.calls.at(-1)![0] as readonly { removalId: number }[])[0]!.removalId;
}

export function expectLastRemoval(expected: Record<string, unknown>): void {
  expect(remover.mock.calls.at(-1)?.[0]).toEqual([
    expect.objectContaining(expected),
  ]);
}

/** Worker 回执：这批处置全部落定 / 没能落定。 */
export function settleLast(complete: boolean, chatId: number = -1001): void {
  requireDeps().settleBlockedRemoval({
    type: "blockedMembersRemoved",
    chatId,
    removalId: lastRemovalId(),
    complete,
  } as never);
}

/** 一条机器人自身成员状态变化的 my_chat_member 更新。 */
export function promotion(newStatus: string, oldStatus: string, canRestrict?: boolean): never {
  return {
    myChatMember: {
      chat: { id: -1001, type: "supergroup" },
      old_chat_member: { status: oldStatus },
      new_chat_member: {
        status: newStatus,
        ...(canRestrict === undefined ? {} : { can_restrict_members: canRestrict }),
      },
    },
  } as never;
}

/** Worker 回执：这批因为机器人没有封禁权限而没落定。 */
export function settleLastAsForbidden(chatId: number = -1001): void {
  requireDeps().settleBlockedRemoval({
    type: "blockedMembersRemoved",
    chatId,
    removalId: lastRemovalId(),
    complete: false,
    permissionDenied: true,
  } as never);
}

/** 用例切换黑名单主键读的实现（自愈窗口里它会 reject）。 */
export function setBlocklistIdReads(
  implementation: () => Promise<readonly number[]>
): void {
  readBlocklistIds.current = implementation;
}

/** 三个黑名单清扫用例文件共用的隔离钩子；每份都要登记一次。 */
export function installBlocklistSweepHooks(injected: BlocklistSweepDeps): void {
  deps.current = injected;
  beforeEach(() => {
    injected.quiesceBlocklistSweepScheduler();
    states.clear();
    blockedUserIds.clear();
    configuredBlockedIds.clear();
    injected.blocklistSweepState.clear();
    injected.pendingBlockedRemovals.clear();
    remover.mockClear();
    postDiskIO.mockClear();
    getChatMember.mockClear();
    persistAuthoritativeState.mockClear();
    postDiskIO.mockImplementation((): boolean => true);
    remover.mockImplementation(async (...args: unknown[]): Promise<number> =>
      (args[0] as readonly unknown[]).length);
    injected.registerBlockedMemberRemover(remover as unknown as BlockedMemberRemover);
    readBlocklistIds.current = async (): Promise<readonly number[]> =>
      readBlockedIdentityTestIds();
  });
}
