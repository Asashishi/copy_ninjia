import { logger } from "./logger";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEEPSEEK_API_KEY } from "./config";
import { LinkedQueue } from "./linkedQueue";
import { sendMessage } from "./telegram";

/**
 * AI 闲聊回复：把本群最近的对话记录喂给 DeepSeek（OpenAI 兼容的 /chat/completions
 * 接口），生成一条人设化回复。人设文本存放在仓库根目录的 prompt/persona.txt，
 * 修改人设不需要碰代码。
 */

const DEEPSEEK_API_URL: string = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL: string = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS: number = 60_000;

const PERSONA_PATH: string = join(import.meta.dir, "..", "prompt", "persona.txt");
const SYSTEM_PROMPT: string = readFileSync(PERSONA_PATH, "utf8").trim();

/** 每个群聊在内存里保留的最近消息条数（Bot API 无法拉历史，只能自己滚动缓存）。 */
const BUFFER_SIZE: number = 75;
/** 生成回复时，从缓存里取最近多少条作为上下文喂给模型。 */
const CONTEXT_SIZE: number = 50;
/** 没有其它触发条件时，普通发言触发一次 AI 回复的概率。 */
export const AI_REPLY_PROBABILITY: number = 1 / 4;
/** 触发回复后，采用「连发多条短消息」形式（而非单条）的概率。 */
const SPLIT_REPLY_PROBABILITY: number = 1 / 3;
/** 连发模式下最多发几条，防止模型话痨刷屏。 */
const SPLIT_REPLY_MAX_PARTS: number = 5;
/**
 * 同一群聊两次 AI 回复之间的最短间隔。回复机器人 / @ 机器人是 100% 触发且
 * 无上限的，没有这道闸的话，恶意用户循环回复 bot 就能形成「一条消息 = 一次
 * API 调用 + 一条群消息」的刷屏/烧钱放大链。冷却内命中的触发直接静默丢弃。
 */
const AI_REPLY_COOLDOWN_MS: number = 1_500;

/** 各群聊上一次 AI 回复的触发时刻（毫秒时间戳），用于冷却判断。 */
const lastReplyTimes: Map<number, number> = new Map();

/**
 * 分群限频：单个群滚动 60 秒窗口内最多触发多少次 AI 回复。每群冷却只
 * 限制相邻两次的间隔（1.5 秒冷却下一分钟仍可达 40 次），这道闸给单群
 * 的总量再兜一层。只在入口计一次数——一次触发内的「连发多条短消息」
 * 属于同一次回复，不重复计数。超限的触发直接静默丢弃。
 */
const RATE_LIMIT_WINDOW_MS: number = 60_000;
const RATE_LIMIT_MAX_TRIGGERS: number = 35;

/** 各群窗口内每次触发的时刻（毫秒时间戳），队首最旧，过期即出队。 */
const triggerTimes: Map<number, LinkedQueue<number>> = new Map();

/** 缓存里的一条消息：发言人 id + 名字（拆开存，好让模型按 id 而非重名区分身份）+ 文本。 */
interface BufferedMessage {
  id: number;
  firstName: string;
  lastName: string;
  text: string;
}

/** 各群聊各自的滚动消息缓存，仅存于内存（重启即清空，本功能不做持久记忆）。 */
const chatBuffers: Map<number, LinkedQueue<BufferedMessage>> = new Map();

/**
 * 把要写进转录的文本压成单行：所有空白串（含换行）折叠为一个空格。
 * 这是防转录注入的关键——转录按「一行 = 一条消息」拼装，若用户消息或
 * 自己改的昵称里带换行，就能伪造出「[id:x] 某人：……」的假发言行，
 * 给别人栽赃。折叠换行后一条消息永远只占一行，该向量彻底失效。
 */
function sanitizeInline(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * 记录一条群消息到该群的滚动缓存，供之后拼装成对话上下文喂给模型。
 * 文本与昵称都会被压成单行（见 sanitizeInline，防转录注入）。
 * @param chatId 群聊 ID。
 * @param id 发言人 id（真实用户 id，或频道马甲/频道帖的频道 id）。
 * @param firstName 发言人 first_name（频道则是 title）。
 * @param lastName 发言人 last_name（频道则为空）。
 * @param text 消息文本。
 */
export function recordChatMessage(chatId: number, id: number, firstName: string, lastName: string, text: string): void {
  const sanitized: string = sanitizeInline(text);
  if (!sanitized) return;
  let buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf) {
    buf = new LinkedQueue<BufferedMessage>();
    chatBuffers.set(chatId, buf);
  }
  buf.push({ id, firstName: sanitizeInline(firstName), lastName: sanitizeInline(lastName), text: sanitized });
  while (buf.size > BUFFER_SIZE) {
    buf.shift();
  }
}

/** 把一条缓存消息格式化成喂给模型的一行：标出 id，避免重名混淆身份。 */
function formatLine(m: BufferedMessage): string {
  const name: string = [m.firstName, m.lastName].filter((p: string) => !!p).join(" ").trim() || "某杂鱼";
  return `[id:${m.id}] ${name}：${m.text}`;
}

/**
 * 把某群的滚动缓存里最近 CONTEXT_SIZE 条拼装成给模型的用户消息内容。
 * @param chatId 群聊 ID。
 * @param splitMode 是否要求模型把回复拆成多条短消息（一行一条）连发。
 * @param repliedBotText 若本次是「用户回复了机器人」，传入被回复的那条机器人消息文本，
 *   作为上下文（机器人自己发的消息不会作为更新推送回来，不在缓存里）。
 * @returns 拼好的用户消息内容；缓存为空时返回 null。
 */
function buildUserContent(chatId: number, splitMode: boolean, repliedBotText?: string): string | null {
  const buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf || buf.size === 0) return null;

  const recent: BufferedMessage[] = buf.last(CONTEXT_SIZE);
  const lines: string[] = recent.map(formatLine);
  if (repliedBotText) {
    // 同样压成单行：这段文本虽是机器人自己说过的话，保持转录「一行一条」的
    // 结构不变即可杜绝任何多行伪造的可能。
    lines.push(`（你刚才说过：${sanitizeInline(repliedBotText)}）`);
  }

  const replyInstruction: string = splitMode
    ? `请针对最新这条消息，以你的人设回复，并把回复拆成 2 到 ${SPLIT_REPLY_MAX_PARTS} 条连贯的短消息——就像真人打字时想到哪发到哪、一句接一句连发那样，每条一行、语义上前后衔接（比如先反应、再吐槽、再补一刀）。只输出这几行消息本身，一行一条，不要编号、解释、前缀、引号、代码块或「[id:...]」这类标记。`
    : "请针对最新这条消息，以你的人设回复一到两句话，自然接住话题。只输出你要发到群里的那句话本身，不要任何解释、前缀、引号、代码块或「[id:...]」这类标记。";

  return (
    "以下是本群最近的聊天记录，每行格式为「[id:用户ID] 名字：内容」，同名的人可能是不同的人，请以 id 区分身份，最后一条是最新消息，请正确识别情况（不要编造，不要张冠李戴），并作出符合人设的回应。\n\n" +
    lines.join("\n") +
    "\n\n" +
    replyInstruction
  );
}

/**
 * 调用 DeepSeek 的 /chat/completions 接口生成一条回复。
 * @param userContent buildUserContent 拼好的对话上下文。
 * @returns 清洗后的回复文本；请求失败、超时或空输出时返回 null。
 */
async function callDeepSeek(userContent: string): Promise<string | null> {
  const controller: AbortController = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response: Response = await fetch(DEEPSEEK_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        stream: false,
        temperature: 1.2,
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.error(`DeepSeek API error: ${response.status} ${await response.text()}`);
      return null;
    }

    const data: any = await response.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    return content ? cleanReply(content) : null;
  } catch (error: unknown) {
    logger.error("Error calling DeepSeek API:", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 清洗模型的原始输出，得到可直接发送的纯回复文本：去掉首尾空白、包裹的代码块
 * 围栏和成对引号，并截断到 Telegram 单条消息上限。空则返回 null。
 */
function cleanReply(raw: string): string | null {
  let text: string = raw.trim();
  if (!text) return null;

  const fenceMatch = text.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    text = fenceMatch[1].trim();
  }

  if (text.length >= 2) {
    const first: string = text[0]!;
    const last: string = text[text.length - 1]!;
    if ((first === '"' && last === '"') || (first === "「" && last === "」") || (first === "“" && last === "”")) {
      text = text.slice(1, -1).trim();
    }
  }

  if (!text) return null;
  return text.length > 4096 ? text.slice(0, 4096) : text;
}

/**
 * 把连发模式下模型的输出按行拆成若干条待发送的短消息。
 * 空行丢弃，超出上限的行合并进最后一条，防止刷屏。
 */
function splitReplyParts(reply: string): string[] {
  const lines: string[] = reply
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => !!line);
  if (lines.length <= SPLIT_REPLY_MAX_PARTS) return lines;
  return [...lines.slice(0, SPLIT_REPLY_MAX_PARTS - 1), lines.slice(SPLIT_REPLY_MAX_PARTS - 1).join(" ")];
}

/** 模拟真人打字的间隔：按下一条消息的长度估一个停顿，并加上限。 */
function typingDelayMs(nextPart: string): number {
  const base: number = 600 + nextPart.length * 55;
  const jitter: number = Math.random() * 400;
  return Math.min(base + jitter, 3_500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 生成并发送 AI 回复。整个过程 fire-and-forget，不阻塞消息处理主流程。
 * 以 SPLIT_REPLY_PROBABILITY 概率采用「连发多条短消息」形式：让模型按行输出
 * 几条前后衔接的短句，逐条带打字间隔发出（仅第一条引用触发消息）；
 * 其余情况仍是普通的单条回复。
 * @param chatId 目标群聊。
 * @param replyToMessageId 触发这次回复的消息 ID，回复时引用它。
 * @param repliedBotText 若是「用户回复机器人」触发，被回复的机器人消息文本。
 */
export function generateAndSendReply(chatId: number, replyToMessageId: number, repliedBotText?: string): void {
  // 每群冷却：在发起任何异步工作之前同步判定并占位，这样冷却窗口内的
  // 并发触发（包括 100% 命中的回复/@ 触发）都会在烧到 API 之前被丢弃。
  const now: number = Date.now();
  if (now - (lastReplyTimes.get(chatId) ?? 0) < AI_REPLY_COOLDOWN_MS) {
    return;
  }

  // 本群每分钟限频：先把窗口外的旧触发挤掉，再看余量。两道闸都过了才
  // 一起落账，避免被拒的触发白白占用冷却/配额。
  let times: LinkedQueue<number> | undefined = triggerTimes.get(chatId);
  if (!times) {
    times = new LinkedQueue<number>();
    triggerTimes.set(chatId, times);
  }
  while (times.size > 0 && now - times.peek()! >= RATE_LIMIT_WINDOW_MS) {
    times.shift();
  }
  if (times.size >= RATE_LIMIT_MAX_TRIGGERS) {
    return;
  }

  lastReplyTimes.set(chatId, now);
  times.push(now);

  const splitMode: boolean = Math.random() < SPLIT_REPLY_PROBABILITY;

  void (async (): Promise<void> => {
    const userContent: string | null = buildUserContent(chatId, splitMode, repliedBotText);
    if (!userContent) return;

    const reply: string | null = await callDeepSeek(userContent);
    if (!reply) return;

    // 单条模式下模型偶尔也会换行，此时不该按行拆——原样整条发出。
    const parts: string[] = splitMode ? splitReplyParts(reply) : [reply];
    for (let i: number = 0; i < parts.length; i++) {
      const part: string = parts[i]!;
      await sendMessage(chatId, part, i === 0 ? replyToMessageId : undefined);
      if (i < parts.length - 1) {
        await sleep(typingDelayMs(parts[i + 1]!));
      }
    }
  })().catch((error: unknown) => {
    logger.error("Error in AI reply task:", error);
  });
}
