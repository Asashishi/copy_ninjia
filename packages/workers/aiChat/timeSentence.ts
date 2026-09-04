import { getCurrentTime } from "../../libs/time";

/**
 * 「当前实际时间：...（东京时间 UTC+9）。」——runtimeState.ts 的
 * buildRuntimeStateBlock 与 compaction.ts 的 summarizeBatch 共用同一句措辞，
 * 提成函数只为保证两处文案一致，不是抽成常量：时间本身必须现查，不能预先
 * 算好存成字面量（Worker 线程常驻、一跑就是几天，缓存的时间会很快过期）。
 *
 * 两个调用点都落在 **user 内容**里，且都排在该请求每次都变的那一段之后：回复
 * 链路进运行时状态区块（转录之后），压缩链路拼在整批转录末尾。新增调用点必须
 * 同样避开 systemInstruction/instructions 与各自请求的输入开头——时间精确到秒，
 * 落在那两处会让该请求的可缓存前缀从第一个字节起每次都对不上。约束见
 * libs/time.ts 的 getCurrentTime 与 runtimeState.ts 的模块注释。
 */
export function currentTimeSentence(): string {
  return `当前实际时间：${getCurrentTime().formatted}（东京时间 UTC+9）。`;
}
