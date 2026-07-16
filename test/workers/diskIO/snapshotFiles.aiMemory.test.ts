import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 与既有单测同样的手法:先把 AI_MEMORY_DIR 重定向到临时目录再 import,
// 绝不能碰项目真实的 memory/ai/(线上 bot 正在用)。
const aiDir: string = mkdtempSync(join(tmpdir(), "ai-memory-compat-"));
const realPaths = await import("../../../src/consts/paths");
const { mock } = await import("bun:test");
mock.module("../../../src/consts/paths", () => ({ ...realPaths, AI_MEMORY_DIR: aiDir }));

const { recoverAiMemories, writeAiMemoryFile } = await import("../../../src/workers/diskIO/snapshotFiles");

// 修改前代码写出的文件形态:JSON.stringify(snapshot, null, 2)
const oldSnapshot = {
  version: 1,
  buffer: [
    { id: 111, firstName: "太郎", lastName: "山田", text: "こんにちは", at: "2026/07/16 21:35:04" },
    { id: 222, firstName: "花子", lastName: "", text: "[贴纸:一只猫大笑] 哈哈", at: "2026/07/16 21:36:10" },
  ],
  summaries: ["第一轮摘要", "第二轮摘要"],
  pendingSummary: "待晋升摘要",
  savedAt: 1752650000000,
};
const oldBytes: string = JSON.stringify(oldSnapshot, null, 2);

test("旧格式 AI 记忆文件:恢复内容无损,回写字节级一致", () => {
  writeFileSync(join(aiDir, "-100123.json"), oldBytes);

  const recovered = recoverAiMemories();
  expect(recovered.size).toBe(1);
  const json = recovered.get(-100123)!;
  // 恢复(重建校验 + 重新 stringify)后内容与旧文件完全一致
  expect(JSON.parse(json)).toEqual(oldSnapshot);
  expect(json).toBe(oldBytes);

  // 新写入路径(源头字符串直写)产出的文件与旧代码产出逐字节相同
  writeAiMemoryFile(-100123, json);
  expect(readFileSync(join(aiDir, "-100123.json"), "utf8")).toBe(oldBytes);
});
