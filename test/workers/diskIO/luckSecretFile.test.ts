import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverLuckReceiptSecret, type LuckSecretFileIO } from "../../../packages/workers/diskIO/luckSecretFile";

const dir: string = mkdtempSync(join(tmpdir(), "luck-secret-test-"));
const path: string = join(dir, "receipt-secret.json");

beforeEach(() => rmSync(path, { recursive: true, force: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("daily luck receipt secret file", () => {
  test("文件缺失时以 0644 创建，同日重载复用密钥并保留部署方收紧的 mode", async () => {
    // 即使生产进程使用严格 umask，rename 前也会 fchmod 成 0644。
    const previousUmask: number = process.umask(0o077);
    let created: Awaited<ReturnType<typeof recoverLuckReceiptSecret>>;
    try {
      created = await recoverLuckReceiptSecret({ day: "2026-07-19", confirmedResultCount: 0, path });
    } finally {
      process.umask(previousUmask);
    }
    const loaded = await recoverLuckReceiptSecret({ day: "2026-07-19", confirmedResultCount: 3, path });
    expect(loaded).toEqual(created);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(created);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    chmodSync(path, 0o600);
    await recoverLuckReceiptSecret({ day: "2026-07-19", confirmedResultCount: 3, path });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("东京日期前进时生成新密钥并原子替换旧日文件", async () => {
    const previous = await recoverLuckReceiptSecret({ day: "2026-07-19", confirmedResultCount: 0, path });
    const next = await recoverLuckReceiptSecret({ day: "2026-07-20", confirmedResultCount: 0, path });
    expect(next.day).toBe("2026-07-20");
    expect(next.key).not.toBe(previous.key);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(next);
  });

  test("损坏 JSON、错误 schema、非法 key 和未来日期均拒绝且不覆盖原文件", async () => {
    const invalidContents = [
      "{broken",
      JSON.stringify({
        version: 2,
        day: "2026-07-19",
        key: new Uint8Array(32).toBase64({ alphabet: "base64url", omitPadding: true }),
      }),
      JSON.stringify({
        version: 1,
        day: "2026-02-30",
        key: new Uint8Array(32).toBase64({ alphabet: "base64url", omitPadding: true }),
      }),
      JSON.stringify({ version: 1, day: "2026-07-19", key: "short" }),
      JSON.stringify({
        version: 1,
        day: "2026-07-20",
        key: new Uint8Array(32).toBase64({ alphabet: "base64url", omitPadding: true }),
      }),
    ];
    for (const content of invalidContents) {
      writeFileSync(path, content);
      await expect(recoverLuckReceiptSecret({ day: "2026-07-19", confirmedResultCount: 0, path })).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe(content);
    }
  });

  test("首次原子写失败时明确抛错，不留下伪成功文件", async () => {
    const io: LuckSecretFileIO = {
      generateKey: () => new Uint8Array(32).fill(1),
      writeText: () => { throw new Error("disk full"); },
    };
    await expect(recoverLuckReceiptSecret({
      day: "2026-07-19",
      confirmedResultCount: 0,
      path,
      io,
    })).rejects.toThrow("disk full");
    expect(existsSync(path)).toBe(false);
  });

  test("当天已有确认结果时，密钥缺失会拒绝铸造并保留缺失现场", async () => {
    await expect(recoverLuckReceiptSecret({
      day: "2026-07-19",
      confirmedResultCount: 2,
      path,
    })).rejects.toThrow("must be present for the same day as the confirmed luck state");
    expect(existsSync(path)).toBe(false);
  });

  test("当天已有确认结果时，旧日密钥会拒绝轮换并保留原文件", async () => {
    const previous = await recoverLuckReceiptSecret({ day: "2026-07-19", confirmedResultCount: 0, path });
    const original: string = readFileSync(path, "utf8");

    await expect(recoverLuckReceiptSecret({
      day: "2026-07-20",
      confirmedResultCount: 1,
      path,
    })).rejects.toThrow("must be present for the same day as the confirmed luck state");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(JSON.parse(original)).toEqual(previous);
  });
});
