/**
 * Telegram `pre` 代码块与 ``` 围栏文本之间的双向转换。
 *
 * Telegram 客户端在**发送前**就把 ```json 围栏吃掉了：`message.text` 里只剩块内
 * 正文，围栏与语言标记变成一条 `pre` 实体。因此「原样存下用户写的代码块」必须
 * 在入口把实体还原成字面围栏（captureFencedText），「原样发回去」则要在出口把
 * 字面围栏拆回正文加实体（renderFencedText）——存字面围栏而不存实体偏移，是为了
 * 让落盘结构保持单一字符串，不牵动持久化格式。
 *
 * 两个方向共用同一套围栏语法：开栏是一整行 ```<语言>，闭栏是一整行 ```。行内
 * 单反引号不在本模块职责内，原样当普通文本处理。
 */

import type { MessageEntity } from "grammy/types";
import { CODE_FENCE, EMPTY_MESSAGE_ENTITIES } from "../consts/telegram";
import type { RichTextMessage } from "../types/telegram";

/**
 * 语言标记里不允许出现的字符：空白与反引号。
 *
 * 两个方向共用同一条判定，围栏才能原样读回——写入侧放进一个带空格的语言标记，
 * 读取侧就不再认它是开栏，那条答案会连着可见的反引号一起发出去。
 * 不带 `g` 标志：`RegExp.prototype.test` 对全局正则是有状态的。
 */
const FENCE_LANGUAGE_REJECT: RegExp = /[\s`]/;

/** 可原样读回的语言标记；读不回的一律丢弃，退化成裸围栏而不是坏掉的开栏。 */
function storableFenceLanguage(language: string | undefined): string {
  if (language === undefined || FENCE_LANGUAGE_REJECT.test(language)) return "";
  return language;
}

/** captureFencedText 的入参；四项超过位置参数上限，故收成 options。 */
export interface CaptureFencedTextParams {
  /** 整条消息的正文，偏移以它为基准。 */
  readonly text: string;
  /** 该消息的实体表；只读取完全落在取值区间内的 `pre` 实体。 */
  readonly entities: readonly MessageEntity[] | undefined;
  /** 取值区间起点（含）。 */
  readonly start: number;
  /** 取值区间终点（不含）。 */
  readonly end: number;
}

/**
 * 把区间内的 `pre` 实体还原成字面 ``` 围栏，取出可直接落盘的文本。
 *
 * 只认**完整落在区间内**的 `pre` 实体：跨越区间边界的实体说明调用方切错了段，
 * 此时按普通文本取出，不会造出半截围栏。区间内没有 `pre` 实体时返回的就是
 * `text.slice(start, end)`，不产生额外拼接。
 */
export function captureFencedText({
  text,
  entities,
  start,
  end,
}: CaptureFencedTextParams): string {
  if (entities === undefined || entities.length === 0) return text.slice(start, end);
  let captured: string = "";
  let cursor: number = start;
  for (const entity of entities) {
    if (entity.type !== "pre") continue;
    const from: number = entity.offset;
    const to: number = entity.offset + entity.length;
    // 越界或与前一个实体重叠的一律跳过：Telegram 不会给出这种实体表，
    // 真出现了也不能让它把 cursor 拨回去，那会重复吐出同一段正文。
    if (from < cursor || to > end) continue;
    captured += text.slice(cursor, from);
    captured +=
      `${CODE_FENCE}${storableFenceLanguage(entity.language)}\n${text.slice(from, to)}\n${CODE_FENCE}`;
    cursor = to;
  }
  if (cursor === start) return text.slice(start, end);
  return captured + text.slice(cursor, end);
}

/**
 * 一行如果是开栏，返回它声明的语言（无语言时为空串）；否则 undefined。
 *
 * 语言标记只接受不含空白与反引号的单词，与 Telegram 客户端自己的解析口径一致；
 * 「```」单独一行按无语言的开栏处理。
 */
function fenceLanguage(line: string): string | undefined {
  if (!line.startsWith(CODE_FENCE)) return undefined;
  const language: string = line.slice(CODE_FENCE.length);
  if (FENCE_LANGUAGE_REJECT.test(language)) return undefined;
  return language;
}

/** 从 from 行开始找闭栏行的下标；没有闭栏时返回 -1。 */
function findFenceClose(lines: readonly string[], from: number): number {
  for (let index: number = from; index < lines.length; index++) {
    if (lines[index] === CODE_FENCE) return index;
  }
  return -1;
}

/**
 * 把字面 ``` 围栏拆成正文加 `pre` 实体，让 Telegram 正常渲染成代码块。
 *
 * 没有围栏的文本原样返回同一个字符串对象与共用空实体表——这条判定挡在最前面，
 * 绝大多数问答答案在这里就走开，不进入按行扫描，也不分配任何中间对象。
 *
 * 未闭合的开栏行按普通文本原样保留：宁可让用户看见自己漏写的那行围栏，
 * 也不把消息剩下的部分整段吞进一个代码块。空代码块整组丢弃——Telegram 拒收
 * 长度为 0 的实体，那会让整条消息发不出去。
 *
 * **拆完为空时整段退回原文**：正文只有一个空代码块（`\`\`\`json` 紧跟闭栏）时，
 * 丢弃它会得到一条空消息，而 Telegram 同样拒收空正文——那条问答就成了「存得进
 * 库却永远答不出来」的死条目。退回原文至少让提问的人看见登记者写下的东西。
 */
export function renderFencedText(text: string): RichTextMessage {
  if (!text.includes(CODE_FENCE)) return { text, entities: EMPTY_MESSAGE_ENTITIES };
  const lines: readonly string[] = text.split("\n");
  const entities: MessageEntity[] = [];
  const parts: string[] = [];
  let offset: number = 0;
  let index: number = 0;
  let emitted: boolean = false;
  while (index < lines.length) {
    const line: string = lines[index] ?? "";
    const language: string | undefined = fenceLanguage(line);
    const close: number = language === undefined ? -1 : findFenceClose(lines, index + 1);
    const body: string = close === -1 ? line : lines.slice(index + 1, close).join("\n");
    index = close === -1 ? index + 1 : close + 1;
    if (close !== -1 && body.length === 0) continue;
    if (emitted) {
      parts.push("\n");
      offset += 1;
    }
    if (close !== -1) {
      entities.push({
        type: "pre",
        offset,
        length: body.length,
        ...(language !== undefined && language.length > 0 ? { language } : {}),
      });
    }
    parts.push(body);
    offset += body.length;
    emitted = true;
  }
  const rendered: string = parts.join("");
  if (rendered.length === 0) return { text, entities: EMPTY_MESSAGE_ENTITIES };
  return { text: rendered, entities };
}
