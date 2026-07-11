import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEEPSEEK_API_KEY } from "./config";
import { sendMessage } from "./telegram";

/**
 * AI 闲聊回复：把本群最近的对话记录喂给 DeepSeek（OpenAI 兼容的 /chat/completions
 * 接口），生成一条人设化回复。人设文本存放在仓库根目录的 prompt/persona.txt，
 * 修改人设不需要碰代码。
 */

const DEEPSEEK_API_URL: string = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL: string = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS: number = 30_000;

const PERSONA_PATH: string = join(import.meta.dir, "..", "prompt", "persona.txt");
const SYSTEM_PROMPT: string = readFileSync(PERSONA_PATH, "utf8").trim();

/** 每个群聊在内存里保留的最近消息条数（Bot API 无法拉历史，只能自己滚动缓存）。 */
const BUFFER_SIZE: number = 75;
/** 生成回复时，从缓存里取最近多少条作为上下文喂给模型。 */
const CONTEXT_SIZE: number = 50;
/** 没有其它触发条件时，普通发言触发一次 AI 回复的概率。 */
export const AI_REPLY_PROBABILITY: number = 1 / 3;

/** 缓存里的一条消息：发言人 id + 名字（拆开存，好让模型按 id 而非重名区分身份）+ 文本。 */
interface BufferedMessage {
  id: number;
  firstName: string;
  lastName: string;
  text: string;
}

/** 各群聊各自的滚动消息缓存，仅存于内存（重启即清空，本功能不做持久记忆）。 */
const chatBuffers: Map<number, BufferedMessage[]> = new Map();

/**
 * 记录一条群消息到该群的滚动缓存，供之后拼装成对话上下文喂给模型。
 * @param chatId 群聊 ID。
 * @param id 发言人 id（真实用户 id，或频道马甲/频道帖的频道 id）。
 * @param firstName 发言人 first_name（频道则是 title）。
 * @param lastName 发言人 last_name（频道则为空）。
 * @param text 消息文本。
 */
export function recordChatMessage(chatId: number, id: number, firstName: string, lastName: string, text: string): void {
  const trimmed: string = text.trim();
  if (!trimmed) return;
  let buf: BufferedMessage[] | undefined = chatBuffers.get(chatId);
  if (!buf) {
    buf = [];
    chatBuffers.set(chatId, buf);
  }
  buf.push({ id, firstName, lastName, text: trimmed });
  if (buf.length > BUFFER_SIZE) {
    buf.splice(0, buf.length - BUFFER_SIZE);
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
 * @param repliedBotText 若本次是「用户回复了机器人」，传入被回复的那条机器人消息文本，
 *   作为上下文（机器人自己发的消息不会作为更新推送回来，不在缓存里）。
 * @returns 拼好的用户消息内容；缓存为空时返回 null。
 */
function buildUserContent(chatId: number, repliedBotText?: string): string | null {
  const buf: BufferedMessage[] | undefined = chatBuffers.get(chatId);
  if (!buf || buf.length === 0) return null;

  const recent: BufferedMessage[] = buf.slice(-CONTEXT_SIZE);
  const lines: string[] = recent.map(formatLine);
  if (repliedBotText) {
    lines.push(`（你刚才说过：${repliedBotText.trim()}）`);
  }

  return (
    "以下是本群最近的聊天记录，每行格式为「[id:用户ID] 名字：内容」，同名的人可能是不同的人，请以 id 区分身份，最后一条是最新消息。\n\n" +
    lines.join("\n") +
    "\n\n请针对最新这条消息，以你的人设回复一到两句话，自然接住话题。只输出你要发到群里的那句话本身，不要任何解释、前缀、引号、代码块或「[id:...]」这类标记。"
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
        max_tokens: 200,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`DeepSeek API error: ${response.status} ${await response.text()}`);
      return null;
    }

    const data: any = await response.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    return content ? cleanReply(content) : null;
  } catch (error: unknown) {
    console.error("Error calling DeepSeek API:", error);
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
 * 生成并发送一条 AI 回复。整个过程 fire-and-forget，不阻塞消息处理主流程。
 * @param chatId 目标群聊。
 * @param replyToMessageId 触发这次回复的消息 ID，回复时引用它。
 * @param repliedBotText 若是「用户回复机器人」触发，被回复的机器人消息文本。
 */
export function generateAndSendReply(chatId: number, replyToMessageId: number, repliedBotText?: string): void {
  void (async (): Promise<void> => {
    const userContent: string | null = buildUserContent(chatId, repliedBotText);
    if (!userContent) return;

    const reply: string | null = await callDeepSeek(userContent);
    if (reply) {
      await sendMessage(chatId, reply, replyToMessageId);
    }
  })().catch((error: unknown) => {
    console.error("Error in AI reply task:", error);
  });
}
