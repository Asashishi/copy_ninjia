/**
 * 「还没有 owner 注册处置执行者」时的 fail-safe。
 *
 * `blockedMemberRemoverHolder` 由 packages/antiRaid/blocklistGuard.ts 在启动时反向注册。
 * 注册之前（进程刚起、Anti-Raid 还没接管）以及测试隔离下，holder 里是 cache/main/blocklist.ts 的显式 no-op，
 * 它结算成「投出 0 条」而不抛错：outbox 据此保留任务等待重投，补扫调用点不把「还没人接管」记成「补扫失败」。
 *
 * 本文件只 import 纯常量模块（cache/main/blocklist.ts 没有任何运行时依赖），不装 harness，也不注册任何 remover。
 */

import { expect, test } from "bun:test";
import { blockedMemberRemoverHolder } from "../../packages/cache/main/blocklist";
import type { RemoveBlockedMembersParams } from "../../packages/types/blocklist";

const REMOVALS: readonly RemoveBlockedMembersParams[] = [
  { removalId: 1, chatId: -1001, userIds: [7], probeMembership: true },
];

test("没有 owner 注册时，默认处置执行者报 0 条且不抛错", async () => {
  await expect(blockedMemberRemoverHolder.current(REMOVALS)).resolves.toBe(0);
  // 空批次同样走这条兜底。
  await expect(blockedMemberRemoverHolder.current([])).resolves.toBe(0);
});
