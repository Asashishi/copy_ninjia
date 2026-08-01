/**
 * 待验证日文件的兼容导出入口。生产代码直接依赖 codec、恢复或写入叶子模块，
 * 避免重新把无状态解析与 Disk I/O Worker 的可变缓存耦合在一起。
 */

export {
  decodeVerificationDay,
  decodeVerificationSnapshot,
  storedVerificationSnapshot,
} from "./verificationCodec";
export {
  compactVerificationDay,
  recoverVerificationDay,
  removeOldVerificationDays,
} from "./verificationRecovery";
export {
  flushVerificationChanges,
  handleVerificationDelete,
  handleVerificationUpsert,
  scheduleVerificationRollover,
} from "./verificationWrites";
export type { VerificationDayValue } from "./verificationCodec";
export type {
  HandleVerificationDeleteParams,
  HandleVerificationUpsertParams,
  VerificationReplySink,
} from "./verificationWrites";
