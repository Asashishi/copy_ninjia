/** logger 无法安全读取或序列化某个值时使用的静态占位符；不得调用故障对象的方法生成兜底。 */
export const LOGGER_UNSERIALIZABLE_VALUE: string = "[unserializable value]";

/** 业务 Worker 单次转发给主线程的最大日志条数；所属模块：infra/logger.ts。 */
export const LOGGER_FORWARD_BATCH_MAX_MESSAGES: number = 32;
