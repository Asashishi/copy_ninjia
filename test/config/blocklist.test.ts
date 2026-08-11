import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLegacyBlocklistConfig,
  loadLegacyWhitelistConfig,
} from "../../scripts/identityStorageMigration/legacy";

function withLegacyFile(value: unknown, run: (path: string) => void): void {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-legacy-config-"));
  const path: string = join(root, "input.json");
  try {
    writeFileSync(path, JSON.stringify(value));
    run(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("身份存储迁移的旧配置严格解析", () => {
  test("白名单补齐权限默认值，保留正用户与负频道 ID", () => {
    withLegacyFile({ "7": { isCanBlock: true }, "-1004": {} }, (path: string): void => {
      const parsed = loadLegacyWhitelistConfig(path);
      expect(parsed.get(7)?.isCanBlock).toBeTrue();
      expect(parsed.has(-1004)).toBeTrue();
    });
  });

  test("静态黑名单拒绝重复、零和非整数", () => {
    for (const blockedIds of [[7, 7], [0], [1.5]]) {
      withLegacyFile({ blockedIds }, (path: string): void => {
        expect(() => loadLegacyBlocklistConfig(path)).toThrow();
      });
    }
  });

  test("白名单拒绝未知权限和非规范 ID", () => {
    withLegacyFile({ "01": {} }, (path: string): void => {
      expect(() => loadLegacyWhitelistConfig(path)).toThrow();
    });
    withLegacyFile({ "7": { nope: true } }, (path: string): void => {
      expect(() => loadLegacyWhitelistConfig(path)).toThrow();
    });
  });
});
