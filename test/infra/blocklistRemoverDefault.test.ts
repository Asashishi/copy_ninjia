/**
 * 「还没有 owner 注册处置执行者」时的 fail-safe。
 *
 * `blockedMemberRemoverHolder` 由 packages/antiRaid/blocklistGuard.ts 在启动时反向
 * 注册。注册之前（进程刚起、Anti-Raid 还没接管）以及测试隔离下，holder 里是
 * cache/main/blocklist.ts 的显式 no-op。它必须**结算成「投出 0 条」而不是抛错**：
 * 抛错会从 deliverPreparedSweeps 一路逃回补扫调用点，把「还没人接管」误报成
 * 「补扫失败」，进而写坏退避进度；而报出一个非 0 的条数会让 outbox 以为任务已经
 * 投出去，把本该留着重投的批次销账——那等于被 /block 的人一直坐在群里。
 *
 * 本文件只 import 纯常量模块（cache/main/blocklist.ts 没有任何运行时依赖），
 * 因此不装 harness，也不注册任何 remover——注册了就测不到默认值了。
 */

import { expect, test } from "bun:test";
import { blockedMemberRemoverHolder } from "../../packages/cache/main/blocklist";
import type { RemoveBlockedMembersParams } from "../../packages/types/blocklist";

const REMOVALS: readonly RemoveBlockedMembersParams[] = [
  { removalId: 1, chatId: -1001, userIds: [7], probeMembership: true },
];

test("没有 owner 注册时，默认处置执行者报 0 条且不抛错", async () => {
  await expect(blockedMemberRemoverHolder.current(REMOVALS)).resolves.toBe(0);
  // 空批次同样走这条兜底，不能因为「没东西可投」就换一个结论。
  await expect(blockedMemberRemoverHolder.current([])).resolves.toBe(0);
});
