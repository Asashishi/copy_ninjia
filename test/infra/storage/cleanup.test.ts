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
        "state.json",
      ],
      removeFile: async (path) => {
        removed.push(path);
      },
    });

    expect(removed).toEqual([
      "/virtual/.state.json.1.uuid.tmp",
      "/virtual/.state.json.bak.1.uuid.tmp",
      "/virtual/.bot.lock.1.uuid.tmp",
    ]);
  });
});
