import type { FunctionDeclaration, Tool } from "@google/genai";
import { logger } from "../../infra/logger";
import { deleteMessage, sendMessage, setMessageReaction } from "../../infra/telegram";
import { sleep } from "../../libs/sleep";
import { TOOL_DEFINITIONS } from "./index";
import {
  MAX_ACTIONS_PER_REPLY,
  MAX_REACTIONS_PER_REPLY,
  TYPO_QUICK_CORRECTION_MAX_MS,
  TYPO_QUICK_CORRECTION_MIN_MS,
  TYPO_RECALL_DELETE_MAX_MS,
  TYPO_RECALL_DELETE_MIN_MS,
} from "../../consts/aiChat";
import {
  ADD_REACTION_TOOL_INSTRUCTION,
  DELETE_OWN_MESSAGE_TOOL_INSTRUCTION,
  SEND_MESSAGE_TOOL_INSTRUCTION,
  TYPO_SUBSTITUTION_RULE,
} from "../../consts/aiChatPrompts";
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
import { cleanReply, isEmojiOnly } from "../utils/replyText";
import { buildCharacterTypo, pickTypoCorrectionMode, type CharacterTypo, type TypoCorrectionMode } from "../utils/typo";
import { randomDelayMs, typingDelayMs } from "../utils/timing";
import { parseBooleanField, parsePositiveIntegerField, parseStringField } from "../utils/toolArgs";
import type { ReplyToolContext, ReplyToolset, StickerPackCandidate, StickerRoundState, ToolDefinition } from "../../types";

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
 * send_message 的参数 schema 按本轮是否抽中「出错」分支（ctx.roundHasTypo，
 * 见 consts/aiChat.ts 的 AI_TEXT_TYPO_PROBABILITY）动态组装：只有出错分支
 * 才暴露 typo_original_char/typo_replacement_char——不出错的轮次里模型的
 * 可用参数里根本不存在这两个字段，不必靠文字指令去说服模型「别用」。
 * 模型只需要给两个孤立单字（原字 + 错字），执行侧自己在 text 里做替换
 * 构造出错字版本（见下方 buildCharacterTypo）——不问模型重新打一遍整句话，
 * 避免长句子复现走样导致的误判失败。
 */
function buildSendMessageToolDefinition(roundHasTypo: boolean): ToolDefinition {
  const properties: Record<string, unknown> = {
    text: { type: "string", description: "要发到群里的消息文本。" },
    reply_to_trigger: { type: "boolean", description: "是否以「回复」形式挂在触发你这次回复的那条消息上；省略视为 false。" },
  };
  const required: string[] = ["text"];
  if (roundHasTypo) {
    properties.typo_original_char = {
      type: "string",
      description:
        "本轮每次调用都必须提供：从 text 里原样抄一个已有字，只写这一个字（不要多写、不要写整句话）。" +
        "如果不想在这条消息上出错，就随便填 text 里的一个字，并让 typo_replacement_char 填成一模一样的字（会被安全" +
        "忽略，不会产生错字）。",
    };
    properties.typo_replacement_char = {
      type: "string",
      description: `typo_original_char 要被换成的那个错字，只写这一个字，不要写整句话。${TYPO_SUBSTITUTION_RULE}`,
    };
    // 标成 required 而非仅在文案里要求：optional 字段模型经常直接跳过，
    // 靠自然语言指令单方面「保证」出错，实测并不可靠。这里用 schema
    // 硬约束换取真正的强制——不想出错的消息就把两个字段填成同一个字，
    // buildCharacterTypo 会因为两字相同而安全拒绝，不会误伤。
    required.push("typo_original_char", "typo_replacement_char");
  }
  return {
    name: SEND_MESSAGE_TOOL,
    description: SEND_MESSAGE_TOOL_INSTRUCTION,
    parameters: {
      type: "object",
      properties,
      required,
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
  // 本轮出错分支最多吃掉一次手滑错字：即使模型在同一轮多条 send_message
  // 里都附带了原字/错字候选，第一次有效的候选之后就不再采纳，避免一轮
  // 回复里出现两次「打错-纠正」。
  let typoUsedThisRound: boolean = false;
  const deletableMessageIds: Set<number> = new Set();
  // 本轮仍可见消息的「本意文本」（messageId -> 模型给的正确原文；错字轮记
  // 的是掺错字之前的 text，快速补字的纠正消息记它自己的单字）：send_message
  // 靠它拒绝与已发消息内容完全相同的重复调用——错字自动纠正/重发之后模型
  // 再把同一句话发一遍，群里就是肉眼可见的复读。撤回（错字撤回重发的执行
  // 侧删除、或模型主动 delete_own_message）会移除对应条目：撤回后重发同一
  // 句话是合法的「撤回重发」，不算重复。
  const sentCanonicalTexts: Map<number, string> = new Map();
  // 已预约、尚未发出的快速补字纠正字：预约即占进判重，堵住「纠正还没落地、
  // 模型自己先把那个字发了」的空窗；纠正真正发出后转入 sentCanonicalTexts。
  let pendingCorrectionText: string | null = null;

  function isDuplicateOfSentMessage(text: string): boolean {
    if (pendingCorrectionText === text) return true;
    for (const sentText of sentCanonicalTexts.values()) {
      if (sentText === text) return true;
    }
    return false;
  }

  const viewDefinition: ToolDefinition | null = buildViewStickerPackToolDefinition(menu);
  const sendStickerDefinition: ToolDefinition | null = buildSendStickerToolDefinition(menu);
  const addReactionDefinition: ToolDefinition | null = buildAddReactionToolDefinition();
  const definitions: ToolDefinition[] = [
    buildSendMessageToolDefinition(ctx.roundHasTypo),
    buildDeleteOwnMessageToolDefinition(),
    ...(addReactionDefinition ? [addReactionDefinition] : []),
    ...(viewDefinition ? [viewDefinition] : []),
    ...(sendStickerDefinition ? [sendStickerDefinition] : []),
  ];
  const names: Set<string> = new Set(definitions.map((d: ToolDefinition) => d.name));

  // googleSearch 必须真实注册进 SDK tools，单靠提示词提到工具名并不会让
  // 模型获得搜索能力。它与函数声明混用时 callGemini 会开启服务端工具记录。
  const sdkDeclarations: FunctionDeclaration[] = [...TOOL_DEFINITIONS, ...definitions].map((definition: ToolDefinition) => ({
    name: definition.name,
    description: definition.description,
    parametersJsonSchema: definition.parameters,
  }));
  const tools: Tool[] = [{ googleSearch: {} }, { functionDeclarations: sdkDeclarations }];

  function recordSentMessage(text: string, messageId: number): void {
    messageCount++;
    deletableMessageIds.add(messageId);
    ctx.onMessageSent(text, messageId);
  }

  async function sendDirectMessage(text: string, replyToMessageId?: number, allowInactive: boolean = false): Promise<number | undefined> {
    if (!allowInactive && !ctx.isActive()) return undefined;
    const sentMessageId: number | undefined = await sendMessage(ctx.chatId, text, replyToMessageId);
    if (sentMessageId !== undefined) recordSentMessage(text, sentMessageId);
    return sentMessageId;
  }

  async function executeSendMessage(argumentsJson: string): Promise<string> {
    if (!ctx.isActive()) return JSON.stringify({ error: "Reply invalidated because AI chat was disabled" });
    const raw: string | null = parseStringField(argumentsJson, "text");
    if (raw === null) return JSON.stringify({ error: "Invalid or empty text" });
    const text: string | null = cleanReply(raw);
    if (!text) return JSON.stringify({ error: "Invalid or empty text" });
    if (isEmojiOnly(text)) {
      return JSON.stringify({ error: "Emoji-only messages are not allowed: send a sticker (send_sticker) or react to the trigger message (add_reaction) instead" });
    }
    if (isDuplicateOfSentMessage(text)) {
      return JSON.stringify({ error: "An identical message was already sent in this round; do not repeat yourself. Say something new, or use add_reaction / send_sticker instead" });
    }

    // 只问模型要两个孤立单字（原字 + 错字），执行侧自己在 text 里做替换
    // 构造出错字版本（见 buildCharacterTypo 模块头注：不再要求模型重新
    // 打一遍整句话去 diff，避免长句复现走样导致的误判失败）。
    const rawOriginalChar: string | null = parseStringField(argumentsJson, "typo_original_char");
    const rawReplacementChar: string | null = parseStringField(argumentsJson, "typo_replacement_char");
    const originalChar: string | null = rawOriginalChar ? rawOriginalChar.trim() : null;
    const replacementChar: string | null = rawReplacementChar ? rawReplacementChar.trim() : null;
    const characterTypo: CharacterTypo | null =
      originalChar && replacementChar ? buildCharacterTypo(text, originalChar, replacementChar) : null;
    const typoText: string | null = characterTypo?.typoText ?? null;
    const effectiveTypoCorrectionText: string | null = characterTypo?.expected ?? null;
    const remainingActions: number = MAX_ACTIONS_PER_REPLY - actionsUsed;
    // 出错与否在本轮开始前已经掷过骰子（ctx.roundHasTypo，见
    // consts/aiChat.ts 的 AI_TEXT_TYPO_PROBABILITY），这里不再二次抽签；
    // typoAlreadyUsed 拍下本次判定之前的状态（供下面拒绝原因诊断用），
    // typoUsedThisRound 保证即使 schema 允许、模型在同一轮多条消息里都带
    // 了候选，也只采纳第一个合法候选。
    const typoAlreadyUsed: boolean = typoUsedThisRound;
    const shouldUseTypo: boolean =
      ctx.roundHasTypo &&
      !typoAlreadyUsed &&
      characterTypo !== null &&
      !isEmojiOnly(typoText!) &&
      remainingActions >= 3;
    if (shouldUseTypo) typoUsedThisRound = true;
    // 诊断信号：本轮要求出错、模型也确实提交了一对不同的原字/错字
    // （两字相同是模型主动选择「这条不出错」，不算尝试失败），但因为某种
    // 原因没被采纳时，把原因喂回模型——旧版这里完全静默成功，模型不知道
    // 自己的候选被判定无效，也就无从在同一轮的下一条消息里改正，这是
    // 「概率拉满仍然不稳定出错」的一个重要成因。
    const typoAttempted: boolean = ctx.roundHasTypo && !!originalChar && !!replacementChar && originalChar !== replacementChar;
    const typoRejectedReason: string | null =
      typoAttempted && !shouldUseTypo
        ? typoAlreadyUsed
          ? "already used the one allowed typo this round; this message will send as-is"
          : characterTypo === null
          ? "typo_original_char/typo_replacement_char were rejected: each must be exactly one character, differ from each other, not be emoji, and typo_original_char must actually appear in text"
          : isEmojiOnly(typoText!)
          ? "typo candidate was rejected: the resulting message would be emoji-only"
          : "typo candidate was rejected: not enough remaining action budget this round"
        : null;
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
    if (!ctx.isActive()) return JSON.stringify({ error: "Reply invalidated because AI chat was disabled" });
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
    const visibleMessageId: number = sentMessageId;
    recordSentMessage(textToSend, sentMessageId);
    sentCanonicalTexts.set(sentMessageId, text);

    // 错字纠正不阻塞本轮：真人手滑后会继续打后面的话，过几秒才回头补救，
    // 纠正因此经常落在自己后续消息之后。这里只预约（预扣动作额度 + 占进
    // 判重）并立刻返回，让模型的下一个动作先走；延迟发送在后台执行。
    if (shouldUseTypo && typoMode === "quick" && effectiveTypoCorrectionText && !isEmojiOnly(effectiveTypoCorrectionText)) {
      const correctionText: string = effectiveTypoCorrectionText;
      actionsUsedByTool++;
      pendingCorrectionText = correctionText;
      void (async (): Promise<void> => {
        await sleep(randomDelayMs(TYPO_QUICK_CORRECTION_MIN_MS, TYPO_QUICK_CORRECTION_MAX_MS));
        const correctionMessageId: number | undefined = await sendDirectMessage(correctionText, undefined, true);
        if (correctionMessageId !== undefined) sentCanonicalTexts.set(correctionMessageId, correctionText);
        if (pendingCorrectionText === correctionText) pendingCorrectionText = null;
      })().catch((error: unknown) => {
        logger.error("Error while applying scheduled quick typo correction:", error);
      });
      return JSON.stringify({ success: true, message_id: visibleMessageId, actions_used: actionsUsedByTool, typo: { mode: "quick", correction: "scheduled" } });
    }

    if (shouldUseTypo && typoMode === "recall") {
      // 判重条目保持连续：旧条目等重发消息落地后才移除，删除与重发之间的
      // 空窗里模型重发同一句话仍会被拒绝。模型若赶在预约生效前自己撤回了
      // 这条消息，这里的 deleteMessage 会失败、重发随之跳过——不会把模型
      // 刚决定撤掉的内容又发回去。
      actionsUsedByTool += 2;
      void (async (): Promise<void> => {
        await sleep(randomDelayMs(TYPO_RECALL_DELETE_MIN_MS, TYPO_RECALL_DELETE_MAX_MS));
        const deleted: boolean = await deleteMessage(ctx.chatId, sentMessageId);
        if (!deleted) return;
        deletableMessageIds.delete(sentMessageId);
        messageCount = Math.max(0, messageCount - 1);
        const correctedMessageId: number | undefined = await sendDirectMessage(text, replyToMessageId, true);
        if (correctedMessageId !== undefined) sentCanonicalTexts.set(correctedMessageId, text);
        sentCanonicalTexts.delete(sentMessageId);
      })().catch((error: unknown) => {
        logger.error("Error while applying scheduled typo recall correction:", error);
      });
      return JSON.stringify({ success: true, message_id: visibleMessageId, actions_used: actionsUsedByTool, typo: { mode: "recall", correction: "scheduled" } });
    }

    return JSON.stringify({
      success: true,
      message_id: visibleMessageId,
      actions_used: actionsUsedByTool,
      ...(shouldUseTypo ? { typo: { mode: "ignore" } } : {}),
      ...(typoRejectedReason ? { typo_rejected: typoRejectedReason } : {}),
    });
  }

  async function executeDeleteOwnMessage(argumentsJson: string): Promise<string> {
    const messageId: number | null = parsePositiveIntegerField(argumentsJson, "message_id");
    if (messageId === null) return JSON.stringify({ error: "Invalid message_id" });
    if (!deletableMessageIds.has(messageId)) {
      return JSON.stringify({ error: "Message is not deletable in this reply: only message_id values returned by this round's send_message can be deleted" });
    }
    await sleep(randomDelayMs(TYPO_RECALL_DELETE_MIN_MS, TYPO_RECALL_DELETE_MAX_MS));
    if (!ctx.isActive()) return JSON.stringify({ error: "Reply invalidated because AI chat was disabled" });
    const deleted: boolean = await deleteMessage(ctx.chatId, messageId);
    if (!deleted) return JSON.stringify({ error: "Failed to delete message" });
    deletableMessageIds.delete(messageId);
    sentCanonicalTexts.delete(messageId);
    messageCount = Math.max(0, messageCount - 1);
    return JSON.stringify({ success: true });
  }

  function executeAddReaction(argumentsJson: string): string {
    if (!ctx.isActive()) return JSON.stringify({ error: "Reply invalidated because AI chat was disabled" });
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
        return sendStickerTool(ctx.chatAction, ctx.stickerLock, ctx.chatId, menu, argumentsJson, stickerState, ctx.onStickerSent, ctx.isActive);
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  return {
    definitions,
    tools,
    has: (name: string): boolean => names.has(name),
    execute: async (name: string, argumentsJson: string): Promise<string> => {
      if (!ctx.isActive()) return JSON.stringify({ error: "Reply invalidated because AI chat was disabled" });
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
    actionsUsed: (): number => actionsUsed,
    isActive: ctx.isActive,
  };
}
