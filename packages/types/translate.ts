import type { CachedUser } from "./chatState";

/** /translate 接受的翻译方向；cn 为简体中文，en 为美式英语，uk 为乌克兰语，ru 为俄语。 */
export type TranslateLanguage = "ja" | "cn" | "en" | "uk" | "ru";

/** 单群翻译会话；替换时创建新对象，用对象身份撤销旧会话的在途响应。 */
export interface TranslateState {
  readonly translatedUser: Readonly<CachedUser>;
  readonly language: TranslateLanguage;
}
