/** 当前发布支持的一条直接冷迁移边。 */
export interface ColdMigrationEdge {
  readonly command: string;
  readonly invocation: string;
  readonly entryPath: string;
  readonly bundledPath: string;
}

/**
 * 当前唯一受支持的直接冷迁移边，只接受上一次迁移（16.3.2）产出的格式：
 * database/storage.sqlite 的 schema v11 经 migrate:chat-persona-removal 直接删除
 * chat_states.ai_persona 列与 isCanConfigAiPrompt 权限位，并写入 Asia/Tokyo 时区标记，升到 schema v13。
 * 其余持久化数据在 16.3.2 与当前版本之间格式不变，原样沿用。
 *
 * 源文件不变，中断后保留现场并向新目录重跑；ready.json 是唯一完成标记；产物由运维在停服期间
 * 手工替换。落后于 16.3.2 的部署先分阶段升级到 16.3.2 并完成其迁移；迁移边、版本契约和对应
 * 测试整体维护，不追加更早版本的兼容入口。
 */
export const ACTIVE_COLD_MIGRATION_EDGES: readonly ColdMigrationEdge[] = [{
  command: "migrate:chat-persona-removal",
  invocation: "bun scripts/migrateChatPersonaRemoval.ts",
  entryPath: "scripts/migrateChatPersonaRemoval.ts",
  bundledPath: "scripts/migrations/migrateChatPersonaRemoval.js",
}];
