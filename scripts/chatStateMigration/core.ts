/**
 * 冷迁移公开入口兼容层。
 *
 * state.json 主备读取与 SQLite 谱系/写入已分别拆到 stateSource.ts、database.ts；
 * 本文件只保留既有脚本和测试的稳定导入路径。
 */

export {
  applyChatStateDatabaseMigration,
  assertChatStateMigrationReady,
  inspectChatStateDatabase,
} from "./database";
export type {
  ChatStateDatabaseInspection,
  ChatStateMigrationStatus,
} from "./database";
export {
  loadChatStateMigrationDraft,
  loadChatStateMigrationSource,
  resolveChatStateMigrationDraft,
} from "./stateSource";
export type {
  ChatStateMigrationDraft,
  ChatStateMigrationDraftRow,
  ChatStateMigrationSource,
  LoadChatStateMigrationSourceOptions,
  MigrationStateKind,
} from "./stateSource";
