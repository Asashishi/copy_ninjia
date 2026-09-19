import type { HImageRuntime } from "../../types/hImage";

/**
 * Owner: 主线程。`/h_image` 的执行器（commands/hImage.ts）。
 *
 * 启动时由 initHImageRuntime 创建：最多 H_IMAGE_MAX_CONCURRENT 个在途请求与
 * H_IMAGE_MAX_PENDING 个 FIFO 等待项，满额的新请求直接拒绝。每条请求登记到 tasks，
 * 结算自摘除。停机先停止接纳（quiesce），再在预算内排空；超时取消排队与在途请求。
 * Worker 崩溃不影响本主线程 owner；进程重启从 null 重新创建，不重放未完成的请求。
 */
export const hImageRuntime: { current: HImageRuntime | null } = { current: null };
