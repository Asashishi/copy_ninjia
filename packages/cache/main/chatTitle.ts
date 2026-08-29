/** 群标题刷新调度（packages/infra/chatTitle.ts）的内存状态。 */

/** 启动时填充的标题维护 owner：生命周期可先 quiesce，预算到期后再 abort；
 * 容量固定为一个，进程重启时创建新 controller。 */
export const chatTitleRefreshRuntime: { accepting: boolean; controller: AbortController } = {
  accepting: true,
  controller: new AbortController(),
};
