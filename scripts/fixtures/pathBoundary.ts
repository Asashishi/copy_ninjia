/**
 * 一次性脚本夹具共用的写入边界。
 *
 * 词法判定（`resolve()` 加前缀比较）只看字符串：允许根里的一段软链接指向仓库外
 * 时，路径仍然「在根内」，而真正的建目录、复制和删除全部落到链接目标上。本模块
 * 补上文件系统这一侧——逐段核对锚点到目标之间**已经存在**的分量，任何一段是软
 * 链接就拒绝。
 *
 * 允许根自身也要过同一道核对：只把可疑根的 realpath 当成允许根，等于把逃逸后的
 * 目录直接认成合法落点。
 *
 * 只依赖 `node:fs` / `node:path`，不引入 `packages/` 下的实现模块：全量基准的父
 * 进程要靠这一点保住冷启动那一段的真实模块加载成本，因此 errno 判定也在本文件
 * 内联，不复用 `packages/libs/errno.ts`。
 *
 * 核对只会增加拒绝、不会放宽：目标是否落在允许根内由词法判定先钉死，分量核对
 * 之后只能把「形态合法但真实路径可疑」的再拒掉一批。
 */

import { lstatSync } from "node:fs";
import type { Stats } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** 一个受控写入根的完整描述；每种基准根构造一次并全程复用。 */
export interface FixturePathBoundary {
  /** 锚点绝对路径：仓库根或系统临时目录，其自身不再逐段核对。 */
  readonly anchor: string;
  /** 允许写入的根绝对路径；必须落在锚点之内。 */
  readonly root: string;
  /** 拒绝文案里对调用方的称呼，例如 `Full performance suite`。 */
  readonly subject: string;
}

/**
 * 逐段核对 `from`（不含）到 `to`（含）之间的路径分量。
 *
 * 首个 ENOENT 之后的分量按「尚不存在」处理并结束核对：那一段不存在时它下面也
 * 不可能存在。ENOTDIR、EACCES、ELOOP 等其它错误一律拒绝，不猜测是不是缺省。
 */
function assertUnlinkedComponents(
  from: string,
  to: string,
  boundary: FixturePathBoundary
): void {
  const suffix: string = relative(from, to);
  if (suffix.length === 0) return;
  let current: string = from;
  for (const segment of suffix.split(sep)) {
    current = join(current, segment);
    let stats: Stats;
    try {
      stats = lstatSync(current);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw new Error(
        `${boundary.subject} refused to touch ${to}; ` +
        `${current} could not be inspected.`,
        { cause: error }
      );
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `${boundary.subject} refused to touch ${to}; ` +
        `${current} is a symbolic link and may leave ${boundary.root}.`
      );
    }
  }
}

/**
 * 核对一条目标路径：先是词法落在根内，再是锚点到根、根到目标的现存分量都不是
 * 软链接。建目录、复制和写文件前一律先过这里。
 */
export function assertUnlinkedFixturePath(
  path: string,
  boundary: FixturePathBoundary
): void {
  const resolved: string = resolve(path);
  if (resolved !== boundary.root && !resolved.startsWith(`${boundary.root}${sep}`)) {
    throw new Error(
      `${boundary.subject} refused to touch ${resolved}; ` +
      `every path must live under ${boundary.root}.`
    );
  }
  assertUnlinkedComponents(boundary.anchor, boundary.root, boundary);
  assertUnlinkedComponents(boundary.root, resolved, boundary);
}

/**
 * 删除前只核对父链。末端本身是软链接时保留「只摘链接、不碰目标」的安全语义，
 * 因此不把末端纳入核对；中间任何一段是链接都拒绝。
 */
export function assertUnlinkedFixtureParent(
  path: string,
  boundary: FixturePathBoundary
): void {
  const resolved: string = resolve(path);
  if (!resolved.startsWith(`${boundary.root}${sep}`)) {
    throw new Error(
      `${boundary.subject} refused to touch ${resolved}; ` +
      `every path must live under ${boundary.root}.`
    );
  }
  assertUnlinkedFixturePath(resolve(resolved, ".."), boundary);
}
