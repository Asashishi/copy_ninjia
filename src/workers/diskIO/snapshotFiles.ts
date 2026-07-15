/**
 * memory/ai/ 的启动恢复读取、结构校验与落盘。被 diskIOWorker.ts 调用；
 * 本文件不持有任何状态，纯函数式的读写辅助。
 *
 * AI 记忆快照是整份覆盖写：先写 <file>.tmp 再 rename，rename 在同一文件
 * 系统内是原子操作，进程如果在这中间被杀（OOM/断电/容器被回收），目标
 * 文件要么是写入前的旧内容，要么是写入后的新内容，不会停在半截的撕裂
 * JSON（同 infra/storage.ts persistStateJson 的原子性理由）——快照本身
 * 有固定上限（AI_MEMORY_HYDRATE_BUFFER_MAX/MAX_SUMMARY_ROUNDS），整份
 * 重写的开销不随时间增长，没有必要为它换成追加写。
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AiMemorySnapshot, BufferedMessage } from "../../types";
import { AI_MEMORY_DIR } from "../../consts/paths";
import { AI_MEMORY_FILE_PATTERN } from "../../consts/diskIO";
import { AI_MEMORY_HYDRATE_BUFFER_MAX, MAX_SUMMARY_ROUNDS } from "../../consts/aiChat";

function atomicWriteJson(path: string, value: unknown): void {
  const tmpPath: string = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  renameSync(tmpPath, path);
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 删除失败（权限问题等）不影响主流程，下次同样的清理还会再试一次。
  }
}

/** 解析失败的文件重命名隔离，不静默删除——留排查线索（对齐 loadState 的做法）。 */
function quarantine(path: string): void {
  try {
    renameSync(path, `${path}.corrupt`);
  } catch (error) {
    console.error(`[diskIOWorker] failed to quarantine ${path}:`, error);
  }
}

function isBufferedMessage(value: unknown): value is BufferedMessage {
  if (!value || typeof value !== "object") return false;
  const v: any = value;
  return typeof v.id === "number" && typeof v.firstName === "string" && typeof v.lastName === "string" && typeof v.text === "string";
}

/** 逐字段白名单重建（对齐 infra/storage.ts loadState 的做法），未知字段自然甩掉。 */
function rebuildAiMemorySnapshot(parsed: unknown): AiMemorySnapshot | null {
  if (!parsed || typeof parsed !== "object") return null;
  const raw: any = parsed;
  const buffer: BufferedMessage[] = Array.isArray(raw.buffer)
    ? raw.buffer.filter(isBufferedMessage).slice(-AI_MEMORY_HYDRATE_BUFFER_MAX)
    : [];
  const summaries: string[] = Array.isArray(raw.summaries)
    ? raw.summaries.filter((s: unknown): s is string => typeof s === "string").slice(-MAX_SUMMARY_ROUNDS)
    : [];
  const pendingSummary: string | null = typeof raw.pendingSummary === "string" ? raw.pendingSummary : null;
  const savedAt: number = typeof raw.savedAt === "number" ? raw.savedAt : Date.now();
  return { version: 1, buffer, summaries, pendingSummary, savedAt };
}

/**
 * 启动恢复：建目录、清 memory/ai/ 下的 *.tmp 残留（上次写一半的残留；
 * rename 原子性保证正式文件永远完好），校验/重建每个群的快照。文件名
 * 不是整数（chatId）的跳过；JSON.parse 失败的隔离为 .corrupt 并记日志。
 */
export function recoverAiMemories(): Map<number, AiMemorySnapshot> {
  mkdirSync(AI_MEMORY_DIR, { recursive: true });
  const result: Map<number, AiMemorySnapshot> = new Map();
  for (const name of readdirSync(AI_MEMORY_DIR)) {
    const path: string = join(AI_MEMORY_DIR, name);
    if (name.endsWith(".tmp")) {
      tryUnlink(path);
      continue;
    }
    const match = AI_MEMORY_FILE_PATTERN.exec(name);
    if (!match) continue; // 非 <chatId>.json 形态（含 .corrupt 隔离文件），跳过不动
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      quarantine(path);
      console.error(`[diskIOWorker] AI memory file ${name} failed to parse, quarantined as .corrupt:`, error);
      continue;
    }
    const snapshot: AiMemorySnapshot | null = rebuildAiMemorySnapshot(parsed);
    if (snapshot) result.set(Number(match[1]), snapshot);
  }
  return result;
}

/**
 * 覆盖式写入某群的 AI 记忆快照（tmp + rename 原子落盘）。目录正常总已由
 * recoverAiMemories（启动恢复）建好；这里仍重建一次（recursive 下已存在
 * 时是廉价的空操作）防御外部干预（比如运行期间该目录被手动删除）——否则
 * 一旦目录消失，写入会持续 ENOENT 失败且没有谁会重新把它建回来。
 */
export function writeAiMemoryFile(chatId: number, snapshot: AiMemorySnapshot): void {
  mkdirSync(AI_MEMORY_DIR, { recursive: true });
  atomicWriteJson(join(AI_MEMORY_DIR, `${chatId}.json`), snapshot);
}
