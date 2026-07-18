import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SUMMARY_ROUNDS } from "../../../src/consts/aiChat";

// 与既有单测同样的手法:先把 AI_MEMORY_DIR 重定向到临时目录再 import,
// 绝不能碰项目真实的 memory/ai/(线上 bot 正在用)。
const aiDir: string = mkdtempSync(join(tmpdir(), "ai-memory-schema-"));
const realPaths = await import("../../../src/consts/paths");
const { mock } = await import("bun:test");
mock.module("../../../src/consts/paths", () => ({ ...realPaths, AI_MEMORY_DIR: aiDir }));

const { deleteAiMemoryFile, recoverAiMemories, writeAiMemoryFile } = await import("../../../src/workers/diskIO/snapshotFiles");

const currentSnapshot = {
  version: 1,
  buffer: [
    { id: 111, firstName: "太郎", lastName: "山田", text: "こんにちは", at: "2026/07/16 21:35:04" },
    { id: 222, firstName: "花子", lastName: "", text: "[贴纸:一只猫大笑] 哈哈", at: "2026/07/16 21:36:10" },
  ],
  summaries: ["第一轮摘要", "第二轮摘要"],
  pendingSummary: "待晋升摘要",
  savedAt: 1752650000000,
};
const currentBytes: string = JSON.stringify(currentSnapshot, null, 2);

beforeEach(() => {
  rmSync(aiDir, { recursive: true, force: true });
  mkdirSync(aiDir, { recursive: true });
});

test("旧版无 username 的 version=1 AI 记忆仍恢复无损,回写字节级一致", () => {
  writeFileSync(join(aiDir, "-100123.json"), currentBytes);

  const recovered = recoverAiMemories();
  expect(recovered.size).toBe(1);
  const json = recovered.get(-100123)!;
  expect(JSON.parse(json)).toEqual(currentSnapshot);
  expect(json).toBe(currentBytes);

  writeAiMemoryFile(-100123, json);
  expect(readFileSync(join(aiDir, "-100123.json"), "utf8")).toBe(currentBytes);
});

test("新版可选 username 会随 version=1 AI 记忆恢复并回写", () => {
  const snapshotWithUsername = {
    ...currentSnapshot,
    buffer: [
      { ...currentSnapshot.buffer[0]!, username: "taro_dev" },
      currentSnapshot.buffer[1]!,
    ],
  };
  const bytes: string = JSON.stringify(snapshotWithUsername, null, 2);
  writeFileSync(join(aiDir, "-100126.json"), bytes);

  const recovered = recoverAiMemories();
  expect(recovered.size).toBe(1);
  const json = recovered.get(-100126)!;
  expect(JSON.parse(json)).toEqual(snapshotWithUsername);
  expect(json).toBe(bytes);

  writeAiMemoryFile(-100126, json);
  expect(readFileSync(join(aiDir, "-100126.json"), "utf8")).toBe(bytes);
});

test("缺少当前必填字段时拒绝整次恢复，防止后续快照覆盖待迁移文件", () => {
  writeFileSync(join(aiDir, "-100124.json"), JSON.stringify({
    ...currentSnapshot,
    buffer: [{ id: 111, firstName: "太郎", lastName: "", text: "旧记录", at: 1752650000000 }],
  }));
  expect(() => recoverAiMemories()).toThrow("migrate it manually before starting");
  expect(readFileSync(join(aiDir, "-100124.json"), "utf8")).not.toBe("");
});

test("username 若存在则必须为字符串", () => {
  writeFileSync(join(aiDir, "-100127.json"), JSON.stringify({
    ...currentSnapshot,
    buffer: [{ ...currentSnapshot.buffer[0]!, username: 123 }],
  }));

  expect(() => recoverAiMemories()).toThrow("migrate it manually before starting");
});

test("恢复时只保留配置数量的最新冷摘要", () => {
  const summaries: string[] = Array.from({ length: MAX_SUMMARY_ROUNDS + 2 }, (_, index: number) => `摘要${index + 1}`);
  writeFileSync(join(aiDir, "-100128.json"), JSON.stringify({
    ...currentSnapshot,
    summaries,
  }));

  const recovered = recoverAiMemories();
  expect(JSON.parse(recovered.get(-100128)!).summaries).toEqual(summaries.slice(-MAX_SUMMARY_ROUNDS));
});

test("删除记忆文件幂等且不会留下快照", () => {
  const path: string = join(aiDir, "-100129.json");
  writeFileSync(path, currentBytes);

  deleteAiMemoryFile(-100129);
  expect(() => readFileSync(path, "utf8")).toThrow();
  expect(() => deleteAiMemoryFile(-100129)).not.toThrow();
});
