/** 当前发布支持的一条直接冷迁移边。 */
export interface ColdMigrationEdge {
  readonly command: string;
  readonly invocation: string;
  readonly entryPath: string;
  readonly bundledPath: string;
  /** 本次直接迁移的状态范围，仅用于让声明可读可核对。 */
  readonly scope: string;
}

/**
 * 当前唯一受支持的那**一组**直接冷迁移边。
 *
 * 两条边各自对应独立的持久化数据，互不替代：
 * - 随机图库目录：`<uuidv7>[-<file_unique_id>]<扩展名>` 的旧文件名经
 *   migrate:random-image-names 生成按内容 SHA-256 命名的独立产物。
 * - 14.x 数据根下的 `state.json`（与逐字节相同的 `state.json.bak`）：经 migrate:global-state
 *   把 copy 搬进 `memory/global/state.json`，与内置缺省不同的素材项写进
 *   `config/dynamic/assets.json`。
 *
 * 各边的共同约束：源文件不变，中断后保留现场并向新目录重跑；ready.json 是唯一完成
 * 标记；产物由运维在停服期间手工替换。同一份数据被多次迁移时只保留最近那一次的边，
 * 迁移边、版本契约和对应测试整体维护，不追加更早版本的兼容入口。
 */
export const ACTIVE_COLD_MIGRATION_EDGES: readonly ColdMigrationEdge[] = [{
  command: "migrate:random-image-names",
  invocation: "bun scripts/migrateRandomImageNames.ts",
  entryPath: "scripts/migrateRandomImageNames.ts",
  bundledPath: "scripts/migrations/migrateRandomImageNames.js",
  scope: "random image library: uuidv7 file names → content SHA-256 file names",
}, {
  command: "migrate:global-state",
  invocation: "bun scripts/migrateGlobalState.ts",
  entryPath: "scripts/migrateGlobalState.ts",
  bundledPath: "scripts/migrations/migrateGlobalState.js",
  scope: "14.x state.json → memory/global/state.json (copy) and config/dynamic/assets.json (non-default assets)",
}];
