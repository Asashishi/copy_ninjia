/**
 * Worker 重建 adopt 之后的入群守卫清理（purgeDisabledJoinGuards）：/antiraid 已关的群
 * 里残留的延后验证要连同主线程镜像一起撤掉，并让 Worker 按 revision 协议产生 tombstone。
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { diskIOStub } from "../helpers/diskIOMock";
import { loggerStub } from "../helpers/loggerMock";
import type { DiskBusinessMessage } from "../../packages/types/diskIO";
import type { AntiRaidWorkerMessage } from "../../packages/types/antiRaid/protocol";

const diskPosts: DiskBusinessMessage[] = [];
const errorLogs: string[] = [];
const infoLogs: string[] = [];
mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  postDiskIO: (message: DiskBusinessMessage): boolean => {
    diskPosts.push(message);
    return true;
  },
})));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({
    error: (message: unknown): void => { errorLogs.push(String(message)); },
    log: (message: unknown): void => { infoLogs.push(String(message)); },
  }),
}));

const { purgeDisabledJoinGuards } = await import("../../packages/antiRaid/workerBridge/replay");
const { deferredVerificationRecords } = await import("../../packages/cache/main/antiRaid/verificationMirror");
const { chatStateCache } = await import("../../packages/cache/main/chatState");

const DISABLED_CHAT: number = -1001;
const ENABLED_CHAT: number = -2002;

beforeEach(() => {
  diskPosts.length = 0;
  errorLogs.length = 0;
  infoLogs.length = 0;
  deferredVerificationRecords.clear();
  chatStateCache.clear();
  chatStateCache.set(ENABLED_CHAT, { isAntiRaidEnabled: true } as never);
  deferredVerificationRecords.set(`${DISABLED_CHAT}:42`, { chatId: DISABLED_CHAT, userId: 42, generation: 1, revision: 3 });
  deferredVerificationRecords.set(`${ENABLED_CHAT}:43`, { chatId: ENABLED_CHAT, userId: 43, generation: 1, revision: 5 });
});

afterEach(() => {
  deferredVerificationRecords.clear();
  chatStateCache.clear();
});

test("开关已关群的延后验证：撤镜像、写 tombstone 并让 Worker 停掉该群守卫", () => {
  const posted: AntiRaidWorkerMessage[] = [];
  purgeDisabledJoinGuards((message: AntiRaidWorkerMessage): boolean => {
    posted.push(message);
    return true;
  });

  expect(posted).toEqual([{ type: "deactivateJoinGuard", chatId: DISABLED_CHAT }]);
  expect([...deferredVerificationRecords.keys()]).toEqual([`${ENABLED_CHAT}:43`]);
  expect(diskPosts).toEqual([expect.objectContaining({
    type: "verificationDelete",
    chatId: DISABLED_CHAT,
    userId: 42,
    revision: 4,
  })]);
  expect(errorLogs).toEqual([]);
  expect(infoLogs.some((line: string): boolean => line.includes(String(DISABLED_CHAT)))).toBeTrue();
});

test("Worker 拒收清理消息时记错误、不报清理成功，留给下一次重建重试", () => {
  purgeDisabledJoinGuards((): boolean => false);

  expect(errorLogs).toHaveLength(1);
  expect(errorLogs[0]).toContain(`join guard cleanup for chat ${DISABLED_CHAT}`);
  expect(infoLogs).toEqual([]);
});
