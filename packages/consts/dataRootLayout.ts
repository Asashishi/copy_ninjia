/**
 * 运行时数据根下顶层目录的名称；纯字面量、不读环境变量。
 * 目录路径由 consts/paths.ts 拼出，数据根预检的目录清单见 consts/storage.ts 的
 * RUNTIME_SENSITIVE_DIRECTORY_NAMES。
 */

/** error 日志目录名。所属模块：consts/paths.ts（LOGS_DIR）与 consts/storage.ts。 */
export const LOGS_DIR_NAME: string = "logs";
/** Disk I/O Worker 各领域目录与主线程 global/ 的父目录名。所属模块：consts/paths.ts（MEMORY_DIR）与 consts/storage.ts。 */
export const MEMORY_DIR_NAME: string = "memory";
/** memory/ 下由主线程独占写入的全局状态子目录名。所属模块：consts/paths.ts 与 consts/storage.ts。 */
export const GLOBAL_STATE_DIR_NAME: string = "global";
/**
 * SQLite 运行时数据库目录名；数据根预检按它识别身份数据库目录（infra/storage/dataRoot.ts）。
 * 所属模块：consts/paths.ts（DATABASE_DIR）与 consts/storage.ts。
 */
export const DATABASE_DIR_NAME: string = "database";
