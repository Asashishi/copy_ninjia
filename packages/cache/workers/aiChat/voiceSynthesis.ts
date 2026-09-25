/** owner: workers/aiChat。主线程转交的语音合成请求（workers/aiChat/voiceSynthesis.ts）的在途表。 */

/**
 * requestId → 本次合成的取消控制器。收到 synthesizeVoice 时登记，合成结算（成功、失败或
 * 被 cancelVoiceSynthesis 撤回后收尾）时删除；Worker 停止或进入排空时由统一生命周期信号
 * 中止在途合成，条目随各自结算摘除。不落盘，Worker 崩溃后随 isolate 销毁、新 Worker 从空
 * 表重建，主线程已把旧实例的等待者按不可用结算。容量等于同时在途的合成数，上界为主线程
 * 同时在途的 `/send` TTS 与 cron `send_voice` 请求数；不设淘汰。
 */
export const voiceSynthesisRequests: Map<number, AbortController> = new Map();
