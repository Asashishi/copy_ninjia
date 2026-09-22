import { join, relative } from "node:path";

/** cache 顶层目录与 owner 线程的映射。 */
export type CacheOwnerPrefix = readonly [prefix: string, owner: string];

/** 四条线程各自入口的仓库相对路径；键即线程名。 */
export const THREAD_ENTRY_PATHS: Readonly<Record<string, string>> = {
  main: "index.ts",
  aiChat: join("packages", "workers", "aiChatWorker.ts"),
  antiRaid: join("packages", "workers", "antiRaidWorker.ts"),
  diskIO: join("packages", "workers", "diskIOWorker.ts"),
};

/**
 * `packages/cache/` 的目录名就是这份状态的 owner 线程，见
 * docs/cn/04-invariants.md「缓存的线程归属」。门禁用真实模块图核对声明与事实是否
 * 一致：一份只属于某条线程的状态被别的线程 import，那条线程拿到的是一份永远
 * 对不上的空副本。`perThread/` 不在表内，任何线程都可加载。
 */
export const CACHE_OWNER_BY_PREFIX: readonly CacheOwnerPrefix[] = [
  [join("packages", "cache", "main") + "/", "main"],
  [join("packages", "cache", "workers", "aiChat") + "/", "aiChat"],
  [join("packages", "cache", "workers", "antiRaid") + "/", "antiRaid"],
  [join("packages", "cache", "workers", "diskIO") + "/", "diskIO"],
];

/**
 * 唯一的归属豁免：infra/logger.ts 静态 import infra/diskIO.ts 取 relayLogMessage，
 * 而四条线程都要能记 error 日志。Worker isolate 里那份状态恒为初始值、一次也不
 * 会被读写，见 packages/cache/main/diskIO.ts 的模块头注。
 */
export const CACHE_OWNER_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = {
  [join("packages", "cache", "main", "diskIO.ts")]: ["aiChat", "antiRaid"],
};

export interface CollectCacheOwnershipProblemsParams {
  readonly projectRoot: string;
  readonly cacheFiles: readonly string[];
  readonly threadEntries: Readonly<Record<string, string>>;
  readonly threadClosures: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  readonly ownerByPrefix: readonly CacheOwnerPrefix[];
  readonly exemptions: Readonly<Record<string, readonly string[]>>;
}

/** 按真实线程模块闭包核对 cache owner、perThread 与显式豁免。 */
export function collectCacheOwnershipProblems({
  projectRoot,
  cacheFiles,
  threadEntries,
  threadClosures,
  ownerByPrefix,
  exemptions,
}: CollectCacheOwnershipProblemsParams): readonly string[] {
  const problems: string[] = [];
  for (const path of cacheFiles) {
    const relativePath: string = relative(projectRoot, path);
    const perThread: boolean = relativePath.startsWith(
      join("packages", "cache", "perThread") + "/"
    );
    const owner: string | undefined = ownerByPrefix.find(
      ([prefix]: CacheOwnerPrefix): boolean => relativePath.startsWith(prefix)
    )?.[1];
    if (owner === undefined && !perThread) {
      problems.push(
        `${relativePath} is not under a cache owner directory ` +
        `(expected packages/cache/{main,workers/<thread>,perThread}/)`
      );
      continue;
    }
    const allowed: ReadonlySet<string> = new Set(
      owner === undefined
        ? Object.keys(threadEntries)
        : [owner, ...(exemptions[relativePath] ?? [])]
    );
    for (const [thread, closure] of threadClosures) {
      if (allowed.has(thread)) continue;
      const trail: readonly string[] | undefined = closure.get(path);
      if (trail === undefined) continue;
      const chain: string = trail
        .map((step: string): string => relative(projectRoot, step))
        .join(" -> ");
      problems.push(
        `${relativePath} is owned by the ${owner} thread but is loaded by the ${thread} thread: ${chain}`
      );
    }
  }
  return problems;
}

/**
 * 反向核对豁免表：登记过的文件还在不在，以及被豁免的那条线程是不是真的还会加载它。
 *
 * 正向检查只在「某条线程确实加载了」时才用到豁免，因此引入路径一旦消失，豁免就
 * 再也不会被访问到，会作为一条永不过期的例外留在表里——下一个人看到它，会以为
 * 这条跨线程引入仍然存在且被审过。
 *
 * 与 collectCacheOwnershipProblems 分开导出：那一个按调用方给的文件子集判定，
 * 而整表核对必须拿到 `packages/cache/` 的完整文件集合才有意义。
 */
export function collectStaleCacheExemptionProblems({
  projectRoot,
  cacheFiles,
  threadClosures,
  exemptions,
}: Pick<
  CollectCacheOwnershipProblemsParams,
  "projectRoot" | "cacheFiles" | "threadClosures" | "exemptions"
>): readonly string[] {
  const problems: string[] = [];
  const byRelativePath: Map<string, string> = new Map(
    cacheFiles.map((path: string): [string, string] => [relative(projectRoot, path), path])
  );
  for (const [relativePath, threads] of Object.entries(exemptions)) {
    const path: string | undefined = byRelativePath.get(relativePath);
    if (path === undefined) {
      problems.push(`CACHE_OWNER_EXEMPTIONS retains an exemption for a cache module that no longer exists: ${relativePath}`);
      continue;
    }
    for (const thread of threads) {
      if (threadClosures.get(thread)?.has(path) === true) continue;
      problems.push(
        `CACHE_OWNER_EXEMPTIONS retains an unused exemption: the ${thread} thread no longer loads ${relativePath}`
      );
    }
  }
  return problems;
}
