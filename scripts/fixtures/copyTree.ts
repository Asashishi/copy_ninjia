/** 一次性脚本夹具共用的目录树复制边界。 */

import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 把夹具目录树复制到隔离目标；文件内容统一交给 Bun 原生 I/O，目录语义使用
 * Node 兼容接口。调用方必须先把目标约束在自己的临时根内。
 */
export async function copyFixtureTree(
  source: string,
  destination: string
): Promise<void> {
  if (!statSync(source).isDirectory()) {
    await Bun.write(destination, Bun.file(source));
    return;
  }
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    await copyFixtureTree(join(source, name), join(destination, name));
  }
}
