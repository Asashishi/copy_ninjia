/** logger 无法安全读取或序列化某个值时使用的静态占位符；不得调用故障对象的方法生成兜底。 */
export const LOGGER_UNSERIALIZABLE_VALUE: string = "[unserializable value]";

/** 业务 Worker 单次转发给主线程的最大日志条数；所属模块：infra/logger.ts。 */
export const LOGGER_FORWARD_BATCH_MAX_MESSAGES: number = 32;

/** 每个业务 Worker 的 error 日志转发 FIFO 最大消息数；越界只累计标量摘要。 */
export const LOGGER_FORWARD_MAX_PENDING_MESSAGES: number = 1_024;

/** 每个业务 Worker 的 error 日志转发 FIFO 最大 JSON 序列化载荷字节数。 */
export const LOGGER_FORWARD_MAX_SERIALIZED_BYTES: number = 2 * 1024 * 1024;
