import { logger } from "../infra/logger";
import { readFileSync } from "node:fs";
import { DEEPSEEK_API_KEY } from "../infra/config";
import { LinkedQueue } from "../libs/linkedQueue";
import { fetchJsonWithTimeout } from "../libs/httpFetch";
import { sleep } from "../libs/sleep";
import { PERSONA_PATH } from "../consts/paths";
import {
  AI_REPLY_COOLDOWN_MS,
  COMPACT_BATCH_SIZE,
  DEEPSEEK_API_URL,
  DEEPSEEK_MODEL,
  MAX_SUMMARY_ROUNDS,
  MAX_TOOL_ROUNDS,
  RATE_LIMIT_LONG_MAX_TRIGGERS,
  RATE_LIMIT_LONG_WINDOW_MS,
  RATE_LIMIT_MAX_TRIGGERS,
  RATE_LIMIT_NOTICE_COOLDOWN_MS,
  RATE_LIMIT_WINDOW_MS,
  REPLY_MAX_TOKENS,
  REPLY_TEMPERATURE,
  REQUEST_TIMEOUT_MS,
  SPLIT_REPLY_MAX_PARTS,
  SPLIT_REPLY_PROBABILITY,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_TEMPERATURE,
  TIME_INTENT_PATTERN,
  TYPING_ACTION_INTERVAL_MS,
  TYPING_DELAY_BASE_MS,
  TYPING_DELAY_JITTER_MS,
  TYPING_DELAY_MAX_MS,
  TYPING_DELAY_PER_CHAR_MS,
  VERBATIM_CONTEXT_MAX,
} from "../consts/aiChat";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../consts/telegram";
import {
  chatBuffers,
  chatSummaries,
  compactionChains,
  lastReplyTimes,
  longTriggerTimes,
  pendingSummaries,
  rateLimitNoticeTimes,
  triggerTimes,
  typingHeartbeats,
} from "../cache/aiChatWorker";
import type { BufferedMessage } from "../types";
import { maybeAddReaction } from "../ai/reactions";
import { maybeSendStickerReply } from "../ai/stickers";
import { sendMessage, sendTypingAction } from "../infra/telegram";
import { TOOL_DEFINITIONS, callTool } from "../tools";
import { getCurrentTime } from "../tools/time";
import type { AiBotInfo, AiChatWorkerMessage } from "../types";

/**
 * AI 闲聊流水线线程（Bun Worker）。主线程（src/auto/message.ts → aiChat.ts 代理）
 * 只做事件投递，重活全在这里：滚动对话缓存、冷却与双滑动窗口限频、拼装
 * 上下文、调 DeepSeek（含 function calling 往返）、连发消息、消息反应与
 * 贴纸跟发。发往 Telegram 的调用不回主线程绕路——本线程 import telegram.ts
 * 时会得到自己独立的 grammY Api 客户端（那个 Bot 实例只用其 bot.api 发请求，
 * 从不 init/轮询；机器人自己的账号身份改由主线程在 bot.init() 后经 init
 * 消息注入，见下方 botInfo）。error 日志经 logger.ts 的转发模式回传主线程
 * 统一落盘。
 *
 * AI 闲聊回复本体：把本群最近的对话记录喂给 DeepSeek（OpenAI 兼容的
 * /chat/completions 接口），生成一条人设化回复。人设文本存放在仓库根目录
 * 的 prompt/persona.txt，修改人设不需要碰代码。
 *
 * 中期记忆：镜像/热块轮换机制见 consts/aiChat.ts 的 COMPACT_BATCH_SIZE 注释；
 * 轮换本身由 recordChatMessage/scheduleRotation/rotateCompaction 实现。
 */

declare var self: Worker;

const SYSTEM_PROMPT: string = readFileSync(PERSONA_PATH, "utf8").trim();

/**
 * 机器人自己的账号身份，由主线程在 bot.init() 之后经 init 消息注入
 * （index.ts 在 runner 启动前注入，postMessage 按 FIFO 送达，保证先于
 * 一切 record/trigger 到达）。转录里的自我认知和自录都靠它。
 */
let botInfo: AiBotInfo | null = null;

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
 * 把文本截断到 maxChars 个 UTF-16 码元以内。slice 可能恰好切在代理对中间
 * （emoji 等），此时去掉孤立的高位代理——孤立代理不是合法字符，混进消息
 * 可能被 Telegram 拒收，混进 prompt 则是每次请求都带着的乱码。
 */
function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let truncated: string = text.slice(0, maxChars);
  const lastCode: number = truncated.charCodeAt(truncated.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
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
function recordChatMessage(chatId: number, id: number, firstName: string, lastName: string, text: string): void {
  const sanitized: string = sanitizeInline(text);
  if (!sanitized) return;
  let buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf) {
    buf = new LinkedQueue<BufferedMessage>();
    chatBuffers.set(chatId, buf);
  }
  buf.push({ id, firstName: sanitizeInline(firstName), lastName: sanitizeInline(lastName), text: sanitized });
  // 轮换机制见 COMPACT_BATCH_SIZE 注释。push 每次只 +1，且轮换把 size 收回
  // COMPACT_BATCH_SIZE 后 push 不会再撞上下面第二个判等，两个 === 各自恰好
  // 在块边界命中一次。
  if (buf.size === VERBATIM_CONTEXT_MAX) {
    for (let i: number = 0; i < COMPACT_BATCH_SIZE; i++) {
      buf.shift();
    }
    scheduleRotation(chatId, buf.last(COMPACT_BATCH_SIZE), true);
  } else if (buf.size === COMPACT_BATCH_SIZE) {
    // 本群的第一块刚攒满：成为首个镜像，只提交压缩，还没有可晋升的旧摘要。
    scheduleRotation(chatId, buf.last(COMPACT_BATCH_SIZE), false);
  }
}

/**
 * 把一轮「晋升旧摘要 + 压缩新镜像」挂到该群的轮换串行链上。链保证时序：
 * 洪峰下第 N+1 轮可能在第 N 轮的压缩调用返回前就到来，串行执行才能保证
 * 晋升到手的一定是上一轮的结果、摘要严格按时间顺序入队。rotateCompaction
 * 自身兜错，链永不 reject。
 * @param mirrorBatch 刚攒满、成为新镜像的一块消息（快照，之后缓存继续滚动不影响它）。
 * @param promoteFirst 本轮是否有旧镜像滑出（首轮没有），有则先晋升其摘要。
 */
function scheduleRotation(chatId: number, mirrorBatch: BufferedMessage[], promoteFirst: boolean): void {
  const prev: Promise<void> = compactionChains.get(chatId) ?? Promise.resolve();
  compactionChains.set(chatId, prev.then(() => rotateCompaction(chatId, mirrorBatch, promoteFirst)));
}

/** 执行一轮轮换：先晋升上一轮镜像的摘要（若有），再 AI 压缩新镜像存为待晋升。 */
async function rotateCompaction(chatId: number, mirrorBatch: BufferedMessage[], promoteFirst: boolean): Promise<void> {
  try {
    if (promoteFirst) {
      promotePendingSummary(chatId);
    }
    const summary: string | null = await summarizeBatch(mirrorBatch);
    if (summary) {
      pendingSummaries.set(chatId, summary);
    } else {
      // 失败刻意不回灌不重试：镜像原文此刻还在逐字区，要到下一轮滑出时
      // 这段中期记忆才真正缺失。
      logger.error(`AI compaction failed: chat ${chatId}'s ${mirrorBatch.length} mirrored messages produced no summary; mid-term memory for this window will be missing once it slides out.`);
    }
  } catch (error: unknown) {
    logger.error("Error in chat compaction task:", error);
  }
}

/** 把上一轮镜像的摘要（其原文刚滑出逐字区）晋升进该群的中期记忆队列。 */
function promotePendingSummary(chatId: number): void {
  const pending: string | undefined = pendingSummaries.get(chatId);
  pendingSummaries.delete(chatId);
  if (!pending) return; // 上一轮压缩失败：无可晋升项，失败当时已记过日志。
  let queue: LinkedQueue<string> | undefined = chatSummaries.get(chatId);
  if (!queue) {
    queue = new LinkedQueue<string>();
    chatSummaries.set(chatId, queue);
  }
  queue.push(pending);
  while (queue.size > MAX_SUMMARY_ROUNDS) {
    queue.shift();
  }
}

/**
 * 调 DeepSeek 把一批冷消息压缩成一条摘要。走独立的中性总结提示词（不带
 * 人设、不带工具），产出压成单行并截断——摘要虽是模型生成的，但源头是
 * 用户文本，保持「一行一条」的转录结构，多行伪造向量在这里同样失效。
 */
async function summarizeBatch(batch: BufferedMessage[]): Promise<string | null> {
  const selfNote: string = botInfo
    ? `注意：[id:${botInfo.id}] 是群里的聊天机器人「${botInfo.first_name}」本人的发言，摘要里请以「${botInfo.first_name}」称呼它。\n\n`
    : "";
  const message: any = await requestCompletion({
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: "system",
        content:
          "你是一个中文群聊记录压缩器。用户会给你一段群聊转录，每行格式为「[id:用户ID] 名字：内容」，同名的人可能是不同的人，请以 id 区分身份。" +
          "请把这段记录压缩成一段简洁的摘要，保留：聊过的话题及走向、谁说过的关键信息（人名后带 [id:xxx] 标注以免混淆）、达成的约定、出现的梗和称呼、人物关系或情绪的变化。" +
          "严格控制篇幅：摘要正文不得超过200字，不要展开细节、不要逐条复述，只挑最要紧的信息压缩成一段话。只输出摘要正文本身，不要任何前缀、解释、列表符号或代码块，不要输出思考过程。",
      },
      { role: "user", content: selfNote + batch.map(formatLine).join("\n") },
    ],
    stream: false,
    temperature: SUMMARY_TEMPERATURE,
    max_tokens: SUMMARY_MAX_TOKENS,
  });
  const content: string | undefined = message?.content;
  if (!content) return null;
  const sanitized: string = sanitizeInline(content);
  if (!sanitized) return null;
  return truncateInline(sanitized, SUMMARY_MAX_CHARS);
}

/** 发言人的显示名：first/last 拼接，都没有则给个占位。 */
function displayName(m: BufferedMessage): string {
  return [m.firstName, m.lastName].filter((p: string) => !!p).join(" ").trim() || "某杂鱼";
}

/** 把一条缓存消息格式化成喂给模型的一行：标出 id，避免重名混淆身份。 */
function formatLine(m: BufferedMessage): string {
  return `[id:${m.id}] ${displayName(m)}：${m.text}`;
}

/** buildUserContent 的可选附加上下文，按需组合，见各字段说明。 */
interface UserContentOptions {
  /** 是否要求模型把回复拆成多条短消息（一行一条）连发。 */
  splitMode: boolean;
  /** 若本次是「用户回复了机器人」，被回复的那条机器人消息文本，作为上下文
   *  （机器人自己发的消息不会作为更新推送回来，不在缓存里）。 */
  repliedBotText?: string;
  /** 若本次是随机触发（见 generateAndSendReply 的 isRandomTrigger），触发者的
   *  显示名——这种情况下回复不会用 Telegram 的「回复」关联到原消息，要求模型
   *  改为在文字里点名称呼对方。 */
  addressee?: string;
  /** 若最新消息在问时间/日期（见 isTimeRelatedQuery），预先查好的真实当前时间
   *  文本，直接喂给模型当已知事实用，不走 function calling（原因见 callDeepSeek
   *  的 tool_choice 注释）。 */
  timeContext?: string;
}

/**
 * 把某群的对话上下文拼装成给模型的用户消息内容：先是中期记忆摘要段
 * （若有，最多 MAX_SUMMARY_ROUNDS 轮，从旧到新），再是逐字聊天记录
 * （整个缓存 = 镜像 + 热，50 ~ 100 条，见 COMPACT_BATCH_SIZE 的注释）。
 * @param chatId 群聊 ID。
 * @param selfInfo 机器人自己的账号身份（见 botInfo），用于转录里的自我认知。
 * @returns 拼好的用户消息内容；缓存为空时返回 null。
 */
function buildUserContent(chatId: number, selfInfo: AiBotInfo, options: UserContentOptions): string | null {
  const { splitMode, repliedBotText, addressee, timeContext } = options;
  const buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf || buf.size === 0) return null;

  const recent: BufferedMessage[] = buf.last(VERBATIM_CONTEXT_MAX);
  const lines: string[] = recent.map(formatLine);
  if (repliedBotText) {
    // 同样压成单行：这段文本虽是机器人自己说过的话，保持转录「一行一条」的
    // 结构不变即可杜绝任何多行伪造的可能。
    lines.push(`（你刚才说过：${sanitizeInline(repliedBotText)}）`);
  }
  if (timeContext) {
    lines.push(`（提示：现在的实际时间是 ${timeContext}，如果最新消息在问时间/日期，请直接如实告知这个值，不要编造）`);
  }

  // 随机触发时这条回复不会挂 Telegram 的回复引用，得让模型自己在文字里点名，
  // 别人才看得出是在接谁的话。全名太长（比如中间夹着 last name）念出来生硬，
  // 交给模型自己判断——名字短就整个用，长就挑其中自然的一部分当称呼。
  const addressInstruction: string = addressee
    ? `这条回复不会以「回复」形式关联到最新那条消息，所以开头要先点名称呼对方（TA 的名字是「${addressee}」，比如「${addressee}，……」；如果这个名字比较长念着别扭，可以自己判断截取其中简短自然的一部分来称呼，不必照抄全名），让人一眼看出你在接谁的话。`
    : "";

  const replyInstruction: string = splitMode
    ? `请针对最新这条消息，以你的人设回复，并把回复拆成 2 到 ${SPLIT_REPLY_MAX_PARTS} 条连贯的短消息——就像真人打字时想到哪发到哪、一句接一句连发那样，每条一行、语义上前后衔接（比如先反应、再吐槽、再补一刀）。默认拆成 2~3 条就够了，只有真的意犹未尽、还有话要补时，才用到 4~${SPLIT_REPLY_MAX_PARTS} 条，不要为了凑数硬拆。${addressInstruction}只输出这几行消息本身，一行一条，不要编号、解释、（称呼除外的）前缀、引号、代码块或「[id:...]」这类标记。`
    : `请针对最新这条消息，以你的人设回复一到两句话，自然接住话题。${addressInstruction}只输出你要发到群里的那句话本身，不要任何解释、（称呼除外的）前缀、引号、代码块或「[id:...]」这类标记。`;

  // 明确告诉模型「你自己」在这个群里的账号身份：转录里 @ 你的 username、
  // 回复你的消息、以及标着你自己 id 的行（见发送后的 recordChatMessage 自录）
  // 都要能认出来是你自己，不能当成第三个人。username/id 来自主线程在
  // bot.init() 之后注入的 init 消息（见 botInfo），不写死在代码里。
  const selfIdentity: string =
    `你在这个群里的 Telegram 账号是 @${selfInfo.username}（[id:${selfInfo.id}]）：` +
    `记录里标着这个 id 的行是你自己之前说过的话，别把它们当成别人的发言；` +
    `消息里 @ 这个用户名、或回复你的消息，都是在跟你说话。`;

  // 中期记忆段：更早的冷历史被压缩成的摘要（每轮 50 条，从旧到新），带着
  // 自己的声明句放在整段上下文最前面——转录的声明句则紧贴逐字记录，两段
  // 各自声明、界线分明，摘要行不会被误当成聊天记录的一部分。摘要入队时
  // 已压成单行（见 summarizeBatch），「一行一条」的防伪造结构同样成立。
  const summaryQueue: LinkedQueue<string> | undefined = chatSummaries.get(chatId);
  const summaries: string[] = summaryQueue ? summaryQueue.last(MAX_SUMMARY_ROUNDS) : [];
  const summaryBlock: string =
    summaries.length > 0
      ? "在下方聊天记录之前，更早的对话已被压缩成如下摘要（按时间从旧到新），是你对这个群的中期记忆——延续话题、称呼和梗时可以参考；摘要与下方逐字记录冲突时，以逐字记录为准：\n" +
        summaries.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n") +
        "\n\n"
      : "";

  return (
    summaryBlock +
    "以下是本群最近的聊天记录，每行格式为「[id:用户ID] 名字：内容」，同名的人可能是不同的人，请以 id 区分身份，最后一条是最新消息，请正确识别情况（不要编造，不要张冠李戴），并作出符合人设的回应。" +
    selfIdentity +
    "\n\n" +
    lines.join("\n") +
    "\n\n" +
    replyInstruction
  );
}

/** 触发这次回复的最新一条缓存消息；缓存为空时返回 undefined。 */
function getLatestMessage(chatId: number): BufferedMessage | undefined {
  const buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  return buf?.last(1)[0];
}

/** 是否在问时间/日期（见 consts/aiChat.ts 的 TIME_INTENT_PATTERN 注释）。 */
function isTimeRelatedQuery(text: string): boolean {
  return TIME_INTENT_PATTERN.test(text);
}

/**
 * DeepSeek /chat/completions 的底层收发：带超时、错误统一记日志。回复
 * 流水线（callDeepSeek 的工具往返循环）与冷消息压缩（summarizeBatch）共用。
 * @param body 完整请求体（model/messages/tools 等由调用方拼好）。
 * @returns choices[0].message；请求失败、超时或响应异常时返回 null。
 */
async function requestCompletion(body: Record<string, unknown>): Promise<any | null> {
  const data: any = await fetchJsonWithTimeout(
    DEEPSEEK_API_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
    },
    REQUEST_TIMEOUT_MS,
    "DeepSeek API"
  );
  const choice: any = data?.choices?.[0];
  // 静默失败（200 但 content 为空）的成因见 REPLY_MAX_TOKENS 的注释；这里
  // 点名记下来，否则上层只能看到「没产出」，查不到原因。
  if (choice?.finish_reason === "length" && !choice?.message?.content) {
    logger.error(
      `DeepSeek API exhausted max_tokens=${body.max_tokens} before producing content ` +
      `(reasoning_tokens=${data?.usage?.completion_tokens_details?.reasoning_tokens ?? "?"}).`
    );
  }
  return choice?.message ?? null;
}

/**
 * 调用 DeepSeek 的 /chat/completions 接口生成一条回复。支持 function
 * calling：模型可以要求先执行 src/tools 里的工具（目前是查东京天气），
 * 工具结果喂回去后再继续生成，直到给出最终文本或达到轮数上限。
 * 注意：tools 只能用默认的 auto tool_choice——这个模型开着「思考模式」，
 * 强制指定某个具体函数（tool_choice: {type:"function",...}）会被 API
 * 直接 400 拒绝（"Thinking mode does not support this tool_choice"）。
 * 查时间不走这条路，见 isTimeRelatedQuery + UserContentOptions.timeContext。
 * @param userContent buildUserContent 拼好的对话上下文。
 * @returns 清洗后的回复文本；请求失败、超时或空输出时返回 null。
 */
async function callDeepSeek(userContent: string): Promise<string | null> {
  // 每次请求现查当前时间拼进系统提示词（而非用模块加载时算好的值），worker
  // 线程常驻、一跑就是几天，缓存的时间会很快过期。
  const systemPrompt: string = `${SYSTEM_PROMPT}\n\n当前实际时间：${getCurrentTime().formatted}（东京时间 UTC+9）。`;
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  for (let round: number = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const message: any = await requestCompletion({
      model: DEEPSEEK_MODEL,
      messages,
      tools: TOOL_DEFINITIONS,
      stream: false,
      temperature: REPLY_TEMPERATURE,
      max_tokens: REPLY_MAX_TOKENS,
    });
    if (!message) return null;

    const toolCalls: any[] | undefined = message.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      messages.push(message);
      for (const call of toolCalls) {
        const result: string = await callTool(call?.function?.name);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      continue;
    }

    const content: string | undefined = message.content;
    return content ? cleanReply(content) : null;
  }

  return null;
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
  return truncateInline(text, TELEGRAM_MESSAGE_MAX_CHARS);
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
  const base: number = TYPING_DELAY_BASE_MS + nextPart.length * TYPING_DELAY_PER_CHAR_MS;
  const jitter: number = Math.random() * TYPING_DELAY_JITTER_MS;
  return Math.min(base + jitter, TYPING_DELAY_MAX_MS);
}

/**
 * 在 DeepSeek 生成阶段（耗时不可控，最长可达 REQUEST_TIMEOUT_MS）持续显示
 * 「正在输入…」：立即发一次，此后每隔 TYPING_ACTION_INTERVAL_MS 重发防止过期。
 * 只覆盖生成阶段——连发多条消息之间的停顿单次封顶不超过 Telegram 状态的
 * 过期时间，改由发送循环每次发送后显式补一次 sendTypingAction（见
 * generateAndSendReply），不需要为此另开定时器。
 *
 * 同一 chatId 的并发调用（每群冷却仅 AI_REPLY_COOLDOWN_MS，并不保证互斥，
 * 见 generateAndSendReply 的限频注释）共享同一个定时器，用引用计数管理，
 * 避免各自开一个定时器把「正在输入…」的调用量成倍放大。
 *
 * 一旦某次重发失败（多半是被踢出群、无权限或该操作单独被限流），当场停掉
 * 这个 chatId 的定时器并清除条目，不再对着大概率会持续失败的目标每隔几秒
 * 重试一次。
 * @returns 停止函数：调用后本次占用的引用计数减一，归零时才真正清定时器。
 */
function startTypingHeartbeat(chatId: number): () => void {
  let entry = typingHeartbeats.get(chatId);
  if (!entry) {
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      void sendTypingAction(chatId).then((ok: boolean) => {
        if (ok) return;
        // 按 timer 身份核对而非只按 chatId 查表：这次失败可能来自已经停止的
        // 上一代心跳（该 tick 发出时它还活着，回包却晚到了），此时表里
        // 早被换成同一 chatId 的新一代心跳，绝不能把新的也带着清掉。
        const current = typingHeartbeats.get(chatId);
        if (current && current.timer === timer) {
          clearInterval(current.timer);
          typingHeartbeats.delete(chatId);
        }
      });
    }, TYPING_ACTION_INTERVAL_MS);
    entry = { timer, refCount: 0 };
    typingHeartbeats.set(chatId, entry);
    void sendTypingAction(chatId);
  }
  entry.refCount++;

  // 闭包捕获本次拿到的 entry 本体：停止时若表里已换成同一 chatId 的新一代
  // 心跳（本代先因重发失败被清、随后又有新调用开了新的），绝不能把新一代的
  // 引用计数减掉/定时器清掉——和上面重发失败路径按 timer 身份核对是同一个
  // 道理。
  const acquired = entry;
  let released: boolean = false;
  return () => {
    if (released) return;
    released = true;
    const current = typingHeartbeats.get(chatId);
    if (current !== acquired) return; // 本代已因重发失败被提前清掉（表里为空或已是新一代）
    if (--current.refCount <= 0) {
      clearInterval(current.timer);
      typingHeartbeats.delete(chatId);
    }
  };
}

/**
 * 限频黑洞的明确反馈：触发被滑动窗口丢弃时回一句「你们太快了」，而不是
 * 静默失踪让群友以为机器人坏了。提示自身带独立冷却（每群至多一分钟一条，
 * 见 RATE_LIMIT_NOTICE_COOLDOWN_MS），刷屏场景下不会跟着刷。0.5 秒冷却的
 * 丢弃不提示——那只是相邻两次触发的间隔闸，正常聊天就会碰到，提示反而吵。
 */
function notifyRateLimited(chatId: number, now: number): void {
  const lastNoticeTime: number = rateLimitNoticeTimes.get(chatId) ?? 0;
  if (now - lastNoticeTime < RATE_LIMIT_NOTICE_COOLDOWN_MS) return;
  rateLimitNoticeTimes.set(chatId, now);
  void sendMessage(chatId, "你们太快了……本天才的嘴巴也是要休息的，这波先不接了，杂鱼们悠着点♡");
}

/**
 * 生成并发送 AI 回复。整个过程 fire-and-forget，不阻塞本线程的消息分发
 * （限频判定是同步的，其余都在异步任务里跑）。
 * 以 SPLIT_REPLY_PROBABILITY 概率采用「连发多条短消息」形式：让模型按行输出
 * 几条前后衔接的短句，逐条带打字间隔发出（仅第一条引用触发消息）；
 * 其余情况仍是普通的单条回复。
 * @param chatId 目标群聊。
 * @param replyToMessageId 触发这次回复的消息 ID，回复/@ 触发时用它引用原消息。
 * @param repliedBotText 若是「用户回复机器人」触发，被回复的机器人消息文本。
 * @param isRandomTrigger 是否是无人回复/@机器人、单纯按概率命中的随机搭话。
 *   这种情况不使用 Telegram 的回复引用（不去 @ 或挂起原消息），改为让模型
 *   在文字里直接点名称呼触发者，更像真人「指名道姓」地插句嘴而非正式回帖。
 */
function generateAndSendReply(
  chatId: number,
  replyToMessageId: number,
  repliedBotText: string | undefined,
  isRandomTrigger: boolean
): void {
  // init 消息在 index.ts 里先于 runner 启动送出，FIFO 保证它先到；走到这里
  // 说明编排被改坏了，丢弃触发并留痕，别让流水线在缺身份的情况下硬跑。
  if (!botInfo) {
    logger.error("aiChatWorker received trigger before init message; dropping.");
    return;
  }
  const selfInfo: AiBotInfo = botInfo;

  // 每群冷却：在发起任何异步工作之前同步判定并占位，这样冷却窗口内的
  // 并发触发（包括 100% 命中的回复/@ 触发）都会在烧到 API 之前被丢弃。
  const now: number = Date.now();
  if (now - (lastReplyTimes.get(chatId) ?? 0) < AI_REPLY_COOLDOWN_MS) {
    return;
  }

  // 本群 1 分钟 / 5 分钟双重限频：先把各自窗口外的旧触发挤掉，再看余量。
  // 三道闸（冷却 + 两个滑动窗口）都过了才一起落账，避免被拒的触发白白
  // 占用冷却/配额。
  let times: LinkedQueue<number> | undefined = triggerTimes.get(chatId);
  if (!times) {
    times = new LinkedQueue<number>();
    triggerTimes.set(chatId, times);
  }
  while (times.size > 0 && now - times.peek()! >= RATE_LIMIT_WINDOW_MS) {
    times.shift();
  }
  if (times.size >= RATE_LIMIT_MAX_TRIGGERS) {
    notifyRateLimited(chatId, now);
    return;
  }

  let longTimes: LinkedQueue<number> | undefined = longTriggerTimes.get(chatId);
  if (!longTimes) {
    longTimes = new LinkedQueue<number>();
    longTriggerTimes.set(chatId, longTimes);
  }
  while (longTimes.size > 0 && now - longTimes.peek()! >= RATE_LIMIT_LONG_WINDOW_MS) {
    longTimes.shift();
  }
  if (longTimes.size >= RATE_LIMIT_LONG_MAX_TRIGGERS) {
    notifyRateLimited(chatId, now);
    return;
  }

  lastReplyTimes.set(chatId, now);
  times.push(now);
  longTimes.push(now);

  const splitMode: boolean = Math.random() < SPLIT_REPLY_PROBABILITY;

  void (async (): Promise<void> => {
    const latestMessage: BufferedMessage | undefined = getLatestMessage(chatId);
    const addressee: string | undefined = isRandomTrigger && latestMessage ? displayName(latestMessage) : undefined;
    const timeContext: string | undefined = isTimeRelatedQuery(latestMessage?.text ?? "")
      ? `${getCurrentTime().formatted}（东京时间 UTC+9）`
      : undefined;

    const userContent: string | null = buildUserContent(chatId, selfInfo, { splitMode, repliedBotText, addressee, timeContext });
    if (!userContent) return;

    // 生成阶段（耗时不可控）用持续重发的心跳显示「正在输入…」，见
    // startTypingHeartbeat；try/finally 保证即使 callDeepSeek 抛异常，
    // 心跳也一定会被停掉。生成结束后（无论成败）就不再需要它——发送阶段
    // 各段之间的停顿改由下面的发送循环逐次显式补一次，见那里的注释。
    const stopTyping: () => void = startTypingHeartbeat(chatId);
    let reply: string | null;
    try {
      reply = await callDeepSeek(userContent);
    } finally {
      stopTyping();
    }
    if (!reply) return;

    // 回复刚生成就先按配置概率给触发消息扣一个应景的标准 emoji 反应（见
    // src/ai/reactions.ts）——放在发送循环之前，连发模式的打字间隔（可能累计
    // 十来秒）才不会把反应也拖到最后，更像真人「先点个反应再慢慢打字」。
    maybeAddReaction(chatId, replyToMessageId, reply);

    // 单条模式下模型偶尔也会换行，此时不该按行拆——原样整条发出。
    const parts: string[] = splitMode ? splitReplyParts(reply) : [reply];
    for (let i: number = 0; i < parts.length; i++) {
      const part: string = parts[i]!;
      // 随机触发不挂 Telegram 回复引用，靠模型在文字里点名（见 addressee）；
      // 回复/@ 触发照旧引用第一条。
      const quoteId: number | undefined = !isRandomTrigger && i === 0 ? replyToMessageId : undefined;
      const sentMessageId: number | undefined = await sendMessage(chatId, part, quoteId);
      // 自己发出去的消息 Telegram 不会作为更新推送回来，不自录的话转录里
      // 永远缺自己那半边对话。录入后配合 buildUserContent 里的 selfIdentity
      // 说明，模型才能在上下文中认出自己说过什么。发送失败的不录。
      if (sentMessageId !== undefined) {
        recordChatMessage(chatId, selfInfo.id, selfInfo.first_name, "", part);
      }
      if (i < parts.length - 1) {
        // sendMessage 刚发出的那条会让 Telegram 清掉「正在输入…」状态（见
        // sendTypingAction 的注释），这里补发一次让下一段开始前重新显示。
        // 单次调用即可覆盖整个停顿——typingDelayMs 封顶在 Telegram 状态的
        // 过期时间内，不需要像生成阶段那样定时重发。
        void sendTypingAction(chatId);
        await sleep(typingDelayMs(parts[i + 1]!));
      }
    }

    // 每次 AI 回复（含随机搭话）后，按配置概率附带发一枚应景的白名单贴纸，
    // 见 src/ai/stickers.ts；发成功的贴纸同样以描述行自录进对话缓存，让模型
    // 知道自己刚发过什么贴纸。
    maybeSendStickerReply(chatId, reply, (stickerDescription: string) => {
      recordChatMessage(chatId, selfInfo.id, selfInfo.first_name, "", stickerDescription);
    });
  })().catch((error: unknown) => {
    logger.error("Error in AI reply task:", error);
  });
}

self.onmessage = (event: MessageEvent<AiChatWorkerMessage>) => {
  const msg: AiChatWorkerMessage = event.data;
  switch (msg.type) {
    case "init":
      botInfo = msg.botInfo;
      break;
    case "record":
      recordChatMessage(msg.chatId, msg.senderId, msg.firstName, msg.lastName, msg.text);
      break;
    case "trigger":
      generateAndSendReply(msg.chatId, msg.replyToMessageId, msg.repliedBotText, msg.isRandomTrigger);
      break;
  }
};
