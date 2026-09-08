/** 一次性脚本夹具共用的目录树复制边界。 */

import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 把夹具目录树复制到隔离目标；文件内容统一交给 Bun 原生 I/O，目录语义使用
 * Node 兼容接口。调用方必须先把目标约束在自己的临时根内。
 *
 * @param assertDestination 每个落点在建目录或写文件**之前**过一次的校验；目标树
 *   已经存在时，残留的软链接会让复制写到临时根之外，调用方据此逐段拒绝。缺省时
 *   不做额外校验，仅用于调用方已经完全掌控目标树的场景。
 */
export async function copyFixtureTree(
  source: string,
  destination: string,
  assertDestination?: (path: string) => void
): Promise<void> {
  assertDestination?.(destination);
  if (!statSync(source).isDirectory()) {
    await Bun.write(destination, Bun.file(source));
    return;
  }
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    await copyFixtureTree(join(source, name), join(destination, name), assertDestination);
  }
}
