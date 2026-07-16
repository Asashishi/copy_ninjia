/** 群聊媒体里可做视觉解析的三种类型：图片、贴纸、GIF（Telegram animation）。
 *  三者共用同一套「占位入缓存 -> 异步下载解析 -> 原位回填」管线（见
 *  ai/imageDescription.ts 的 describeMedia、workers/aiChatWorker.ts 的
 *  recordChatMedia），只是占位符/提示词/描述长度各不相同。 */
export type MediaKind = "photo" | "sticker" | "animation";
