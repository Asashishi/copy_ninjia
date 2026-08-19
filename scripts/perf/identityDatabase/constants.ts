/** 每个热读样本执行的双表批量查询次数。 */
export const READ_BATCH_COUNT: number = 25_000;

/** 每个冷读样本重新打开数据库的次数。 */
export const COLD_READ_BATCH_COUNT: number = 1_000;

/** 一次身份策略读取批次包含的固定身份数。 */
export const READ_BATCH_SIZE: number = 8;

/** 读库与主线程 LRU 的固定身份基数。 */
export const READ_FIXTURE_SIZE: number = 8_192;

/** 每个热写样本提交的 128 行事务数。 */
export const WRITE_TRANSACTION_COUNT: number = 512;

/** 每个冷写样本重新打开数据库并提交的事务数。 */
export const COLD_WRITE_TRANSACTION_COUNT: number = 64;

/** 主线程 LRU 每个样本读取的 update 批次数。 */
export const MAIN_LRU_READ_BATCH_COUNT: number = 1_000_000;

/** 主线程写透使用的身份工作集；两倍操作恰好完成一次写入和删除。 */
export const MAIN_WRITE_THROUGH_WORKING_SET: number = 4_096;

/** 主线程写透每个样本的计时操作数。 */
export const MAIN_WRITE_THROUGH_OPERATION_COUNT: number = 65_536;

/** 每项操作的独立进程样本数。 */
export const INDEPENDENT_PROCESS_SAMPLE_COUNT: number = 5;

/** 同一测量进程内连续复测每项操作的样本数。 */
export const SINGLE_PROCESS_SAMPLE_COUNT: number = 3;

/** 基准唯一允许创建和清理的系统临时 mock 根前缀。 */
export const MOCK_ROOT_PREFIX: string = "copy-ninjia-identity-mock-";

/** 写透数据根在 mock 根下的前缀。 */
export const MAIN_BENCHMARK_ROOT_PREFIX: string = "runtime-";

/** 存储层临时库在 mock 根下的前缀。 */
export const DATABASE_FIXTURE_ROOT_PREFIX: string = "sqlite-";
