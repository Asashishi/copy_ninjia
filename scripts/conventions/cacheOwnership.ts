import { join, relative } from "node:path";

/** cache 顶层目录与 owner 线程的映射。 */
export type CacheOwnerPrefix = readonly [prefix: string, owner: string];

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
