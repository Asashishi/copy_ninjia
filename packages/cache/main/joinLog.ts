/** owner: main。入群事实的未确认落盘镜像与投递序号。 */
import { LinkedQueue } from "../../libs/linkedQueue";
import type { JoinLogDiskMessage } from "../../types/diskIO/messages";

/**
 * 已投递给 Disk I/O Worker、尚未由 joinLogPersisted 确认处置的入群事实，按序号升序。
 *
 * 仅用于防丢失的持久化回执：权威处置线程是 Disk I/O Worker，它在 flush、窗口外丢弃或
 * 整群删除后以增量方式回执「已收下的最大序号与其中仍待写的序号」；本镜像只在 Worker
 * 崩溃重建时由 infra/joinLog.ts 的 replayJoinLogs 原序全量重放。填充：recordJoinLog
 * 投递成功后追加；清理：处置回执释放已处置的事实，群 teardown 的整群删除摘除该群条目。
 * 条目恒为尚未落盘的事实，容量硬顶
 * JOIN_LOG_MAX_BUFFERED_ENTRIES，满载时 recordJoinLog 拒绝新事实。无条目表示没有未确认
 * 的事实，不表示沿用旧值；进程重启后为空，未落盘的事实随之丢失。
 */
export const unacknowledgedJoinLogs: LinkedQueue<JoinLogDiskMessage> = new LinkedQueue();

/** 最近分配的投递序号；recordJoinLog 递增，进程重启从零开始，Worker 重建不归零，容量一个标量。 */
export const joinLogSequence: { current: number } = { current: 0 };
