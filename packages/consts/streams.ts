/** 有界响应读取的非空块检查阈值；超过后按块引用的字节预算决定是否聚合。 */
export const BOUNDED_RESPONSE_CHUNK_THRESHOLD: number = 32;

/** 有界响应每个块引用的字节预算及聚合初始粒度；预分配不得超过调用方字节上限。 */
export const BOUNDED_RESPONSE_COALESCE_BYTES: number = 65_536;
