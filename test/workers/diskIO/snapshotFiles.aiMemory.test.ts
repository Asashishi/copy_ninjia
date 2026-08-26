import { beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_MEMORY_HYDRATE_BUFFER_MAX, MAX_SUMMARY_ROUNDS } from
  "../../../packages/consts/aiChat/memory";

// 与既有单测同样的手法:先把 AI_MEMORY_DIR 重定向到临时目录再 import,
// 绝不能碰项目真实的 memory/ai/(线上 bot 正在用)。
const aiDir: string = mkdtempSync(join(tmpdir(), "ai-memory-schema-"));
const realPaths = await import("../../../packages/consts/paths");
const { mock } = await import("bun:test");
mock.module("../../../packages/consts/paths", () => ({ ...realPaths, AI_MEMORY_DIR: aiDir }));

const { deleteAiMemoryFile, recoverAiMemories, writeAiMemoryFile } = await import("../../../packages/workers/diskIO/snapshotFiles");

const currentSnapshot = {
  version: 1,
  buffer: [
    { messageId: 111, id: 111, firstName: "太郎", lastName: "山田", text: "こんにちは", at: "2026/07/16 21:35:04" },
    { messageId: 222, id: 222, firstName: "花子", lastName: "", text: "[贴纸:一只猫大笑] 哈哈", at: "2026/07/16 21:36:10" },
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

test("没有 username 的当前 version=1 AI 记忆仍恢复无损,回写字节级一致", () => {
  writeFileSync(join(aiDir, "-100123.json"), currentBytes);

  const recovered = recoverAiMemories();
  expect(recovered.size).toBe(1);
  const json = recovered.get(-100123)!;
  expect(JSON.parse(json)).toEqual(currentSnapshot);
  expect(json).toBe(currentBytes);

  writeAiMemoryFile(-100123, json);
  expect(readFileSync(join(aiDir, "-100123.json"), "utf8")).toBe(currentBytes);
});

test("接管与原子回写均保留部署方已有的 0600", () => {
  const path: string = join(aiDir, "-100123.json");
  writeFileSync(path, currentBytes);
  chmodSync(path, 0o600);

  const recovered: Map<number, string> = recoverAiMemories();
  writeAiMemoryFile(-100123, recovered.get(-100123)!);

  expect(statSync(path).mode & 0o777).toBe(0o600);
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

test("回复对象快照会随 version=1 AI 记忆恢复并回写", () => {
  const snapshotWithReply = {
    ...currentSnapshot,
    buffer: [
      currentSnapshot.buffer[0]!,
      {
        ...currentSnapshot.buffer[1]!,
        messageId: 71,
        replyTo: {
          messageId: 70,
          id: 111,
          firstName: "太郎",
          lastName: "山田",
          username: "taro_dev",
          text: "第一句 第二句",
          quote: "第二句",
        },
      },
    ],
  };
  const bytes: string = JSON.stringify(snapshotWithReply, null, 2);
  writeFileSync(join(aiDir, "-100130.json"), bytes);

  const recovered = recoverAiMemories();
  const json = recovered.get(-100130)!;
  expect(JSON.parse(json)).toEqual(snapshotWithReply);
  expect(json).toBe(bytes);
});

test("当前消息与回复对象的转发来源会随 version=1 AI 记忆恢复并回写", () => {
  const snapshotWithForwardPaths = {
    ...currentSnapshot,
    buffer: [
      currentSnapshot.buffer[0]!,
      {
        ...currentSnapshot.buffer[1]!,
        messageId: 73,
        forwardedFrom: "频道 [id:-100666] 东京日报",
        replyTo: {
          messageId: 72,
          id: 333,
          firstName: "次郎",
          lastName: "",
          text: "另一条转发",
          forwardedFrom: "[id:444] 三郎",
        },
      },
    ],
  };
  const bytes: string = JSON.stringify(snapshotWithForwardPaths, null, 2);
  writeFileSync(join(aiDir, "-100133.json"), bytes);

  const recovered = recoverAiMemories();
  const json = recovered.get(-100133)!;
  expect(JSON.parse(json)).toEqual(snapshotWithForwardPaths);
  expect(json).toBe(bytes);
});

test("缺少当前必填字段时拒绝整次恢复，防止后续快照覆盖待迁移文件", () => {
  writeFileSync(join(aiDir, "-100124.json"), JSON.stringify({
    ...currentSnapshot,
    buffer: [{ id: 111, firstName: "太郎", lastName: "", text: "旧记录", at: "2026/07/16 21:35:04" }],
  }));
  expect(() => recoverAiMemories()).toThrow("current version=1 AI memory schema");
  expect(readFileSync(join(aiDir, "-100124.json"), "utf8")).not.toBe("");
});

test("username 若存在则必须为字符串", () => {
  writeFileSync(join(aiDir, "-100127.json"), JSON.stringify({
    ...currentSnapshot,
    buffer: [{ ...currentSnapshot.buffer[0]!, username: 123 }],
  }));

  expect(() => recoverAiMemories()).toThrow("current version=1 AI memory schema");
});

test("replyTo 若存在则必须是完整合法的回复对象", () => {
  writeFileSync(join(aiDir, "-100131.json"), JSON.stringify({
    ...currentSnapshot,
    buffer: [{ ...currentSnapshot.buffer[0]!, replyTo: { messageId: 7, text: "缺发送者" } }],
  }));

  expect(() => recoverAiMemories()).toThrow("current version=1 AI memory schema");
});

test("超出冷摘要容量时拒绝恢复且不改写文件", () => {
  const summaries: string[] = Array.from({ length: MAX_SUMMARY_ROUNDS + 2 }, (_, index: number) => `摘要${index + 1}`);
  const path: string = join(aiDir, "-100128.json");
  const bytes: string = JSON.stringify({
    ...currentSnapshot,
    summaries,
  });
  writeFileSync(path, bytes);

  expect(() => recoverAiMemories()).toThrow("within configured capacities");
  expect(readFileSync(path, "utf8")).toBe(bytes);
});

test("超出逐字消息容量时拒绝恢复且不改写文件", () => {
  const buffer = Array.from({ length: AI_MEMORY_HYDRATE_BUFFER_MAX + 2 }, (_, index: number) => ({
    messageId: index + 1,
    id: index + 1,
    firstName: `用户${index + 1}`,
    lastName: "",
    text: `消息${index + 1}`,
    at: "2026/07/22 20:00:00",
  }));
  const path: string = join(aiDir, "-100132.json");
  const bytes: string = JSON.stringify({
    ...currentSnapshot,
    buffer,
  });
  writeFileSync(path, bytes);

  expect(() => recoverAiMemories()).toThrow("within configured capacities");
  expect(readFileSync(path, "utf8")).toBe(bytes);
});

test("删除记忆文件幂等且不会留下快照", () => {
  const path: string = join(aiDir, "-100129.json");
  writeFileSync(path, currentBytes);

  deleteAiMemoryFile(-100129);
  expect(() => readFileSync(path, "utf8")).toThrow();
  expect(() => deleteAiMemoryFile(-100129)).not.toThrow();
});

test("文件名不能原样还原成 chatId 时拒绝恢复，不按目录顺序选一份", () => {
  // 正则只保证「一串数字」：补零变体也匹配，Number 之后是同一个 key，于是两份
  // 快照互相覆盖、胜者取决于 readdirSync 的枚举顺序。而回写只用 `${chatId}.json`，
  // 补零那份永不被改写或删除，每次重启继续顶替（同 blocklistFile.ts 的回环校验）。
  writeFileSync(join(aiDir, "-100123.json"), currentBytes);
  writeFileSync(join(aiDir, "-0100123.json"), JSON.stringify({
    ...currentSnapshot,
    summaries: ["补零文件里的旧摘要"],
  }, null, 2));

  expect(() => recoverAiMemories()).toThrow("canonical <chatId>.json form");
  expect(readFileSync(join(aiDir, "-100123.json"), "utf8")).toBe(currentBytes);
});

test("位数超出安全整数的文件名同样拒绝恢复", () => {
  // 1e20 那种水合出来的 key 与任何真实 chatId 都对不上，下次落盘还会生成一个
  // 全新文件，旧文件永远留在盘上。
  writeFileSync(join(aiDir, "99999999999999999999.json"), currentBytes);

  expect(() => recoverAiMemories()).toThrow("negative safe integer Telegram group or channel ID");
});

test("chatId 为零的文件名拒绝恢复", () => {
  writeFileSync(join(aiDir, "0.json"), currentBytes);

  expect(() => recoverAiMemories()).toThrow("negative safe integer Telegram group or channel ID");
});

test("正数私聊 ID 的文件名拒绝恢复", () => {
  writeFileSync(join(aiDir, "100123.json"), currentBytes);

  expect(() => recoverAiMemories()).toThrow("negative safe integer Telegram group or channel ID");
});
