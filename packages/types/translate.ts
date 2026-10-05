import type { CachedUser } from "./chatState";

/** /translate 接受的翻译方向；ja 为日语，cn 为简体中文，en 为美式英语，
 *  uk 为乌克兰语，ru 为俄语。 */
export type TranslateLanguage = "ja" | "cn" | "en" | "uk" | "ru";

/** 单群翻译会话；替换时创建新对象，用对象身份撤销旧会话的在途响应。 */
export interface TranslateState {
  readonly translatedUser: Readonly<CachedUser>;
  readonly language: TranslateLanguage;
}

/** 一个群的后台译文积压（cache/main/translate.ts 的 translateMessageBacklogs）。 */
export interface TranslateMessageBacklog {
  /** 已入队、尚未结束的译文条数。 */
  count: number;
  /** 本段积压是否已因满额记过日志；积压排空、条目删除时随之重置。 */
  overflowLogged: boolean;
}
