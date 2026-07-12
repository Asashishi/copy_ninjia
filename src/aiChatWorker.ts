import { logger } from "./logger";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEEPSEEK_API_KEY } from "./config";
import { LinkedQueue } from "./linkedQueue";
import { maybeAddReaction } from "./reactions";
import { maybeSendStickerReply } from "./stickers";
import { sendMessage } from "./telegram";
import { TOOL_DEFINITIONS, callTool } from "./tools";
import { getCurrentTime } from "./tools/time";
import type { AiBotInfo, AiChatWorkerMessage } from "./aiChat";

/**
 * AI 闲聊流水线线程（Bun Worker）。主线程（handlers.ts → aiChat.ts 代理）
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
 */

declare var self: Worker;

const DEEPSEEK_API_URL: string = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL: string = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS: number = 60_000;

const PERSONA_PATH: string = join(import.meta.dir, "..", "prompt", "persona.txt");
const SYSTEM_PROMPT: string = readFileSync(PERSONA_PATH, "utf8").trim();

/** 每个群聊在内存里保留的最近消息条数（Bot API 无法拉历史，只能自己滚动缓存）。 */
const BUFFER_SIZE: number = 75;
/** 生成回复时，从缓存里取最近多少条作为上下文喂给模型（与 BUFFER_SIZE 相等即整个缓存全喂）。 */
const CONTEXT_SIZE: number = 75;
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
 * 分群限频：单个群滚动窗口内最多触发多少次 AI 回复。每群冷却只限制相邻
 * 两次的间隔（1.5 秒冷却下一分钟仍可达 40 次），这两道滑动窗口给单群的
 * 总量再兜两层——1 分钟窗口挡住短时爆发，5 分钟窗口再挡住那种卡着 1 分钟
 * 窗口边界反复刷、绕开短窗口上限的持续刷屏。两道闸中任意一道打满，触发
 * 就直接静默丢弃（黑洞），等对应窗口里旧时刻滑出窗口腾出名额才恢复，不是
 * 硬性定时重置。只在入口计一次数——一次触发内的「连发多条短消息」属于
 * 同一次回复，不重复计数。
 */
const RATE_LIMIT_WINDOW_MS: number = 60_000;
const RATE_LIMIT_MAX_TRIGGERS: number = 45;
const RATE_LIMIT_LONG_WINDOW_MS: number = 5 * 60_000;
const RATE_LIMIT_LONG_MAX_TRIGGERS: number = 150;

/** 各群 1 分钟窗口内每次触发的时刻（毫秒时间戳），队首最旧，过期即出队。 */
const triggerTimes: Map<number, LinkedQueue<number>> = new Map();
/** 各群 5 分钟窗口内每次触发的时刻（毫秒时间戳），队首最旧，过期即出队。 */
const longTriggerTimes: Map<number, LinkedQueue<number>> = new Map();

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
  while (buf.size > BUFFER_SIZE) {
    buf.shift();
  }
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
   *  文本，直接喂给模型当已知事实用，不经由 function calling 让模型自己查——
   *  该模型的「思考模式」不支持强制指定 tool_choice（会 400），只能靠这种
   *  直接注入上下文的方式保证不瞎编。 */
  timeContext?: string;
}

/**
 * 把某群的滚动缓存里最近 CONTEXT_SIZE 条拼装成给模型的用户消息内容。
 * @param chatId 群聊 ID。
 * @param selfInfo 机器人自己的账号身份（见 botInfo），用于转录里的自我认知。
 * @returns 拼好的用户消息内容；缓存为空时返回 null。
 */
function buildUserContent(chatId: number, selfInfo: AiBotInfo, options: UserContentOptions): string | null {
  const { splitMode, repliedBotText, addressee, timeContext } = options;
  const buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf || buf.size === 0) return null;

  const recent: BufferedMessage[] = buf.last(CONTEXT_SIZE);
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
    ? `请针对最新这条消息，以你的人设回复，并把回复拆成 2 到 ${SPLIT_REPLY_MAX_PARTS} 条连贯的短消息——就像真人打字时想到哪发到哪、一句接一句连发那样，每条一行、语义上前后衔接（比如先反应、再吐槽、再补一刀）。${addressInstruction}只输出这几行消息本身，一行一条，不要编号、解释、（称呼除外的）前缀、引号、代码块或「[id:...]」这类标记。`
    : `请针对最新这条消息，以你的人设回复一到两句话，自然接住话题。${addressInstruction}只输出你要发到群里的那句话本身，不要任何解释、（称呼除外的）前缀、引号、代码块或「[id:...]」这类标记。`;

  // 明确告诉模型「你自己」在这个群里的账号身份：转录里 @ 你的 username、
  // 回复你的消息、以及标着你自己 id 的行（见发送后的 recordChatMessage 自录）
  // 都要能认出来是你自己，不能当成第三个人。username/id 来自主线程在
  // bot.init() 之后注入的 init 消息（见 botInfo），不写死在代码里。
  const selfIdentity: string =
    `你在这个群里的 Telegram 账号是 @${selfInfo.username}（[id:${selfInfo.id}]）：` +
    `记录里标着这个 id 的行是你自己之前说过的话，别把它们当成别人的发言；` +
    `消息里 @ 这个用户名、或回复你的消息，都是在跟你说话。`;

  return (
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

/**
 * 判断一条消息是否在问时间/日期。命中时会把真实当前时间直接注入 prompt
 * （见 UserContentOptions.timeContext），而不是交给模型自己判断要不要查——
 * auto 模式下模型经常瞎编时间而不调用工具，命中率太低。
 */
const TIME_INTENT_PATTERN: RegExp =
  /现在几点|几点了|几点钟|现在.{0,4}时间|当前时间|今天.{0,3}[几号日]|几月几[号日]|星期几|周几|报时|what\s*time|current\s*time/i;

function isTimeRelatedQuery(text: string): boolean {
  return TIME_INTENT_PATTERN.test(text);
}

/**
 * 一次工具调用往返最多允许几轮（模型要工具结果 -> 喂回去 -> 模型可能再要
 * 下一个工具……）。给个上限防止模型陷入死循环反复要工具，烧穿 API 配额。
 */
const MAX_TOOL_ROUNDS: number = 3;

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
  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  for (let round: number = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const controller: AbortController = new AbortController();
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let message: any;
    try {
      const body: Record<string, unknown> = {
        model: DEEPSEEK_MODEL,
        messages,
        tools: TOOL_DEFINITIONS,
        stream: false,
        temperature: 1.2,
        max_tokens: 4096,
      };

      const response: Response = await fetch(DEEPSEEK_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.error(`DeepSeek API error: ${response.status} ${await response.text()}`);
        return null;
      }

      const data: any = await response.json();
      message = data?.choices?.[0]?.message;
    } catch (error: unknown) {
      logger.error("Error calling DeepSeek API:", error);
      return null;
    } finally {
      clearTimeout(timer);
    }

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

    const reply: string | null = await callDeepSeek(userContent);
    if (!reply) return;

    // 回复刚生成就先按配置概率给触发消息扣一个应景的标准 emoji 反应（见
    // src/reactions.ts）——放在发送循环之前，连发模式的打字间隔（可能累计
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
        await sleep(typingDelayMs(parts[i + 1]!));
      }
    }

    // 每次 AI 回复（含随机搭话）后，按配置概率附带发一枚应景的白名单贴纸，
    // 见 src/stickers.ts；发成功的贴纸同样以描述行自录进对话缓存，让模型
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
