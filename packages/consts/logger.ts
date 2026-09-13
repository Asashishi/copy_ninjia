/** logger 无法安全读取或序列化某个值时使用的静态占位符；不得调用故障对象的方法生成兜底。 */
export const LOGGER_UNSERIALIZABLE_VALUE: string = "[unserializable value]";

/**
 * 日志序列化展开嵌套 Error（`cause`、`AggregateError.errors`、值为 Error 的自有可枚举字段）
 * 的最大层数；顶层 Error 为第 0 层，更深的 Error 以 LOGGER_NESTED_ERROR_DEPTH_EXCEEDED_VALUE
 * 代替。所属模块：infra/logger/serialization.ts。
 */
export const LOGGER_NESTED_ERROR_MAX_DEPTH: number = 5;

/** 嵌套 Error 超过 LOGGER_NESTED_ERROR_MAX_DEPTH 时的静态占位符；所属模块：infra/logger/serialization.ts。 */
export const LOGGER_NESTED_ERROR_DEPTH_EXCEEDED_VALUE: string = "[nested error depth exceeded]";

/** 嵌套 Error 指回自身展开链上某个祖先时的静态占位符；所属模块：infra/logger/serialization.ts。 */
export const LOGGER_CIRCULAR_ERROR_VALUE: string = "[circular error reference]";

/** logger 单次 emit 最多展开的 Error 数，所有参数与嵌套分支共享预算。 */
export const LOGGER_MAX_ERROR_NODES: number = 64;

/** logger 单次 emit 最多读取的参数、Error 属性及 AggregateError 数组元素总数。 */
export const LOGGER_MAX_SERIALIZED_ITEMS: number = 256;

/** logger 单次 emit 的参数 JSON 最大 UTF-8 字节数，包含截断标记与数组结构。 */
export const LOGGER_MAX_SERIALIZED_BYTES: number = 64 * 1_024;

/** logger 超出展开或输出预算时的静态占位符，不包含被截断内容。 */
export const LOGGER_SERIALIZATION_LIMIT_VALUE: string = "[log serialization limit exceeded]";

/** 业务 Worker 单次转发给主线程的最大日志条数；所属模块：infra/logger.ts。 */
export const LOGGER_FORWARD_BATCH_MAX_MESSAGES: number = 32;

/** 每个业务 Worker 的 error 日志转发 FIFO 最大消息数；越界只累计标量摘要。 */
export const LOGGER_FORWARD_MAX_PENDING_MESSAGES: number = 1_024;

/** 每个业务 Worker 的 error 日志转发 FIFO 最大 JSON 序列化载荷字节数。 */
export const LOGGER_FORWARD_MAX_SERIALIZED_BYTES: number = 2 * 1024 * 1024;
