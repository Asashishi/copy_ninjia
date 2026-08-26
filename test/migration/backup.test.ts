import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  manifestEntry,
  sha256,
  writeVerifiedBackup,
  writeVerifiedBackupManifest,
} from "../../scripts/migration/backup";
import {
  runLockedMigration,
  runWithRetainedBackup,
} from "../../scripts/migration/lifecycle";
import type { BackupManifestEntry } from "../../scripts/migration/backup";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root: string = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach((): void => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("冷迁移外部备份原语", () => {
  test("数据副本与清单都不覆盖、读回一致且保持私有权限", () => {
    const root: string = temporaryRoot("copy-ninjia-backup-test-");
    const sourcePath: string = join(root, "source.json");
    const bytes: Uint8Array = new TextEncoder().encode("sensitive deployment bytes");
    writeFileSync(sourcePath, bytes, { mode: 0o640 });

    writeVerifiedBackup(root, "state.json", bytes);
    const entry: BackupManifestEntry = manifestEntry(
      sourcePath,
      "state.json",
      bytes
    );
    writeVerifiedBackupManifest(root, [entry]);

    expect(readFileSync(join(root, "state.json"))).toEqual(Buffer.from(bytes));
    expect(statSync(join(root, "state.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))).toEqual([{
      ...entry,
      sha256: sha256(bytes),
    }]);
    expect((): void => writeVerifiedBackup(root, "state.json", bytes)).toThrow();
    expect((): void => writeVerifiedBackupManifest(root, [entry])).toThrow();
  });
});

describe("冷迁移锁与失败上下文", () => {
  test("取得锁失败时不解锁，成功时严格 acquire → run → release", async () => {
    const events: string[] = [];
    const acquireFailure: Error = new Error("lock busy");
    const release = mock(async (): Promise<void> => { events.push("release"); });

    await expect(runLockedMigration({
      acquire: async (): Promise<void> => { throw acquireFailure; },
      release,
      run: (): string => "unreachable",
    })).rejects.toBe(acquireFailure);
    expect(release).not.toHaveBeenCalled();

    await expect(runLockedMigration({
      acquire: async (): Promise<void> => { events.push("acquire"); },
      run: (): string => {
        events.push("run");
        return "ok";
      },
      release,
    })).resolves.toBe("ok");
    expect(events).toEqual(["acquire", "run", "release"]);
  });

  test("迁移与解锁双重失败时保留首错，并报告解锁也失败", async () => {
    const migrationFailure: Error = new Error("write failed");
    await expect(runLockedMigration({
      acquire: async (): Promise<void> => {},
      run: (): never => { throw migrationFailure; },
      release: async (): Promise<void> => { throw new Error("unlock failed"); },
    })).rejects.toThrow("write failed Lock release also failed");
  });

  test("备份完成后的任意失败都带恢复根路径且保留 cause", async () => {
    const failure: Error = new Error("rename failed");
    try {
      await runWithRetainedBackup({
        backupRoot: "/tmp/retained-backup",
        run: (): never => { throw failure; },
      });
      throw new Error("Expected retained-backup wrapper to reject.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("/tmp/retained-backup");
      expect((error as Error).message).toContain("rename failed");
      expect((error as Error).cause).toBe(failure);
    }
  });
});
