/** AI 闲聊主线程代理的在途请求等待类型。 */

/** 等待指定 AI 记忆删除 revision durable 的调用方。 */
export interface AiMemoryDeleteWaiter {
  revision: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 等待心情查询或重抽回执的调用方。 */
export interface MoodRequestWaiter {
  chatId: number;
  expectedEventType: "moodQueried" | "moodSwitched";
  resolve: (moodName: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 等待 AI Worker 完成某次 chat invalidate 的调用方。 */
export interface AiChatInvalidateWaiter {
  chatId: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
