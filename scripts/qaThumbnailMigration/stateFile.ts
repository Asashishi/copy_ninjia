/**
 * `state.global.assets.qaThumbnailUrl` 退场冷迁移的文件级逻辑。
 *
 * 与 CLI 入口分开，是为了让「摘键」这件事可以脱离 `bot.lock`、`BOT_TOKEN` 与真实
 * 数据根被直接验证——入口只负责取锁、备份与决定跑哪一步。
 */

import { lstatSync } from "node:fs";
import { decodeStateFile } from "../../packages/libs/stateFileCodec";
import { atomicWriteTextSync } from "../../packages/libs/atomicFile";
import { isErrno } from "../../packages/libs/errno";

/** 本次要摘掉的键；只此一个，多余的键仍按「存在但非法」由启动期拒绝。 */
export const RETIRED_ASSET_KEY: string = "qaThumbnailUrl";

/** 一份待处理的磁盘副本：原文，以及是否真的带着退场字段。 */
export interface StateFileInspection {
  readonly path: string;
  readonly content: string;
  readonly hasRetiredKey: boolean;
}

/**
 * `global.assets` 里是否带着退场字段；结构对不上时按「没有」处理。
 *
 * 这里刻意**不**校验整份文件：迁移只负责摘掉一个键，其余字段合不合法由启动期
 * 那套严格解析判定，两边职责不重叠。带 `undefined` 值的键同样算存在——严格
 * 解析看的是键在不在，不是值是什么。
 */
export function hasRetiredAssetKey(raw: Record<string, unknown>): boolean {
  const global: unknown = raw.global;
  if (global === null || typeof global !== "object") return false;
  const assets: unknown = (global as Record<string, unknown>).assets;
  if (assets === null || typeof assets !== "object") return false;
  return RETIRED_ASSET_KEY in (assets as Record<string, unknown>);
}

/**
 * 读出一份 state 副本；文件不存在时返回 null——缺 `.bak` 是正常部署形态。
 *
 * 解析不出 JSON 对象时抛错而不是跳过：那说明这份文件本来就坏了，摘键之前
 * 先让人看见，别在一份坏文件上继续动手。
 */
export async function inspectStateFile(
  path: string
): Promise<StateFileInspection | null> {
  try {
    const stats: ReturnType<typeof lstatSync> = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`${path}: cold migration sources must be regular files, not symbolic links.`);
    }
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  const content: string = await Bun.file(path).text();
  const parsed: unknown = JSON.parse(content);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: state file must decode to a JSON object.`);
  }
  return {
    path,
    content,
    hasRetiredKey: hasRetiredAssetKey(parsed as Record<string, unknown>),
  };
}

/**
 * 摘掉退场字段后的 JSON 文本；序列化口径与运行时落盘一致（2 空格缩进）。
 *
 * 摘完立刻按启动期那套严格 codec 复核：写出去的必须是新版本读得回来的，
 * 否则这次迁移只是把「启动失败」推迟到运维离开之后。
 */
export function withoutRetiredKey(content: string): string {
  const raw: Record<string, unknown> = JSON.parse(content) as Record<string, unknown>;
  const global: Record<string, unknown> = raw.global as Record<string, unknown>;
  const assets: Record<string, unknown> = global.assets as Record<string, unknown>;
  delete assets[RETIRED_ASSET_KEY];
  const json: string = JSON.stringify(raw, null, 2);
  decodeStateFile(JSON.parse(json));
  return json;
}

/** 就地改写一份副本并保留原有权限位；写完读回复核内容与解析结果。 */
export async function rewriteStateFile(path: string, json: string): Promise<void> {
  atomicWriteTextSync(path, json);
  const persisted: string = await Bun.file(path).text();
  if (persisted !== json) {
    throw new Error(`${path}: state file rewrite verification failed.`);
  }
  decodeStateFile(JSON.parse(persisted));
}
