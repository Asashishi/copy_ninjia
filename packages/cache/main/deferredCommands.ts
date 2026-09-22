import type { DeferredCommandRuntime } from "../../types/deferredCommands";

/**
 * Owner: 主线程。延迟命令执行器（commands/deferredCommands.ts），承载 `/h_image` 的抽图与
 * 收图、`/info` 这些要等待目录、下载或上传的命令任务。
 *
 * 启动时由 initDeferredCommandRuntime 创建：最多 DEFERRED_COMMAND_MAX_CONCURRENT 个在途任务、
 * DEFERRED_COMMAND_MAX_PENDING 个等待项（其中后台档最多 DEFERRED_COMMAND_MAX_BACKGROUND_PENDING
 * 个），满额的新任务直接拒绝。每个任务登记到 tasks，结算自摘除。停机先停止接纳（quiesce），
 * 再在预算内排空；超时取消排队与在途任务。Worker 崩溃不影响本主线程 owner；进程重启从 null
 * 重新创建，不重放未完成的任务。
 */
export const deferredCommandRuntime: { current: DeferredCommandRuntime | null } = { current: null };
