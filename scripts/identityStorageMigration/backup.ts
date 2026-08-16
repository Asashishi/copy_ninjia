import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  BLOCKLIST_CONFIG_PATH,
  BLOCKLIST_MEMORY_DIR,
  WHITELIST_CONFIG_PATH,
} from "../../packages/consts/paths";
import {
  collectMigrationFiles,
  fsyncMigrationDirectoryTree,
  fsyncMigrationPath,
  migrationFileSha256,
} from "./filesystem";

interface BackupManifestEntry {
  readonly relativePath: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly sha256: string;
}

/** 验证迁移进程与旧结构属于同一部署账号，避免生成不可写的新数据。 */
export function assertSourceOwnership(): void {
  const currentUid: number | undefined = typeof process.getuid === "function"
    ? process.getuid()
    : undefined;
  if (currentUid === undefined) return;
  for (const path of [
    WHITELIST_CONFIG_PATH,
    BLOCKLIST_CONFIG_PATH,
    BLOCKLIST_MEMORY_DIR,
  ]) {
    if (existsSync(path) && statSync(path).uid !== currentUid) {
      throw new Error(
        `${path}: owner uid must match the migration and service account uid ${currentUid}.`
      );
    }
  }
}

/**
 * 在工作树外建立逐文件哈希、权限与属主清单，并同步完整备份目录树。
 * 任一步失败都会清除未完成的临时目录；成功备份由部署方长期保留。
 */
export function backupMigrationSources(): string {
  const backupRoot: string = mkdtempSync(
    join(tmpdir(), "copy-ninjia-identity-migration-")
  );
  const sources: readonly (readonly [string, string])[] = [
    [WHITELIST_CONFIG_PATH, join("config", basename(WHITELIST_CONFIG_PATH))],
    [BLOCKLIST_CONFIG_PATH, join("config", basename(BLOCKLIST_CONFIG_PATH))],
    [BLOCKLIST_MEMORY_DIR, join("memory", basename(BLOCKLIST_MEMORY_DIR))],
  ];
  const manifest: BackupManifestEntry[] = [];
  let completed: boolean = false;
  try {
    for (const [source, relativeTarget] of sources) {
      if (!existsSync(source)) continue;
      const sourceStats: ReturnType<typeof lstatSync> = lstatSync(source);
      if (sourceStats.isSymbolicLink()) {
        throw new Error(
          `${source}: migration sources must not be symbolic links.`
        );
      }
      const target: string = join(backupRoot, relativeTarget);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (sourceStats.isDirectory()) {
        cpSync(source, target, {
          recursive: true,
          preserveTimestamps: true,
          errorOnExist: true,
        });
      } else if (sourceStats.isFile()) {
        copyFileSync(source, target);
      } else {
        throw new Error(
          `${source}: migration sources must be regular files or directories.`
        );
      }
      const root: string = sourceStats.isDirectory() ? source : dirname(source);
      const relativeFiles: string[] = sourceStats.isDirectory()
        ? collectMigrationFiles(source)
        : [basename(source)];
      for (const relativeFile of relativeFiles) {
        const sourceFile: string = join(root, relativeFile);
        const backupRelativePath: string = sourceStats.isDirectory()
          ? join(relativeTarget, relativeFile)
          : relativeTarget;
        const backupFile: string = join(backupRoot, backupRelativePath);
        const stats: ReturnType<typeof statSync> = statSync(sourceFile);
        const sourceHash: string = migrationFileSha256(sourceFile);
        const backupStats: ReturnType<typeof statSync> = statSync(backupFile);
        const backupHash: string = migrationFileSha256(backupFile);
        if (backupStats.size !== stats.size || backupHash !== sourceHash) {
          throw new Error(
            `${sourceFile}: external migration backup verification failed.`
          );
        }
        fsyncMigrationPath(backupFile);
        manifest.push({
          relativePath: backupRelativePath,
          mode: stats.mode & 0o777,
          uid: stats.uid,
          gid: stats.gid,
          size: stats.size,
          sha256: sourceHash,
        });
      }
    }
    const manifestPath: string = join(backupRoot, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    fsyncMigrationPath(manifestPath);
    fsyncMigrationDirectoryTree(backupRoot);
    completed = true;
    return backupRoot;
  } finally {
    if (!completed) rmSync(backupRoot, { recursive: true, force: true });
  }
}

/** SQLite 发布并验证完成后删除旧身份结构。 */
export function deleteOldIdentityStructures(): void {
  unlinkSync(WHITELIST_CONFIG_PATH);
  unlinkSync(BLOCKLIST_CONFIG_PATH);
  if (existsSync(BLOCKLIST_MEMORY_DIR)) {
    rmSync(BLOCKLIST_MEMORY_DIR, { recursive: true });
  }
}
