import { deleteMessage, sendMessage, setMessageReaction } from "../../infra/telegram";
import { sleep } from "../../libs/sleep";
import { truncateInline } from "../../libs/text";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../../consts/telegram";
import {
  ADD_REACTION_TOOL_INSTRUCTION,
  AI_TEXT_TYPO_PROBABILITY,
  DELETE_OWN_MESSAGE_TOOL_INSTRUCTION,
  MAX_ACTIONS_PER_REPLY,
  MAX_REACTIONS_PER_REPLY,
  SEND_MESSAGE_TOOL_INSTRUCTION,
  TYPO_QUICK_CORRECTION_MAX_MS,
  TYPO_QUICK_CORRECTION_MIN_MS,
  TYPO_QUICK_CORRECTION_PROBABILITY,
  TYPO_RECALL_CORRECTION_PROBABILITY,
  TYPO_RECALL_DELETE_MAX_MS,
  TYPO_RECALL_DELETE_MIN_MS,
  TYPING_DELAY_BASE_MS,
  TYPING_DELAY_JITTER_MS,
  TYPING_DELAY_MAX_MS,
  TYPING_DELAY_PER_CHAR_MS,
} from "../../consts/aiChat";
import { ADD_REACTION_TOOL, DELETE_OWN_MESSAGE_TOOL, SEND_MESSAGE_TOOL, SEND_STICKER_TOOL, VIEW_STICKER_PACK_TOOL } from "../../consts/tools";
import { REACTION_EMOJIS } from "../reactions";
import {
  buildSendStickerToolDefinition,
  buildStickerPackMenu,
  buildViewStickerPackToolDefinition,
  createStickerRoundState,
  sendStickerTool,
  viewStickerPackTool,
} from "./stickers";
import type { ReplyToolContext, ReplyToolset, StickerPackCandidate, StickerRoundState, ToolDefinition } from "../../types";

type TypoCorrectionMode = "quick" | "recall" | "ignore";

export interface SingleCharacterSubstitution {
  readonly expected: string;
  readonly typo: string;
}

/**
 * 一轮 AI 回复的「行动工具集」：发言（send_message）、撤回自己本轮刚发的
 * 文字消息（delete_own_message）、消息反应（add_reaction）、两层应景贴纸
 * （view_sticker_pack / send_sticker，见同目录 stickers.ts）。模型在同一次
 * function calling 对话里自主决定做
 * 哪几样、什么顺序——发言不再是「最终文本」，而是和贴纸/反应平级的工具
 * 动作；要不要以「回复」形式挂在触发消息上也由模型按条决定
 * （send_message 的 reply_to_trigger 参数）。
 *
 * 每轮回复经 createReplyToolset 新建一份工具集：贴纸菜单在此刻组装一次
 * （工具描述里的编号和执行时校验的必须是同一份，见 stickers.ts 模块头
 * 注），各工具的限额也挂在这份闭包状态上——动作总量（消息 + 撤回 + 贴纸 +
 * 反应合计，硬顶 MAX_ACTIONS_PER_REPLY）在 execute 入口统一把关，贴纸枚数
 * 与去重、反应次数再各自设分项上限。执行结果一律是喂回模型的 JSON 字符串
 * ——被限额/校验拒绝时模型能从 error 字段知道动作没做成。
 */

/**
 * 清洗模型给出的消息文本，得到可直接发送的纯文本：去掉联网搜索可能附带的
 * 行内引用标记（「[[1]](https://…)」，发到群里既丑又暴露机器人身份）、
 * 首尾空白、包裹的代码块围栏和成对引号，并截断到 Telegram 单条消息上限。
 * 空则返回 null。send_message 工具的每条文本、以及模型不走工具时的最终
 * 正文兜底（见 workers/aiChatWorker.ts）都过这一道。
 */
export function cleanReply(raw: string): string | null {
  // URL 部分故意不排除 `)`：链接本身带括号很常见（如维基百科的消歧义链接
  // .../Foo_(bar)），排除 `)` 会让匹配在 URL 内部就截停。但也不能简单放开
  // 成贪婪的 `[^\s]+`（曾经的实现）：中文正文经常整行没有任何空白字符，
  // 贪婪匹配会一路吃到本行最后一个 `)` 才回溯停下，把引用标记之后、这个
  // 无关 `)` 之前的大段正文一并吞掉。改成「非括号非空白字符，或者一对不
  // 含嵌套的平衡括号」重复一次以上：维基百科式的 .../Foo_(bar) 能作为一个
  // 平衡括号整体吃掉，而遇到与 URL 无关的孤立 `)`（前面没有配对的 `(`）时
  // 无法再继续匹配，会在引用标记自己的收尾括号处停下，不会越界。
  let text: string = raw.replace(/\[\[\d+\]\]\((?:[^\s()]|\([^\s()]*\))+\)/g, "").trim();
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

/** 每条消息临发前「正在输入…」窗口的时长（1~7.5 秒）：按本条消息的长度
 *  估一个停顿加随机抖动，再统一封顶，见 consts/aiChat.ts 的 TYPING_DELAY_*。 */
function typingDelayMs(nextPart: string): number {
  const base: number = TYPING_DELAY_BASE_MS + nextPart.length * TYPING_DELAY_PER_CHAR_MS;
  const jitter: number = Math.random() * TYPING_DELAY_JITTER_MS;
  return Math.min(base + jitter, TYPING_DELAY_MAX_MS);
}

function randomDelayMs(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickTypoCorrectionMode(): TypoCorrectionMode {
  const roll: number = Math.random();
  if (roll < TYPO_QUICK_CORRECTION_PROBABILITY) return "quick";
  if (roll < TYPO_QUICK_CORRECTION_PROBABILITY + TYPO_RECALL_CORRECTION_PROBABILITY) return "recall";
  return "ignore";
}

export function findSingleCharacterSubstitution(original: string, candidate: string): SingleCharacterSubstitution | null {
  const originalChars: string[] = Array.from(original);
  const candidateChars: string[] = Array.from(candidate);
  if (originalChars.length !== candidateChars.length) return null;

  let diffIndex: number | null = null;
  for (let i = 0; i < originalChars.length; i++) {
    if (originalChars[i] === candidateChars[i]) continue;
    if (diffIndex !== null) return null;
    diffIndex = i;
  }
  if (diffIndex === null) return null;

  const expected: string = originalChars[diffIndex]!;
  const typo: string = candidateChars[diffIndex]!;
  if (!expected.trim() || !typo.trim()) return null;
  return { expected, typo };
}

function buildSendMessageToolDefinition(): ToolDefinition {
  return {
    name: SEND_MESSAGE_TOOL,
    description: SEND_MESSAGE_TOOL_INSTRUCTION,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要发到群里的消息文本。" },
        reply_to_trigger: { type: "boolean", description: "是否以「回复」形式挂在触发你这次回复的那条消息上；省略视为 false。" },
        typo_text: { type: "string", description: "可选：同一句话的手滑版本，只能把 text 里的一个已有字替换成另一个字；长度必须和 text 完全一致，不能多打、少打、重复字或改动两处。是否真的发送这个版本由执行侧按概率决定；省略则不会自动制造错字。" },
        typo_correction_text: { type: "string", description: "可选：typo_text 里唯一被替换位置的正确字，用于执行侧掷中快速补发时发送。只写这一个字；即使错在一个词里面，也不要写整个正确词或完整句。执行侧会从 text 自动校验/推导，并只发送这个单字。" },
      },
      required: ["text"],
    },
  };
}

function buildDeleteOwnMessageToolDefinition(): ToolDefinition {
  return {
    name: DELETE_OWN_MESSAGE_TOOL,
    description: DELETE_OWN_MESSAGE_TOOL_INSTRUCTION,
    parameters: {
      type: "object",
      properties: {
        message_id: { type: "integer", description: "要撤回的消息 ID，必须来自本轮 send_message 成功结果返回的 message_id。" },
      },
      required: ["message_id"],
    },
  };
}

/**
 * 文本是否是「纯 emoji 消息」：至少含一个图形 emoji，且除 emoji 本体/emoji
 * 组件（肤色、变体选择符、ZWJ 等）/空白外没有任何其它字符。这类消息被
 * send_message 拒绝——机器人不直接发表情，能直接发的画面表达只有贴纸，
 * 对消息表态用 add_reaction。导出仅为可测试性。
 */
export function isEmojiOnly(text: string): boolean {
  return /\p{Extended_Pictographic}/u.test(text) && /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u.test(text);
}

/** REACTION_EMOJIS 为空（配置被清空）时返回 null，不提供这个工具。 */
function buildAddReactionToolDefinition(): ToolDefinition | null {
  if (REACTION_EMOJIS.length === 0) return null;
  return {
    name: ADD_REACTION_TOOL,
    description: ADD_REACTION_TOOL_INSTRUCTION + REACTION_EMOJIS.join(" "),
    parameters: {
      type: "object",
      properties: {
        emoji: { type: "string", description: "要扣的反应 emoji，必须是清单里列出的其中一个。" },
      },
      required: ["emoji"],
    },
  };
}

/** 从参数 JSON 里解析出一个非空字符串字段；解析失败/缺失/类型不对返回 null。 */
function parseStringField(argumentsJson: string, field: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  const value: unknown = (parsed as Record<string, unknown> | null)?.[field];
  return typeof value === "string" && value.trim() ? value : null;
}

/** 从参数 JSON 里解析出一个布尔字段；解析失败/缺失/类型不对一律按 false 处理
 *  （reply_to_trigger 是可选参数，缺省即「不挂回复引用」）。 */
function parseBooleanField(argumentsJson: string, field: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return false;
  }
  return (parsed as Record<string, unknown> | null)?.[field] === true;
}

/** 从参数 JSON 里解析出一个正整数；解析失败/缺失/类型不对返回 null。 */
function parsePositiveIntegerField(argumentsJson: string, field: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  const value: unknown = (parsed as Record<string, unknown> | null)?.[field];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** 会真正落地一个群内动作的工具（发消息/撤回/发贴纸/扣反应），共同受
 *  MAX_ACTIONS_PER_REPLY 的总量硬顶约束；view_sticker_pack 只是查询，
 *  不占动作名额。 */
const ACTION_TOOLS: Set<string> = new Set([SEND_MESSAGE_TOOL, DELETE_OWN_MESSAGE_TOOL, ADD_REACTION_TOOL, SEND_STICKER_TOOL]);

/** 组装一轮回复的行动工具集（贴纸菜单在此刻拉取/组装一次），见模块头注。 */
export async function createReplyToolset(ctx: ReplyToolContext): Promise<ReplyToolset> {
  const menu: StickerPackCandidate[] = await buildStickerPackMenu();
  const stickerState: StickerRoundState = createStickerRoundState();
  let messageCount: number = 0;
  let reactionCount: number = 0;
  let actionsUsed: number = 0;
  const deletableMessageIds: Set<number> = new Set();

  const viewDefinition: ToolDefinition | null = buildViewStickerPackToolDefinition(menu);
  const sendStickerDefinition: ToolDefinition | null = buildSendStickerToolDefinition(menu);
  const addReactionDefinition: ToolDefinition | null = buildAddReactionToolDefinition();
  const definitions: ToolDefinition[] = [
    buildSendMessageToolDefinition(),
    buildDeleteOwnMessageToolDefinition(),
    ...(addReactionDefinition ? [addReactionDefinition] : []),
    ...(viewDefinition ? [viewDefinition] : []),
    ...(sendStickerDefinition ? [sendStickerDefinition] : []),
  ];
  const names: Set<string> = new Set(definitions.map((d: ToolDefinition) => d.name));

  function recordSentMessage(text: string, messageId: number): void {
    messageCount++;
    deletableMessageIds.add(messageId);
    ctx.onMessageSent(text, messageId);
  }

  async function sendDirectMessage(text: string, replyToMessageId?: number): Promise<number | undefined> {
    const sentMessageId: number | undefined = await sendMessage(ctx.chatId, text, replyToMessageId);
    if (sentMessageId !== undefined) recordSentMessage(text, sentMessageId);
    return sentMessageId;
  }

  async function executeSendMessage(argumentsJson: string): Promise<string> {
    const raw: string | null = parseStringField(argumentsJson, "text");
    if (raw === null) return JSON.stringify({ error: "Invalid or empty text" });
    const text: string | null = cleanReply(raw);
    if (!text) return JSON.stringify({ error: "Invalid or empty text" });
    if (isEmojiOnly(text)) {
      return JSON.stringify({ error: "Emoji-only messages are not allowed: send a sticker (send_sticker) or react to the trigger message (add_reaction) instead" });
    }

    const rawTypoText: string | null = parseStringField(argumentsJson, "typo_text");
    const typoText: string | null = rawTypoText ? cleanReply(rawTypoText) : null;
    const typoDiff: SingleCharacterSubstitution | null = typoText ? findSingleCharacterSubstitution(text, typoText) : null;
    const effectiveTypoCorrectionText: string | null = typoDiff?.expected ?? null;
    const remainingActions: number = MAX_ACTIONS_PER_REPLY - actionsUsed;
    const shouldUseTypo: boolean =
      !!typoText &&
      typoDiff !== null &&
      !isEmojiOnly(typoText) &&
      remainingActions >= 3 &&
      Math.random() < AI_TEXT_TYPO_PROBABILITY;
    const typoMode: TypoCorrectionMode | null = shouldUseTypo ? pickTypoCorrectionMode() : null;
    const textToSend: string = shouldUseTypo ? typoText! : text;

    // 每条普通消息（含第一条与连发的后续条）临发前都拉起一段有界的「正在
    // 输入…」窗口：心跳在生成/思考期间停在 idle 挡不亮状态，群友看到的
    // 输入状态一定以一条真实消息落地收尾，不会亮了半天却等不来内容。
    // 停顿按本条长度伸缩、统一封顶（见 TYPING_DELAY_MAX_MS）；窗口可长于
    // Telegram 约 5 秒的状态过期时间，切挡时的即时补发起头（同挡位在节流
    // 窗口内刚成功发过则跳过——状态本就还亮着），其后由心跳的 4 秒 tick
    // 重发接力，整段停顿显示连续。
    ctx.chatAction.set("typing");
    await sleep(typingDelayMs(textToSend));
    // 发送前切 idle 并等在途状态请求落定：消息本身会清掉聊天状态，任何比
    // 消息晚落地的「正在输入…」都会重新盖上去白挂 5 秒。真人按下发送键时
    // 打字状态同样消失，发送 RTT 这一瞬没有状态是符合观感的。
    ctx.chatAction.set("idle");
    await ctx.chatAction.settle();
    const replyToTrigger: boolean = parseBooleanField(argumentsJson, "reply_to_trigger");
    const replyToMessageId: number | undefined = replyToTrigger ? ctx.replyToMessageId : undefined;
    const sentMessageId: number | undefined = await sendMessage(ctx.chatId, textToSend, replyToMessageId);
    if (sentMessageId === undefined) {
      // 发送失败不把挡位续回 typing：思考期本就不亮状态，模型若重试/改口，
      // 重发路径会自己开一段新窗口；若就此放弃，续上的状态只会变成一段
      // 等不来消息的遗留。
      return JSON.stringify({ error: "Failed to send message" });
    }

    let actionsUsedByTool: number = 1;
    let visibleMessageId: number = sentMessageId;
    recordSentMessage(textToSend, sentMessageId);

    if (shouldUseTypo && typoMode === "quick" && effectiveTypoCorrectionText && !isEmojiOnly(effectiveTypoCorrectionText)) {
      await sleep(randomDelayMs(TYPO_QUICK_CORRECTION_MIN_MS, TYPO_QUICK_CORRECTION_MAX_MS));
      const correctionMessageId: number | undefined = await sendDirectMessage(effectiveTypoCorrectionText);
      if (correctionMessageId !== undefined) {
        actionsUsedByTool++;
        return JSON.stringify({ success: true, message_id: visibleMessageId, actions_used: actionsUsedByTool, typo: { mode: "quick", correction_message_id: correctionMessageId } });
      }
    }

    if (shouldUseTypo && typoMode === "recall") {
      await sleep(randomDelayMs(TYPO_RECALL_DELETE_MIN_MS, TYPO_RECALL_DELETE_MAX_MS));
      const deleted: boolean = await deleteMessage(ctx.chatId, sentMessageId);
      if (deleted) {
        actionsUsedByTool++;
        deletableMessageIds.delete(sentMessageId);
        messageCount = Math.max(0, messageCount - 1);
        const correctedMessageId: number | undefined = await sendDirectMessage(text, replyToMessageId);
        if (correctedMessageId === undefined) {
          return JSON.stringify({ error: "Failed to send corrected message", actions_used: actionsUsedByTool });
        }
        actionsUsedByTool++;
        visibleMessageId = correctedMessageId;
        return JSON.stringify({ success: true, message_id: visibleMessageId, actions_used: actionsUsedByTool, typo: { mode: "recall", deleted_message_id: sentMessageId } });
      }
    }

    return JSON.stringify({ success: true, message_id: visibleMessageId, actions_used: actionsUsedByTool, ...(shouldUseTypo ? { typo: { mode: "ignore" } } : {}) });
  }

  async function executeDeleteOwnMessage(argumentsJson: string): Promise<string> {
    const messageId: number | null = parsePositiveIntegerField(argumentsJson, "message_id");
    if (messageId === null) return JSON.stringify({ error: "Invalid message_id" });
    if (!deletableMessageIds.has(messageId)) {
      return JSON.stringify({ error: "Message is not deletable in this reply: only message_id values returned by this round's send_message can be deleted" });
    }
    await sleep(randomDelayMs(TYPO_RECALL_DELETE_MIN_MS, TYPO_RECALL_DELETE_MAX_MS));
    const deleted: boolean = await deleteMessage(ctx.chatId, messageId);
    if (!deleted) return JSON.stringify({ error: "Failed to delete message" });
    deletableMessageIds.delete(messageId);
    messageCount = Math.max(0, messageCount - 1);
    return JSON.stringify({ success: true });
  }

  function executeAddReaction(argumentsJson: string): string {
    const emoji: string | null = parseStringField(argumentsJson, "emoji");
    if (emoji === null || !REACTION_EMOJIS.includes(emoji)) return JSON.stringify({ error: "Invalid reaction emoji: pick one from the list" });
    if (reactionCount >= MAX_REACTIONS_PER_REPLY) {
      return JSON.stringify({ error: `Reaction limit reached: at most ${MAX_REACTIONS_PER_REPLY} reaction per reply` });
    }
    reactionCount++;
    // setMessageReaction 内部兜住一切异常（失败已记日志），fire-and-forget。
    void setMessageReaction(ctx.chatId, ctx.replyToMessageId, emoji);
    return JSON.stringify({ success: true });
  }

  async function dispatch(name: string, argumentsJson: string): Promise<string> {
    switch (name) {
      case SEND_MESSAGE_TOOL:
        return executeSendMessage(argumentsJson);
      case DELETE_OWN_MESSAGE_TOOL:
        return executeDeleteOwnMessage(argumentsJson);
      case ADD_REACTION_TOOL:
        return executeAddReaction(argumentsJson);
      case VIEW_STICKER_PACK_TOOL:
        return viewStickerPackTool(ctx.chatAction, menu, argumentsJson, stickerState);
      case SEND_STICKER_TOOL:
        // 贴纸发送前的切 idle + settle 在 sendStickerTool 内部做（要卡在参数
        // 校验通过之后、真正发网络请求之前，道理同 executeSendMessage）；
        // 同群并发轮的发贴纸互斥锁（ctx.stickerLock）也在里面抢。
        return sendStickerTool(ctx.chatAction, ctx.stickerLock, ctx.chatId, menu, argumentsJson, stickerState, ctx.onStickerSent);
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  return {
    definitions,
    has: (name: string): boolean => names.has(name),
    execute: async (name: string, argumentsJson: string): Promise<string> => {
      // 动作总量硬顶在入口统一把关（成功才计数——被参数校验/分项限额拒绝
      // 或发送失败的调用不白白烧名额），view_sticker_pack 等查询不受限。
      if (ACTION_TOOLS.has(name) && actionsUsed >= MAX_ACTIONS_PER_REPLY) {
        return JSON.stringify({ error: `Action limit reached: at most ${MAX_ACTIONS_PER_REPLY} actions (messages + deletes + stickers + reactions) per reply` });
      }
      const result: string = await dispatch(name, argumentsJson);
      if (ACTION_TOOLS.has(name)) {
        try {
          const parsed = JSON.parse(result) as { success?: boolean; actions_used?: unknown };
          if (typeof parsed.actions_used === "number" && Number.isFinite(parsed.actions_used) && parsed.actions_used > 0) {
            actionsUsed += Math.floor(parsed.actions_used);
          } else if (parsed.success) {
            actionsUsed++;
          }
        } catch {
          // 工具结果都是本模块自己拼的 JSON，解析不会失败；防御性兜底。
        }
      }
      return result;
    },
    messagesSent: (): number => messageCount,
  };
}
