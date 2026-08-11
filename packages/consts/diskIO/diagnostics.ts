/** 主线程单次投递给 Disk I/O Worker 的最大诊断条数。 */
export const DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES: number = 32;

/** 主线程诊断 FIFO（排队加在途）的最大消息数；越界项合并进丢弃摘要。 */
export const DISK_DIAGNOSTIC_MAX_PENDING_MESSAGES: number = 4_096;

/**
 * 主线程诊断 FIFO 允许保留的 JSON 序列化载荷字节总数。消息数同时受独立硬顶
 * 约束，因此小对象开销也不能按故障持续时间无限增长。
 */
export const DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES: number = 8 * 1024 * 1024;

/**
 * 同一 Disk I/O Worker 代际允许连续返回的日志落盘失败次数。
 *
 * 达到上限后由主线程沿既有崩溃恢复协议受控重建 Worker；成功 ACK 会把计数归零。
 * 计数属于宿主代际，不改变诊断 FIFO 的 at-least-once 语义。
 */
export const DISK_DIAGNOSTIC_MAX_CONSECUTIVE_WRITE_FAILURES: number = 45;

/**
 * 日志连续落盘失败链路第几次要求重建 Disk I/O Worker 时必须中断 bot 进程。
 *
 * 前两次允许重建；第三次说明落盘问题不是一次偶发 isolate 故障。任一重建的
 * load、镜像或握手本身失败时不等待本阈值，宿主会立即走 fatal。普通 Worker
 * 崩溃仍使用 workerSupervisor.ts 的共享滑动窗口，不计入本阈值。
 */
export const DISK_DIAGNOSTIC_FATAL_REBUILD_THRESHOLD: number = 3;
