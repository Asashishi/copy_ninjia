/**
 * cron `send_web_digest` 的摘要结构（项目自定的 digest/v1 格式）：已检索时组稿模型交回的 JSON
 * 经 libs/webDigest.ts 严格解码成这里的结构，再由 libs/webDigestMarkdown.ts 渲染成一条
 * Telegram MarkdownV2 消息；未检索时直接转义并发送模型正文。解码后的字符串字段已去掉首尾空白
 * 且非空，仅条目正文允许非空的多行。
 */

import type { AiWorkerJobFailureReason } from "./aiChat/workerJob";

/** 摘要语言；决定组稿要求与来源行的标签。 */
export type WebDigestLanguage = "zh" | "ja" | "en";

/** 一条摘要条目。 */
export interface WebDigestItem {
  readonly title: string;
  /** 可用换行分隔多个非空段落；渲染时保留换行。 */
  readonly body: string;
  /** 来源名，渲染成指向 url 的链接文字。 */
  readonly source: string;
  /** 只接受 https、不带 userinfo、不含空白的来源地址。 */
  readonly url: string;
  /** 可选的时间说明（如 `10-01`）；缺省为 undefined。 */
  readonly time: string | undefined;
}

/** 一个小节：小节名与至少一条条目。 */
export interface WebDigestSection {
  readonly heading: string;
  readonly items: readonly Readonly<WebDigestItem>[];
}

/** 一份解码后的摘要。 */
export interface WebDigest {
  readonly title: string;
  /** 标题下的导语；缺省为 undefined。 */
  readonly summary: string | undefined;
  readonly sections: readonly Readonly<WebDigestSection>[];
  /** 末尾的结语，渲染成引用块；缺省为 undefined。 */
  readonly closing: string | undefined;
}

/** 解码结果；失败时 problem 是交回组稿模型重试用的英文诊断（字段路径与期望形态）。 */
export type WebDigestDecodeResult =
  | { readonly ok: true; readonly digest: Readonly<WebDigest> }
  | { readonly ok: false; readonly problem: string };

/** 渲染结果：MarkdownV2 原文与 Telegram 解析后可见正文的 UTF-16 长度。 */
export interface RenderedWebDigest {
  readonly text: string;
  readonly visibleLength: number;
}

/** 交给 AI Worker 的一次摘要组稿请求（取自 cron.json 的 send_web_digest 动作）。 */
export interface WebDigestRequest {
  readonly topic: string;
  readonly language: WebDigestLanguage;
  readonly maxItems: number;
  /** 检索与组稿共用的任务规则；未给出时为 undefined。 */
  readonly instructions: string | undefined;
}

/**
 * 一次组稿的失败原因：
 * - `ai unconfigured`：没有对话核心能力配置，不投递；
 * - `worker unavailable`：AI Worker 不在、正在重建或排空；
 * - `timed out` / `aborted`：主线程等待超时，或调用方取消；
 * - `search failed`：检索请求失败、超时或没交回正文；`refused`：检索或组稿的 Anthropic 模型拒答；`no sources`：
 *   已执行检索但来源元数据和正文都没交回来源地址；
 * - `compose failed`：组稿请求失败；`invalid digest`：重试后 JSON 仍不合格；`too long`：重试后
 *   渲染出的可见正文仍超过 Telegram 上限。
 */
export type WebDigestFailure =
  | "ai unconfigured"
  | AiWorkerJobFailureReason
  | "search failed"
  | "refused"
  | "no sources"
  | "compose failed"
  | "invalid digest"
  | "too long";

/** 一次组稿的结果：成功时是可直接按 MarkdownV2 发送的原文。 */
export type WebDigestCompositionResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: WebDigestFailure };
