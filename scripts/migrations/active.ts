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
 * - `state.json`、`state.json.bak` 与 `database/storage.sqlite`：主 state.json 的按群翻译
 *   会话经 migrate:translate-sessions 写入 chat_states，两份 state 去掉 translate 块。
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
  command: "migrate:translate-sessions",
  invocation: "bun scripts/migrateTranslateSessions.ts",
  entryPath: "scripts/migrateTranslateSessions.ts",
  bundledPath: "scripts/migrations/migrateTranslateSessions.js",
  scope: "state.json translate sessions → chat_states translate field; state files keep only global",
}];
