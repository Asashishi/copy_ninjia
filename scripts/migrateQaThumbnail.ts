/**
 * `state.global.assets.qaThumbnailUrl` 退场的冷迁移入口。
 *
 * `/set_qa` 从 inline 表单改成按「问题:」「回答:」格式收消息之后，那张 inline
 * 结果缩略图再没有消费方，字段随之从 schema 里删除。而 state.json 是**严格解析**
 * 的（见 libs/stateFileCodec.ts 的 knownKeys）：文件里残留这个键会让新版本在
 * 启动阶段以非零码退出，而不是静默忽略。本脚本负责把它摘掉。
 *
 * 处理**两份磁盘副本**：state.json 与同目录的 state.json.bak。两者共用同一套
 * 严格 schema，只改主文件的话，主文件损坏后回退到 .bak 仍会启动失败。
 *
 * `--check` 与 `--apply` 都取得 `bot.lock`，确保只在服务停止后读取一致来源。
 * 写入前在工作树外保留原文快照及权限、属主、SHA-256 清单。摘键本身幂等：
 * 已经跑过的部署再跑一次只会报「已完成」，不碰任何文件。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BOT_TOKEN } from "../packages/config/telegram";
import { STATE_BACKUP_FILE_PATH, STATE_FILE_PATH } from "../packages/consts/paths";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from
  "../packages/infra/storage/instanceLock";
import {
  manifestEntry,
  writeVerifiedBackup,
  writeVerifiedBackupManifest,
} from "./migration/backup";
import type { BackupManifestEntry } from "./migration/backup";
import {
  inspectStateFile,
  RETIRED_ASSET_KEY,
  rewriteStateFile,
  withoutRetiredKey,
} from "./qaThumbnailMigration/stateFile";
import type { StateFileInspection } from "./qaThumbnailMigration/stateFile";
import {
  retainedBackupError,
  runLockedMigration,
  runWithRetainedBackup,
} from "./migration/lifecycle";

type MigrationLockOperation = (botToken: string) => Promise<void>;

/** qa-thumbnail 冷迁移入口可替换的副作用，用于独立临时根故障测试。 */
export interface QaThumbnailMigrationDependencies {
  readonly acquireLock: MigrationLockOperation;
  readonly releaseLock: MigrationLockOperation;
  readonly inspectFile: (path: string) => Promise<StateFileInspection | null>;
  readonly createBackup: (
    inspections: readonly StateFileInspection[]
  ) => Promise<string>;
  readonly rewriteFile: (path: string, json: string) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: Readonly<QaThumbnailMigrationDependencies> = {
  acquireLock: acquireSingleInstanceLock,
  releaseLock: releaseSingleInstanceLock,
  inspectFile: inspectStateFile,
  createBackup: createExternalBackup,
  rewriteFile: rewriteStateFile,
};

/** 在工作树外留下带清单的原文快照；备份没被验证过就等于没有备份。 */
export async function createExternalBackup(
  inspections: readonly StateFileInspection[]
): Promise<string> {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-qa-thumbnail-"));
  try {
    const manifest: BackupManifestEntry[] = [];
    for (const inspection of inspections) {
      const bytes: Uint8Array = await Bun.file(inspection.path).bytes();
      const backupFile: string = basename(inspection.path);
      writeVerifiedBackup(root, backupFile, bytes);
      manifest.push(manifestEntry(inspection.path, backupFile, bytes));
    }
    writeVerifiedBackupManifest(root, manifest);
    return root;
  } catch (error: unknown) {
    const reason: string = error instanceof Error ? error.message : String(error);
    throw new Error(
      `External migration backup retained at ${root}; verification failed: ${reason}`,
      { cause: error }
    );
  }
}

/** 读出两份副本并挡掉符号链接；备份与改写必须指向同一个真实文件。 */
async function inspectDeploymentStateFiles(
  paths: readonly string[],
  inspectFile: (path: string) => Promise<StateFileInspection | null>
): Promise<readonly StateFileInspection[]> {
  const inspections: StateFileInspection[] = [];
  for (const path of paths) {
    const inspection: StateFileInspection | null = await inspectFile(path);
    if (inspection === null) continue;
    inspections.push(inspection);
  }
  return inspections;
}

/** qa-thumbnail 冷迁移一次执行所需的输入。 */
export interface RunQaThumbnailMigrationOptions {
  readonly mode: "check" | "apply";
  readonly botToken?: string;
  readonly statePaths?: readonly string[];
  readonly dependencies?: Readonly<Partial<QaThumbnailMigrationDependencies>>;
}

/** 在锁内执行预检或迁移，并返回应写到 stdout 的单行结果。 */
export function runQaThumbnailMigration({
  mode,
  botToken = BOT_TOKEN,
  statePaths = [STATE_FILE_PATH, STATE_BACKUP_FILE_PATH],
  dependencies: overrides = {},
}: RunQaThumbnailMigrationOptions): Promise<string> {
  const dependencies: QaThumbnailMigrationDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  let retainedBackupRoot: string | null = null;
  return runLockedMigration({
    acquire: (): Promise<void> => dependencies.acquireLock(botToken),
    release: async (): Promise<void> => {
      try {
        await dependencies.releaseLock(botToken);
      } catch (error: unknown) {
        if (retainedBackupRoot === null) {
          throw error instanceof Error ? error : new Error(String(error));
        }
        throw retainedBackupError({
          backupRoot: retainedBackupRoot,
          phase: "lock release failed",
          error,
        });
      }
    },
    run: async (): Promise<string> => {
      const inspections: readonly StateFileInspection[] = await inspectDeploymentStateFiles(
        statePaths,
        dependencies.inspectFile
      );
      if (inspections.length === 0) {
        return `No state file at ${statePaths[0] ?? STATE_FILE_PATH}; nothing to migrate.\n`;
      }
      const pending: readonly StateFileInspection[] = inspections.filter(
        (inspection: StateFileInspection): boolean => inspection.hasRetiredKey
      );
      if (pending.length === 0) {
        return "Qa-thumbnail cold migration is already complete.\n";
      }
      const paths: string = pending
        .map((inspection: StateFileInspection): string => inspection.path)
        .join(", ");
      if (mode === "check") {
        return `Qa-thumbnail cold migration check passed; ${RETIRED_ASSET_KEY} still present in ${paths}. ` +
          "No deployment data was changed.\n";
      }
      retainedBackupRoot = await dependencies.createBackup(pending);
      await runWithRetainedBackup({
        backupRoot: retainedBackupRoot,
        run: async (): Promise<void> => {
          for (const inspection of pending) {
            await dependencies.rewriteFile(
              inspection.path,
              withoutRetiredKey(inspection.content)
            );
          }
        },
      });
      return `Qa-thumbnail cold migration completed for ${paths}; ` +
        `external backup retained at ${retainedBackupRoot}.\n`;
    },
  });
}

if (import.meta.main) {
  const args: string[] = Bun.argv.slice(2);
  if (args.length !== 1 || (args[0] !== "--check" && args[0] !== "--apply")) {
    console.error("Usage: bun run migrate:qa-thumbnail -- --check|--apply (stop the service first).");
    process.exit(1);
  }
  await runQaThumbnailMigration({ mode: args[0] === "--apply" ? "apply" : "check" })
    .then((message: string): Promise<number> => Bun.write(Bun.stdout, message))
    .catch((error: unknown): never => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
