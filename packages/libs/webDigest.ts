/**
 * cron `send_web_digest` 摘要 JSON（digest/v1）的严格解码（纯函数，不碰缓存）。
 *
 * 组稿模型交回的 JSON 必须逐字段合格才发：字段集精确、未知键拒绝；所有字符串去掉首尾空白后
 * 非空、不超过各自上限，也不得含可被渲染成机器人命令的片段；仅条目正文允许非空的多行，
 * 其它字符串不含换行；1–WEB_DIGEST_MAX_SECTIONS
 * 个小节，每节至少一条，条目总数不超过任务的 max_items；来源地址只收 https、不带 userinfo、
 * 不含空白。失败时交回一条英文诊断（字段路径与期望形态），供组稿重试时带给模型。
 */

import {
  WEB_DIGEST_CLOSING_MAX_CHARS,
  WEB_DIGEST_HEADING_MAX_CHARS,
  WEB_DIGEST_ITEM_BODY_MAX_CHARS,
  WEB_DIGEST_ITEM_TITLE_MAX_CHARS,
  WEB_DIGEST_MAX_SECTIONS,
  WEB_DIGEST_SOURCE_MAX_CHARS,
  WEB_DIGEST_SUMMARY_MAX_CHARS,
  WEB_DIGEST_TIME_MAX_CHARS,
  WEB_DIGEST_TITLE_MAX_CHARS,
  WEB_DIGEST_URL_MAX_CHARS,
} from "../consts/webDigest";
import { hasOnlyKeys, isPlainRecord } from "./record";
import { containsRenderableCommand } from "./renderableCommand";
import type {
  WebDigest,
  WebDigestDecodeResult,
  WebDigestItem,
  WebDigestSection,
} from "../types/webDigest";

/** 解码过程中的一处不合格；在 decodeWebDigest 里收成失败结果。 */
class WebDigestProblem extends Error {}

function reject(path: string, expected: string): never {
  throw new WebDigestProblem(`${path} must be ${expected}`);
}

/** 必填单行字符串：去掉首尾空白后 1–maxChars 字符、不含换行与可渲染命令。 */
function requiredLine(value: unknown, path: string, maxChars: number): string {
  const expected: string = `a single-line string of 1 to ${maxChars} characters without bot commands`;
  if (typeof value !== "string") return reject(path, expected);
  const text: string = value.trim();
  if (
    text.length === 0 ||
    text.length > maxChars ||
    text.includes("\n") ||
    text.includes("\r") ||
    containsRenderableCommand(text)
  ) {
    return reject(path, expected);
  }
  return text;
}

/** 可选单行字符串；缺省或 null 为 undefined，出现时规则同 requiredLine。 */
function optionalLine(value: unknown, path: string, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredLine(value, path, maxChars);
}

/** 条目正文允许换行分段；每行非空，不接受回车或可渲染命令。 */
function requiredBody(value: unknown, path: string): string {
  const expected: string = `a string of 1 to ${WEB_DIGEST_ITEM_BODY_MAX_CHARS} characters with non-empty lines and no bot commands`;
  if (typeof value !== "string") return reject(path, expected);
  const text: string = value.trim();
  if (text.length === 0 || text.length > WEB_DIGEST_ITEM_BODY_MAX_CHARS || text.includes("\r") || containsRenderableCommand(text)) {
    return reject(path, expected);
  }
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) return reject(path, expected);
  }
  return text;
}

/** 来源地址：https、无 userinfo、无空白，不超过 WEB_DIGEST_URL_MAX_CHARS。 */
function requiredUrl(value: unknown, path: string): string {
  const expected: string = `an https URL of at most ${WEB_DIGEST_URL_MAX_CHARS} characters without credentials or whitespace`;
  if (typeof value !== "string") return reject(path, expected);
  const url: string = value.trim();
  if (url.length > WEB_DIGEST_URL_MAX_CHARS || /\s/.test(url)) {
    return reject(path, expected);
  }
  const parsed: URL | null = URL.parse(url);
  if (parsed?.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0) {
    return reject(path, expected);
  }
  return url;
}

function decodeItem(value: unknown, path: string): WebDigestItem {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["title", "body", "source", "url", "time"])) {
    return reject(path, "an object with exactly { title, body, source, url, time? }");
  }
  return {
    title: requiredLine(value.title, `${path}.title`, WEB_DIGEST_ITEM_TITLE_MAX_CHARS),
    body: requiredBody(value.body, `${path}.body`),
    source: requiredLine(value.source, `${path}.source`, WEB_DIGEST_SOURCE_MAX_CHARS),
    url: requiredUrl(value.url, `${path}.url`),
    time: optionalLine(value.time, `${path}.time`, WEB_DIGEST_TIME_MAX_CHARS),
  };
}

function decodeSection(value: unknown, path: string): WebDigestSection {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["heading", "items"])) {
    return reject(path, "an object with exactly { heading, items }");
  }
  const heading: string = requiredLine(value.heading, `${path}.heading`, WEB_DIGEST_HEADING_MAX_CHARS);
  if (!Array.isArray(value.items) || value.items.length === 0) {
    return reject(`${path}.items`, "a non-empty array");
  }
  const items: WebDigestItem[] = [];
  for (let index: number = 0; index < value.items.length; index++) {
    items.push(decodeItem(value.items[index], `${path}.items[${index}]`));
  }
  return { heading, items };
}

/**
 * 严格解码一份摘要。
 * @param value 组稿模型交回的 JSON（已 JSON.parse）。
 * @param maxItems 本任务的条目总数上限（cron.json 的 max_items）。
 */
export function decodeWebDigest(value: unknown, maxItems: number): WebDigestDecodeResult {
  try {
    if (!isPlainRecord(value) || !hasOnlyKeys(value, ["title", "summary", "sections", "closing"])) {
      return reject("$", "an object with exactly { title, summary?, sections, closing? }");
    }
    const title: string = requiredLine(value.title, "$.title", WEB_DIGEST_TITLE_MAX_CHARS);
    const summary: string | undefined = optionalLine(value.summary, "$.summary", WEB_DIGEST_SUMMARY_MAX_CHARS);
    if (!Array.isArray(value.sections) || value.sections.length === 0 || value.sections.length > WEB_DIGEST_MAX_SECTIONS) {
      return reject("$.sections", `an array of 1 to ${WEB_DIGEST_MAX_SECTIONS} sections`);
    }
    const sections: WebDigestSection[] = [];
    let itemCount: number = 0;
    for (let index: number = 0; index < value.sections.length; index++) {
      const section: WebDigestSection = decodeSection(value.sections[index], `$.sections[${index}]`);
      itemCount += section.items.length;
      sections.push(section);
    }
    if (itemCount > maxItems) return reject("$.sections", `sections holding at most ${maxItems} items in total`);
    const closing: string | undefined = optionalLine(value.closing, "$.closing", WEB_DIGEST_CLOSING_MAX_CHARS);
    const digest: WebDigest = { title, summary, sections, closing };
    return { ok: true, digest };
  } catch (error: unknown) {
    if (error instanceof WebDigestProblem) return { ok: false, problem: error.message };
    throw error;
  }
}
