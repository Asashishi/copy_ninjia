import type { WebDigestLanguage } from "../types/webDigest";
import { exhaustiveList } from "./exhaustiveList";

/** cron `send_web_digest` 联网摘要（libs/webDigest.ts、libs/webDigestMarkdown.ts、config/cron.ts）的格式常量。 */

/** 摘要标题的最大字符数。所属模块：libs/webDigest.ts。 */
export const WEB_DIGEST_TITLE_MAX_CHARS: number = 80;
/** 导语的最大字符数。所属模块：libs/webDigest.ts。 */
export const WEB_DIGEST_SUMMARY_MAX_CHARS: number = 300;
/** 小节名的最大字符数。所属模块：libs/webDigest.ts。 */
export const WEB_DIGEST_HEADING_MAX_CHARS: number = 40;
/** 条目标题的最大字符数。所属模块：libs/webDigest.ts。 */
export const WEB_DIGEST_ITEM_TITLE_MAX_CHARS: number = 120;
/** 条目正文的最大字符数。所属模块：libs/webDigest.ts。 */
export const WEB_DIGEST_ITEM_BODY_MAX_CHARS: number = 400;
/** 来源名的最大字符数。所属模块：libs/webDigest.ts。 */
export const WEB_DIGEST_SOURCE_MAX_CHARS: number = 40;
/** 条目时间说明的最大字符数。所属模块：libs/webDigest.ts。 */
export const WEB_DIGEST_TIME_MAX_CHARS: number = 32;
/** 结语的最大字符数。所属模块：libs/webDigest.ts。 */
export const WEB_DIGEST_CLOSING_MAX_CHARS: number = 200;
/** 来源地址的最大字符数。所属模块：libs/webDigest.ts、libs/webDigestUrls.ts。 */
export const WEB_DIGEST_URL_MAX_CHARS: number = 2_048;
/** 一份摘要最多的小节数。所属模块：libs/webDigest.ts。 */
export const WEB_DIGEST_MAX_SECTIONS: number = 3;

/** cron.json `payload.topic` 的最大字符数（单行）。所属模块：config/cron.ts。 */
export const WEB_DIGEST_TOPIC_MAX_CHARS: number = 200;
/** cron.json `payload.instructions` 任务规则的最大字符数。所属模块：config/cron.ts。 */
export const WEB_DIGEST_INSTRUCTIONS_MAX_CHARS: number = 500;
/** cron.json `payload.max_items` 允许的最小值。所属模块：config/cron.ts。 */
export const WEB_DIGEST_MIN_ITEMS: number = 1;
/** cron.json `payload.max_items` 允许的最大值。所属模块：config/cron.ts。 */
export const WEB_DIGEST_MAX_ITEMS: number = 15;
/** cron.json `payload.max_items` 缺省时的条目上限。所属模块：config/cron.ts。 */
export const WEB_DIGEST_DEFAULT_MAX_ITEMS: number = 5;
/** cron.json `payload.language` 缺省时的摘要语言。所属模块：config/cron.ts。 */
export const WEB_DIGEST_DEFAULT_LANGUAGE: WebDigestLanguage = "zh";
/** cron.json `payload.language` 接受的全部取值。所属模块：config/cron.ts。 */
export const WEB_DIGEST_LANGUAGES: readonly WebDigestLanguage[] = exhaustiveList<WebDigestLanguage>()(["zh", "ja", "en"]);

/**
 * 来源行的标签（含分隔符），按摘要语言取用；渲染为「标签[来源](地址)」。
 * 所属模块：libs/webDigestMarkdown.ts。
 */
export const WEB_DIGEST_SOURCE_LABELS: Readonly<Record<WebDigestLanguage, string>> = {
  zh: "来源：",
  ja: "出典：",
  en: "Source: ",
};
/** 来源与时间之间的分隔。所属模块：libs/webDigestMarkdown.ts。 */
export const WEB_DIGEST_TIME_SEPARATOR: string = " · ";

/** 组稿最多请求次数：首次不合格（JSON 非法、字段不合格、来源未出现或超长）时带诊断重试。所属模块：aiChat/ai/webDigest.ts。 */
export const WEB_DIGEST_COMPOSE_ATTEMPTS: number = 2;
/** 交给组稿模型的来源列表最多条数（按地址去重后取前若干条）。所属模块：aiChat/ai/webDigest.ts。 */
export const WEB_DIGEST_MAX_SOURCES: number = 20;
/** 检索正文中 HTTPS 链接的候选模式；不跨空白、双引号与文本标记边界。所属模块：libs/webDigestUrls.ts。 */
export const WEB_DIGEST_RESEARCH_URL_PATTERN: Readonly<RegExp> = /https:\/\/[^\s<>"`\\，。；：！？、（）【】《》「」『』]+/giu;
/** 裸链接末尾的英文句读；显式括号、引号或标记包围的链接保留原地址。所属模块：libs/webDigestUrls.ts。 */
export const WEB_DIGEST_RESEARCH_URL_TRAILING_PUNCTUATION_PATTERN: Readonly<RegExp> = /[.,;:!?]+$/u;
/** 组稿请求在错误日志里的调用名。所属模块：aiChat/ai/webDigest.ts。 */
export const WEB_DIGEST_COMPOSE_ERROR_LABEL: string = "Web digest composition";
/** 未执行搜索时写入告警日志的模型正文预览上限；完整长度与截断标记一同记录。所属模块：aiChat/ai/webDigest.ts。 */
export const WEB_DIGEST_NO_SEARCH_LOG_MAX_CHARS: number = 2_000;
/** 未调用搜索时加在 cron 摘要正文开头的可见提示。所属模块：aiChat/ai/webDigest.ts。 */
export const WEB_DIGEST_UNSEARCHED_WARNING: string = "注意，以下可能为模型侧缓存内容，请仔细甄别";
/**
 * 一次组稿流水线里单次模型调用的上限：取三家实现包 `text` 与 `web_search` 档位超时的最大值
 * （GEMINI/OPENAI/ANTHROPIC_REQUEST_TIMEOUTS_MS），档位内已含 SDK 自身的重试；
 * 与那三张表的一致性由 test/consts/webDigest.test.ts 核对。
 * 所属模块：aiChat/webDigest.ts。
 */
export const WEB_DIGEST_MODEL_CALL_TIMEOUT_MS: number = 180_000;
/**
 * 组稿流水线的排队余量：每次模型调用开始前在配额通道里等待的时间不计入单次调用超时。
 * 所属模块：aiChat/webDigest.ts。
 */
export const WEB_DIGEST_QUEUE_ALLOWANCE_MS: number = 60_000;
/**
 * 主线程等待一次组稿回执的上限：(一次检索 + WEB_DIGEST_COMPOSE_ATTEMPTS 次组稿) ×
 * WEB_DIGEST_MODEL_CALL_TIMEOUT_MS + WEB_DIGEST_QUEUE_ALLOWANCE_MS；到点撤回 Worker 侧的组稿
 * 并按 timed out 结算。所属模块：aiChat/webDigest.ts。
 */
export const WEB_DIGEST_REQUEST_TIMEOUT_MS: number =
  (1 + WEB_DIGEST_COMPOSE_ATTEMPTS) * WEB_DIGEST_MODEL_CALL_TIMEOUT_MS + WEB_DIGEST_QUEUE_ALLOWANCE_MS;

/**
 * 组稿输出的 JSON Schema（digest/v1）：Gemini 以 responseJsonSchema、Anthropic 以 output_config.format
 * 约束输出，OpenAI 兼容端点的 json_object 不收 Schema，字段说明写在组稿提示词里。只用三家都接受的
 * 关键字；小节数、长度上限与条目总数由 libs/webDigest.ts 解码时核对。所属模块：aiChat/ai/webDigest.ts。
 */
export const WEB_DIGEST_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    sections: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                body: { type: "string" },
                source: { type: "string" },
                url: { type: "string" },
                time: { type: "string" },
              },
              required: ["title", "body", "source", "url"],
              additionalProperties: false,
            },
          },
        },
        required: ["heading", "items"],
        additionalProperties: false,
      },
    },
    closing: { type: "string" },
  },
  required: ["title", "sections"],
  additionalProperties: false,
};
