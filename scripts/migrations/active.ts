/** 当前发布支持的直接冷迁移边。 */
export interface ColdMigrationEdge {
  readonly command: string;
  readonly invocation: string;
  readonly entryPath: string;
  readonly bundledPath: string;
}

/**
 * 当前受支持的直接冷迁移边，只接受上一次迁移产出的格式：
 * database/storage.sqlite 的源 schema（`CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION`）经
 * migrate:chat-persona-removal 直接删除 chat_states.ai_persona 列与 isCanConfigAiPrompt
 * 权限位，并写入 Asia/Tokyo 时区标记，升到当前 schema（`IDENTITY_DATABASE_SCHEMA_VERSION`）。
 * 其余持久化数据格式不变，原样沿用。
 *
 * 源文件不变，中断后保留现场并向新目录重跑；ready.json 是唯一完成标记；产物由运维在停服期间
 * 手工替换。落后于上一次迁移的部署先分阶段升级到其产出格式并完成该迁移；迁移边和对应测试
 * 整体维护，不追加更早格式的兼容入口。
 */
export const ACTIVE_COLD_MIGRATION_EDGES: readonly ColdMigrationEdge[] = [{
  command: "migrate:chat-persona-removal",
  invocation: "bun scripts/migrateChatPersonaRemoval.ts",
  entryPath: "scripts/migrateChatPersonaRemoval.ts",
  bundledPath: "scripts/migrations/migrateChatPersonaRemoval.js",
}];
