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
