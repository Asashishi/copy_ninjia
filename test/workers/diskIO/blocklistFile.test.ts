import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { BLOCKLIST_FILE_PATH, RUNTIME_CONFIG_DIR } from "../../../packages/consts/paths";
import type { BlockedUserRecord } from "../../../packages/types/diskIO/storage";
import {
  flushBlocklistAppends,
  handleBlockUserMessage,
  handleUnblockUserMessage,
  hydrateBlocklist,
} from "../../../packages/workers/diskIO/blocklistFile";
import {
  blocklistKnownIds,
  blocklistPendingEntries,
  resetBlocklistCache,
} from "../../../packages/cache/diskIO/blocklist";

function readBlocklist(): Record<string, { isBlocked: boolean; blockedAt: string }> {
  return JSON.parse(readFileSync(BLOCKLIST_FILE_PATH, "utf8"));
}

beforeEach(() => {
  resetBlocklistCache();
  rmSync(BLOCKLIST_FILE_PATH, { force: true });
  mkdirSync(RUNTIME_CONFIG_DIR, { recursive: true });
});

describe("黑名单文件的追加落盘", () => {
  test("首条走原子重写建文件，后续按位置追加，格式与整份 stringify 一致", () => {
    hydrateBlocklist();
    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 19:38:09" });
    handleBlockUserMessage({ type: "blockUser", userId: -4004, blockedAt: "2026/07/25 19:40:00" });

    const parsed = readBlocklist();
    expect(parsed).toEqual({
      "7": { isBlocked: true, blockedAt: "2026/07/25 19:38:09" },
      "-4004": { isBlocked: true, blockedAt: "2026/07/25 19:40:00" },
    });
    // 追加是覆写结尾的「\n}」，产物必须与一次性 stringify 逐字节相同——不然
    // 下次打开时会被当成「结尾形态不符」而整份重写。
    expect(readFileSync(BLOCKLIST_FILE_PATH, "utf8")).toBe(JSON.stringify(parsed, null, 2));
    // 收到即写，不留缓冲。
    expect(blocklistPendingEntries).toHaveLength(0);
  });

  test("重复的 id 不再追加第二条记录", () => {
    hydrateBlocklist();
    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 19:38:09" });
    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 20:00:00" });

    expect(Object.keys(readBlocklist())).toEqual(["7"]);
  });

  test("启动恢复读回全部 id，文件不存在时是空表而非报错", () => {
    expect(hydrateBlocklist().size).toBe(0);
    expect(existsSync(BLOCKLIST_FILE_PATH)).toBeFalse();

    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 19:38:09" });
    handleBlockUserMessage({ type: "blockUser", userId: 8, blockedAt: "2026/07/25 19:38:10" });

    const restored: Map<number, BlockedUserRecord> = hydrateBlocklist();
    expect([...restored.keys()].sort((a: number, b: number): number => a - b)).toEqual([7, 8]);
    // 读回的是完整记录而不是 true：/unblock 要拿主线程那份 Map 整份重写回
    // 文件，只留「在不在」会把其他人的 blockedAt 一起抹平。
    expect(restored.get(7)).toEqual({ isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    expect(restored.get(8)).toEqual({ isBlocked: true, blockedAt: "2026/07/25 19:38:10" });
    // 已知 id 同步重建，重启后重复投递同一个人不会再写一条。
    expect(blocklistKnownIds.has(7)).toBeTrue();
  });

  test("结尾被截断时拒绝自愈：整体抛错并原样保留字节", () => {
    // 日志/运势/待验证可以裁掉末尾残片继续跑，黑名单不行——被裁掉的每一条
    // 都是一个被放回群里的人。掉电撕裂如此，手工编辑改坏了同样如此：宁可
    // 拒绝启动等人工恢复，也不能静默少几条继续跑（docs/04-invariants.md）。
    const truncated: string =
      "{\n  \"7\": {\n    \"isBlocked\": true,\n    \"blockedAt\": \"2026/07/25 19:38:09\"\n  },\n  \"8\": {\n    \"isBlo";
    writeFileSync(BLOCKLIST_FILE_PATH, truncated);

    expect((): Map<number, BlockedUserRecord> => hydrateBlocklist()).toThrow(/refusing to repair/);
    // 原始字节一个都不能动：修复过的文件会让「8 号到底有没有被拉黑」永远无从查证。
    expect(readFileSync(BLOCKLIST_FILE_PATH, "utf8")).toBe(truncated);
  });

  test("键必须能原样还原成 id：Number 认得但对不上文本的形态一律拒绝", () => {
    // Number("0x1f4") === 500、Number("1e3") === 1000、Number("") === 0 都是
    // 安全整数，却和键面上的文本对不上——手工编辑多敲一个字符，被拉黑的就
    // 是另一个人，而真正的目标不在名单里。
    for (const key of ["0x1f4", "1e3", "7.0", " 7", ""]) {
      writeFileSync(BLOCKLIST_FILE_PATH, JSON.stringify({ [key]: { isBlocked: true, blockedAt: "x" } }, null, 2));
      expect((): Map<number, BlockedUserRecord> => hydrateBlocklist()).toThrow(/non-numeric user id/);
    }
  });

  test("落盘文件按 0644 建立，孤儿临时文件在启动恢复时清掉", () => {
    // config/ 还放着手工维护的 mood/stickers/reactions，只能按自己的文件名
    // 前缀清扫，不能按后缀无差别删。
    const orphan: string = `${RUNTIME_CONFIG_DIR}/.blocklist.json.999.abc.tmp`;
    const foreign: string = `${RUNTIME_CONFIG_DIR}/.mood.json.999.abc.tmp`;
    writeFileSync(orphan, "{}");
    writeFileSync(foreign, "{}");

    hydrateBlocklist();
    expect(existsSync(orphan)).toBeFalse();
    expect(existsSync(foreign)).toBeTrue();
    rmSync(foreign, { force: true });

    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 19:38:09" });
    // 严格 umask 的部署里也必须是 0644：这个文件是同步安全边界，不能因为
    // 进程 umask 宽松就变成同组可写。
    expect(statSync(BLOCKLIST_FILE_PATH).mode & 0o777).toBe(0o644);
  });

  test("记录形状不合规时整体抛错，不静默丢条目", () => {
    // 黑名单是安全边界：漏掉一条就意味着那个人能重新进群，宁可拒绝启动。
    writeFileSync(BLOCKLIST_FILE_PATH, JSON.stringify({ "7": { isBlocked: false, blockedAt: "x" } }, null, 2));
    expect((): Map<number, BlockedUserRecord> => hydrateBlocklist()).toThrow(/invalid block record/);

    writeFileSync(BLOCKLIST_FILE_PATH, JSON.stringify({ "not-an-id": { isBlocked: true, blockedAt: "x" } }, null, 2));
    expect((): Map<number, BlockedUserRecord> => hydrateBlocklist()).toThrow(/non-numeric user id/);
  });

  test("写盘失败时条目留在缓冲里，下一次 flush 重试", () => {
    hydrateBlocklist();
    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 19:38:09" });
    // 目录整体挪走（不是删掉——已落盘的记录必须原样还在）：追加必然失败，
    // 未落盘的条目不能就此丢掉。
    const stashed: string = `${RUNTIME_CONFIG_DIR}.stashed`;
    renameSync(RUNTIME_CONFIG_DIR, stashed);

    handleBlockUserMessage({ type: "blockUser", userId: 8, blockedAt: "2026/07/25 19:39:00" });
    expect(blocklistPendingEntries).toHaveLength(1);
    expect(flushBlocklistAppends()).toBeFalse();

    renameSync(stashed, RUNTIME_CONFIG_DIR);
    expect(flushBlocklistAppends()).toBeTrue();
    expect(Object.keys(readBlocklist())).toEqual(["7", "8"]);
  });
});

describe("解除拉黑的全量重写", () => {
  test("按主线程送来的完整名单整文件重写，被删的那条真的消失", () => {
    hydrateBlocklist();
    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 19:38:09" });
    handleBlockUserMessage({ type: "blockUser", userId: 8, blockedAt: "2026/07/25 19:38:10" });

    // 追加型文件删不掉条目，唯一的办法就是整份写回去。
    handleUnblockUserMessage({
      type: "unblockUser",
      userId: 7,
      blocked: [[8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" }]],
    });

    expect(readBlocklist()).toEqual({ "8": { isBlocked: true, blockedAt: "2026/07/25 19:38:10" } });
    // 重写产物必须仍是标准形态，否则下次打开会被判成「结尾形态不符」再重写一遍。
    expect(readFileSync(BLOCKLIST_FILE_PATH, "utf8")).toBe(JSON.stringify(readBlocklist(), null, 2));
  });

  test("重写后追加游标与已知 id 一起复位，后续追加不写坏 JSON", () => {
    hydrateBlocklist();
    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 19:38:09" });
    handleBlockUserMessage({ type: "blockUser", userId: 8, blockedAt: "2026/07/25 19:38:10" });

    handleUnblockUserMessage({
      type: "unblockUser",
      userId: 7,
      blocked: [[8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" }]],
    });
    // 文件变短了：照着旧游标继续追加会写进内容中间，把 JSON 弄坏。
    handleBlockUserMessage({ type: "blockUser", userId: 9, blockedAt: "2026/07/25 20:00:00" });

    expect(readBlocklist()).toEqual({
      "8": { isBlocked: true, blockedAt: "2026/07/25 19:38:10" },
      "9": { isBlocked: true, blockedAt: "2026/07/25 20:00:00" },
    });
    // 被解除的那个 id 不再算「已知」，重新拉黑时要能再写进去。
    expect(blocklistKnownIds.has(7)).toBeFalse();
    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 21:00:00" });
    expect(readBlocklist()["7"]).toEqual({ isBlocked: true, blockedAt: "2026/07/25 21:00:00" });
  });

  test("解除掉最后一个人后文件是空对象，重启读回空表", () => {
    hydrateBlocklist();
    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 19:38:09" });

    handleUnblockUserMessage({ type: "unblockUser", userId: 7, blocked: [] });

    expect(readBlocklist()).toEqual({});
    expect(hydrateBlocklist().size).toBe(0);
  });

  test("重写落盘后可被同一套严格校验读回", () => {
    hydrateBlocklist();
    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 19:38:09" });
    handleBlockUserMessage({ type: "blockUser", userId: -4004, blockedAt: "2026/07/25 19:40:00" });

    handleUnblockUserMessage({
      type: "unblockUser",
      userId: 7,
      blocked: [[-4004, { isBlocked: true, blockedAt: "2026/07/25 19:40:00" }]],
    });

    const restored = hydrateBlocklist();
    expect([...restored.keys()]).toEqual([-4004]);
    expect(restored.get(-4004)).toEqual({ isBlocked: true, blockedAt: "2026/07/25 19:40:00" });
  });
});

describe("重写失败后的重试", () => {
  /** 把 config/ 整体挪走：写入必然失败，已落盘的记录原样还在。 */
  function withMissingConfigDir(run: () => void): void {
    const stashed: string = `${RUNTIME_CONFIG_DIR}.stashed`;
    renameSync(RUNTIME_CONFIG_DIR, stashed);
    try {
      run();
    } finally {
      rmSync(RUNTIME_CONFIG_DIR, { recursive: true, force: true });
      renameSync(stashed, RUNTIME_CONFIG_DIR);
    }
  }

  test("重写没落地时 flush 必须报失败，不能假报成功", () => {
    // 删除只能靠重写表达，而重写失败时追加缓冲是空的。不单独记一笔的话
    // flush 直接返回 true，/unblock 于是告诉管理员「划掉了」，而文件里那条
    // 还在，重启就复活。
    hydrateBlocklist();
    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 19:38:09" });

    withMissingConfigDir((): void => {
      handleUnblockUserMessage({ type: "unblockUser", userId: 7, blocked: [] });
      expect(flushBlocklistAppends()).toBeFalse();
    });
  });

  test("目录恢复后下一次 flush 把重写补上", () => {
    hydrateBlocklist();
    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 19:38:09" });
    handleBlockUserMessage({ type: "blockUser", userId: 8, blockedAt: "2026/07/25 19:38:10" });

    withMissingConfigDir((): void => {
      handleUnblockUserMessage({
        type: "unblockUser",
        userId: 7,
        blocked: [[8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" }]],
      });
    });

    expect(flushBlocklistAppends()).toBeTrue();
    expect(readBlocklist()).toEqual({ "8": { isBlocked: true, blockedAt: "2026/07/25 19:38:10" } });
  });

  test("重写待落地期间新来的拉黑并进快照，不被重试挤掉", () => {
    hydrateBlocklist();
    handleBlockUserMessage({ type: "blockUser", userId: 7, blockedAt: "2026/07/25 19:38:09" });

    withMissingConfigDir((): void => {
      handleUnblockUserMessage({ type: "unblockUser", userId: 7, blocked: [] });
      // 这条若只进追加缓冲，重试重写时用的还是旧快照（空名单），刚拉黑的
      // 9 号会被直接挤掉——名单里没有他，而主线程以为有。
      handleBlockUserMessage({ type: "blockUser", userId: 9, blockedAt: "2026/07/25 20:00:00" });
    });

    expect(flushBlocklistAppends()).toBeTrue();
    expect(readBlocklist()).toEqual({ "9": { isBlocked: true, blockedAt: "2026/07/25 20:00:00" } });
  });
});
