/** owner: workers/aiChat。cron 转交的摘要组稿请求（workers/aiChat/webDigest.ts）的在途表。 */

/**
 * requestId → 本次组稿的取消控制器。收到 composeWebDigest 时登记，组稿结算（成功、失败或被
 * cancelWebDigest 撤回后收尾）时删除；Worker 停止或进入排空时由统一生命周期信号中止在途组稿，
 * 条目随各自结算摘除。不落盘，Worker 崩溃后随 isolate 销毁、新 Worker 从空表重建，主线程已把
 * 旧实例的等待者按不可用结算。容量等于同时在途的组稿数，上界为 cron 同时在途的轮数；不设淘汰。
 */
export const webDigestRequests: Map<number, AbortController> = new Map();
