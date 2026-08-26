/** 冷迁移锁与外部备份的公共失败边界。 */

/** 冷迁移取得和释放单实例锁所需的依赖。 */
export interface LockedMigrationOptions<T> {
  readonly acquire: () => Promise<void>;
  readonly release: () => Promise<void>;
  readonly run: () => T | Promise<T>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * 在锁内运行迁移，并保证解锁失败不会覆盖更早的迁移失败。
 *
 * 成功路径的解锁失败仍是致命错误；双重失败时保留首个错误文案，并把两份异常
 * 放进 cause 供 CLI 的诊断栈和测试核对。
 */
export async function runLockedMigration<T>({
  acquire,
  release,
  run,
}: LockedMigrationOptions<T>): Promise<T> {
  await acquire();
  let result: T | undefined;
  let primaryError: unknown;
  try {
    result = await run();
  } catch (error: unknown) {
    primaryError = error;
  }

  let releaseError: unknown;
  try {
    await release();
  } catch (error: unknown) {
    releaseError = error;
  }

  if (primaryError !== undefined && releaseError !== undefined) {
    throw new Error(
      `${errorMessage(primaryError)} Lock release also failed.`,
      { cause: new AggregateError([primaryError, releaseError]) }
    );
  }
  if (primaryError !== undefined) throw normalizedError(primaryError);
  if (releaseError !== undefined) throw normalizedError(releaseError);
  return result as T;
}

/** 冷迁移完成外部备份后的动作与失败上下文。 */
export interface RetainedBackupOptions<T> {
  readonly backupRoot: string;
  readonly run: () => T | Promise<T>;
}

/** 给备份完成后的失败补充恢复现场。 */
export interface RetainedBackupErrorOptions {
  readonly backupRoot: string;
  readonly phase: string;
  readonly error: unknown;
}

/** 构造不会回显部署内容、但始终带有备份根的迁移错误。 */
export function retainedBackupError({
  backupRoot,
  phase,
  error,
}: RetainedBackupErrorOptions): Error {
  return new Error(
    `External migration backup retained at ${backupRoot}; ${phase}: ${errorMessage(error)}`,
    { cause: error }
  );
}

/** 备份完成后统一给所有失败附上可恢复现场的位置。 */
export async function runWithRetainedBackup<T>({
  backupRoot,
  run,
}: RetainedBackupOptions<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    throw retainedBackupError({ backupRoot, phase: "migration failed", error });
  }
}
