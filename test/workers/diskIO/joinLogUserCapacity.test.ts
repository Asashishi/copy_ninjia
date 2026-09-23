import { afterAll, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TEST_DATA_ROOT } from "../../preloadEnv";

/**
 * 启动检查拒绝单群单日独立用户数越过硬上限的入群日志文件。真实上限是 25 万人，
 * 这里只把上限调小，其余常量与路径之外的实现全部是生产代码。
 */

const testRoot: string = mkdtempSync(join(TEST_DATA_ROOT, "join-log-capacity-test-"));
const joinLogDir: string = join(testRoot, "joinlog");
const realPaths = await import("../../../packages/consts/paths");
mock.module("../../../packages/consts/paths", () => ({ ...realPaths, JOIN_LOG_MEMORY_DIR: joinLogDir }));
const realJoinLogConsts = await import("../../../packages/consts/diskIO/joinLog");
mock.module("../../../packages/consts/diskIO/joinLog", () => ({
  ...realJoinLogConsts,
  JOIN_LOG_MAX_USERS_PER_CHAT_DAY: 2,
}));

const { inspectJoinLogFiles } = await import("../../../packages/workers/diskIO/joinLogFiles");
const { serializeJoinLogSnapshotEntry } = await import("../../../packages/workers/diskIO/joinLogRecords");
const { getTokyoDateKey } = await import("../../../packages/libs/time");

afterAll((): void => {
  rmSync(testRoot, { recursive: true, force: true });
});

test("同一用户重复入群按最新一条计，独立用户数越过上限才拒绝启动且不改文件", async () => {
  const today: string = getTokyoDateKey();
  const baseAt: number = Date.parse(`${today}T00:00:00+09:00`);
  const path: string = join(joinLogDir, `-1001.${today}.json`);
  mkdirSync(joinLogDir, { recursive: true });
  const write = async (userIds: readonly number[]): Promise<string> => {
    const content: string = `{\n${userIds.map((userId: number, index: number): string =>
      serializeJoinLogSnapshotEntry({ userId, joinedAt: baseAt + index + 1 })).join(",\n")}\n}`;
    await Bun.write(path, content);
    return content;
  };

  await write([1, 2, 1]);
  await expect(inspectJoinLogFiles(today)).resolves.toMatchObject({ today });

  const rejected: string = await write([1, 2, 3]);
  await expect(inspectJoinLogFiles(today)).rejects.toThrow("at most 2 distinct users per chat day");
  expect(await Bun.file(path).text()).toBe(rejected);
});
