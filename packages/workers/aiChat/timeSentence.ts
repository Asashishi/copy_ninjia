import { getCurrentTime } from "../../libs/time";

/**
 * 「当前实际时间：...（东京时间 UTC+9）。」——replyModel.ts 的 generateReply 与
 * compaction.ts 的 summarizeBatch 共用同一句措辞，提成函数只为保证两处文案
 * 一致，不是抽成常量：时间本身必须现查，不能预先算好存成字面量（Worker
 * 线程常驻、一跑就是几天，缓存的时间会很快过期）。
 */
export function currentTimeSentence(): string {
  return `当前实际时间：${getCurrentTime().formatted}（东京时间 UTC+9）。`;
}
