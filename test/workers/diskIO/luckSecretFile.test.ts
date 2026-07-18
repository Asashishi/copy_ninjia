import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverLuckReceiptSecret, type LuckSecretFileIO } from "../../../src/workers/diskIO/luckSecretFile";

const dir: string = mkdtempSync(join(tmpdir(), "luck-secret-test-"));
const path: string = join(dir, "receipt-secret.json");

beforeEach(() => rmSync(path, { recursive: true, force: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("daily luck receipt secret file", () => {
  test("文件缺失时原子创建，同日重载复用同一密钥并保持 0600", () => {
    const created = recoverLuckReceiptSecret("2026-07-19", path);
    const loaded = recoverLuckReceiptSecret("2026-07-19", path);
    expect(loaded).toEqual(created);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(created);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("东京日期前进时生成新密钥并原子替换旧日文件", () => {
    const previous = recoverLuckReceiptSecret("2026-07-19", path);
    const next = recoverLuckReceiptSecret("2026-07-20", path);
    expect(next.day).toBe("2026-07-20");
    expect(next.key).not.toBe(previous.key);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(next);
  });

  test("损坏 JSON、错误 schema、非法 key 和未来日期均拒绝且不覆盖原文件", () => {
    const invalidContents = [
      "{broken",
      JSON.stringify({ version: 2, day: "2026-07-19", key: Buffer.alloc(32).toString("base64url") }),
      JSON.stringify({ version: 1, day: "2026-07-19", key: "short" }),
      JSON.stringify({ version: 1, day: "2026-07-20", key: Buffer.alloc(32).toString("base64url") }),
    ];
    for (const content of invalidContents) {
      writeFileSync(path, content);
      expect(() => recoverLuckReceiptSecret("2026-07-19", path)).toThrow();
      expect(readFileSync(path, "utf8")).toBe(content);
    }
  });

  test("首次原子写失败时明确抛错，不留下伪成功文件", () => {
    const io: LuckSecretFileIO = {
      generateKey: () => Buffer.alloc(32, 1),
      writeText: () => { throw new Error("disk full"); },
      chmod: () => {},
    };
    expect(() => recoverLuckReceiptSecret("2026-07-19", path, io)).toThrow("disk full");
    expect(existsSync(path)).toBe(false);
  });
});
