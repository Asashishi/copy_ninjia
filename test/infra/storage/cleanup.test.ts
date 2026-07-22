import { describe, expect, test } from "bun:test";
import { cleanupOrphanedTempFiles } from "../../../src/infra/storage/cleanup";

describe("storage startup cleanup", () => {
  test("只删除 state/lock 原子写临时文件，目录扫描与删除均可注入", async () => {
    const removed: string[] = [];
    await cleanupOrphanedTempFiles({
      stateFilePath: "/virtual/state.json",
      lockFilePath: "/virtual/bot.lock",
      readDirectory: async () => [
        ".state.json.1.uuid.tmp",
        ".state.json.bak.1.uuid.tmp",
        ".bot.lock.1.uuid.tmp",
        ".other.json.1.uuid.tmp",
        "bot.lock.guard.candidate.42.11111111-1111-4111-8111-111111111111",
        "bot.lock.guard.candidate.43.22222222-2222-4222-8222-222222222222",
        "bot.lock.guard.candidate.bad.33333333-3333-4333-8333-333333333333",
        "bot.lock.guard.recovery",
        "state.json",
      ],
      isInactiveLockOwner: async (path) => !path.includes("candidate.43."),
      removeFile: async (path) => {
        removed.push(path);
      },
    });

    expect(removed).toEqual([
      "/virtual/.state.json.1.uuid.tmp",
      "/virtual/.state.json.bak.1.uuid.tmp",
      "/virtual/.bot.lock.1.uuid.tmp",
      "/virtual/bot.lock.guard.candidate.42.11111111-1111-4111-8111-111111111111",
      "/virtual/bot.lock.guard.recovery",
    ]);
  });
});
