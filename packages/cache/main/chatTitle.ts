/** 群标题刷新调度（packages/infra/chatTitle.ts）的内存状态。 */

/** 启动标题维护 owner：生命周期可先 quiesce，预算到期后再 abort。 */
export const chatTitleRefreshRuntime: { accepting: boolean; controller: AbortController } = {
  accepting: true,
  controller: new AbortController(),
};
