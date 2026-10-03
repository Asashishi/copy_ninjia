import { describe, expect, test } from "bun:test";
import {
  CACHE_OWNER_EXEMPTIONS,
  collectCacheOwnerHeaderProblems,
  collectStaleCacheExemptionProblems,
  expectedCacheOwnerHeader,
} from "../../scripts/conventions/cacheOwnership";

describe("cache 归属豁免的反向核对", () => {
  const projectRoot: string = "/project";
  const exemptPath: string = "/project/packages/cache/main/diskIO.ts";
  const otherPath: string = "/project/packages/cache/main/value.ts";
  const loggerPath: string = "/project/packages/infra/logger.ts";
  /** 主线程与 aiChat 都加载豁免文件；antiRaid 的闭包里没有它，diskIO 线程不在表内。 */
  const threadClosures: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map([
    ["main", new Map([[exemptPath, ["/project/index.ts", loggerPath, exemptPath]]])],
    ["aiChat", new Map([[exemptPath, ["/project/packages/workers/aiChatWorker.ts", loggerPath, exemptPath]]])],
    ["antiRaid", new Map([[otherPath, ["/project/packages/workers/antiRaidWorker.ts", otherPath]]])],
  ]);
  const cacheFiles: readonly string[] = [exemptPath, otherPath];

  test("豁免的文件仍存在且被豁免线程真实加载时不报问题", (): void => {
    expect(collectStaleCacheExemptionProblems({
      projectRoot,
      cacheFiles,
      threadClosures,
      exemptions: { "packages/cache/main/diskIO.ts": ["aiChat"] },
    })).toEqual([]);
    expect(collectStaleCacheExemptionProblems({ projectRoot, cacheFiles, threadClosures, exemptions: {} }))
      .toEqual([]);
  });

  test("被豁免线程的模块闭包不再包含该文件时逐线程报出", (): void => {
    expect(collectStaleCacheExemptionProblems({
      projectRoot,
      cacheFiles,
      threadClosures,
      exemptions: { "packages/cache/main/diskIO.ts": ["aiChat", "antiRaid", "diskIO"] },
    })).toEqual([
      "CACHE_OWNER_EXEMPTIONS retains an unused exemption: the antiRaid thread no longer loads packages/cache/main/diskIO.ts",
      "CACHE_OWNER_EXEMPTIONS retains an unused exemption: the diskIO thread no longer loads packages/cache/main/diskIO.ts",
    ]);
  });

  test("豁免指向已删除的 cache 模块时只报文件缺失，不再逐线程核对", (): void => {
    expect(collectStaleCacheExemptionProblems({
      projectRoot,
      cacheFiles,
      threadClosures,
      exemptions: {
        "packages/cache/main/removed.ts": ["aiChat", "antiRaid"],
        "packages/cache/main/diskIO.ts": ["aiChat"],
      },
    })).toEqual([
      "CACHE_OWNER_EXEMPTIONS retains an exemption for a cache module that no longer exists: packages/cache/main/removed.ts",
    ]);
  });

  test("仓库现有豁免表在 cache 文件集合缺失对应模块时逐条报出", (): void => {
    expect(collectStaleCacheExemptionProblems({
      projectRoot,
      cacheFiles: [otherPath],
      threadClosures,
      exemptions: CACHE_OWNER_EXEMPTIONS,
    })).toEqual(Object.keys(CACHE_OWNER_EXEMPTIONS).map((relativePath: string): string =>
      `CACHE_OWNER_EXEMPTIONS retains an exemption for a cache module that no longer exists: ${relativePath}`));
  });
});

describe("cache 文件首行 owner 头注", () => {
  test("owner 取自目录：main、perThread 或 workers/<thread>", (): void => {
    expect(expectedCacheOwnerHeader("packages/cache/main/qa.ts")).toBe("main");
    expect(expectedCacheOwnerHeader("packages/cache/main/antiRaid/proxy.ts")).toBe("main");
    expect(expectedCacheOwnerHeader("packages/cache/perThread/time.ts")).toBe("perThread");
    expect(expectedCacheOwnerHeader("packages/cache/workers/aiChat/stickers/menu.ts")).toBe("workers/aiChat");
    expect(expectedCacheOwnerHeader("packages/cache/workers/diskIO/logs.ts")).toBe("workers/diskIO");
    expect(expectedCacheOwnerHeader("packages/cache/workers/stray.ts")).toBeNull();
    expect(expectedCacheOwnerHeader("packages/cache/stray.ts")).toBeNull();
    expect(expectedCacheOwnerHeader("packages/libs/time.ts")).toBeNull();
  });

  test("首行缺头注、owner 写法不同或与目录不符时逐文件报出", (): void => {
    const firstLines: ReadonlyMap<string, string> = new Map([
      ["/project/packages/cache/main/ok.ts", "/** owner: main。群问答的权威热缓存。 */"],
      ["/project/packages/cache/main/bare.ts", "/** owner: main。 */"],
      ["/project/packages/cache/workers/aiChat/multi.ts", "/** owner: workers/aiChat。回复调度的内存状态。"],
      ["/project/packages/cache/main/import.ts", "import type { A } from \"./a\";"],
      ["/project/packages/cache/main/legacy.ts", "/** Owner: 主线程。旧写法。 */"],
      ["/project/packages/cache/workers/diskIO/wrong.ts", "/** owner: workers/aiChat。错放的 owner。 */"],
      ["/project/packages/cache/perThread/semicolon.ts", "/** owner: perThread；旧分隔符。 */"],
      ["/project/packages/cache/stray.ts", "export const value: number = 1;"],
    ]);
    expect(collectCacheOwnerHeaderProblems({ projectRoot: "/project", firstLines })).toEqual([
      "packages/cache/main/import.ts must start with the cache owner header \"/** owner: main。\"",
      "packages/cache/main/legacy.ts must start with the cache owner header \"/** owner: main。\"",
      "packages/cache/workers/diskIO/wrong.ts must start with the cache owner header \"/** owner: workers/diskIO。\"",
      "packages/cache/perThread/semicolon.ts must start with the cache owner header \"/** owner: perThread。\"",
    ]);
  });
});
