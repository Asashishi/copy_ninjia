import { GrammyError, type Bot } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { handleIncomingMessage, handleReaction } from "../auto";
import {
  confirmLuckDraw,
  handleAiChatCommand,
  handleCjkActionCommand,
  handleCopyCommand,
  handleInitCommand,
  handleJaCopyCommand,
  handleKickCommand,
  handleLuckChallengeInlineQuery,
  handleLuckChosenInlineResult,
  handleQuietCommand,
  handleSendCommand,
  handleStealIconCommand,
  handleStopCommand,
  handleSwitchMoodCommand,
  handleUnquietCommand,
} from "../commands";
import {
  handleChatMemberUpdate,
  handleGroupJoinVerification,
  handleVerificationCallback,
} from "../antiRaid";
import { handleMyChatMemberUpdate } from "../infra/botAdmin";
import { CJK_ACTION_COMMAND_PATTERN } from "../consts/commands";
import { logger } from "../infra/logger";
import {
  shouldPassInitGate,
  shouldPassPrivateCommandGate,
  shouldRoutePrivateProxyMessage,
} from "../infra/updateGate";

export interface HandlerRegistration {
  getLastSeenUpdateId(): number;
}

/**
 * 显式安装完整的 grammY 更新链。模块导入本身不修改 Bot；调用一次本函数才
 * 注册 middleware、命令和各类 update handler。
 */
export function registerHandlers(bot: Bot): HandlerRegistration {
  let lastSeenUpdateId: number = 0;

  // 追踪已进入处理的最大 update_id，停机时用于确认 Telegram offset。
  bot.use((ctx, next) => {
    if (ctx.update.update_id > lastSeenUpdateId) lastSeenUpdateId = ctx.update.update_id;
    return next();
  });

  // 运势签名回执是 chosen_inline_result 之外的确认路径。转发副本也有效，
  // 因此必须在 isInit 网关前检查。
  bot.use(async (ctx, next) => {
    await confirmLuckDraw(ctx.msg?.text, ctx.msg?.entities);
    return next();
  });

  // 未初始化群在最前端终止，避免继续进入串行队列、验证、命令与 AI 链路。
  bot.use((ctx, next) => (shouldPassInitGate(ctx) ? next() : undefined));

  // 普通聊天按 chat 串行；反应同步有自己的合并队列，不占用聊天车道。
  bot.use(sequentialize((ctx) => (ctx.messageReaction ? [] : ctx.chat ? [String(ctx.chat.id)] : [])));

  // 私聊只放行 /send 入口和活动中的中转会话。中转消息在命令注册之前直接
  // 短路到消息流水线，避免 /copy 等文本被当成真实命令执行。
  bot.use((ctx, next) => {
    if (!shouldPassPrivateCommandGate(ctx)) return undefined;
    if (shouldRoutePrivateProxyMessage(ctx)) return handleIncomingMessage(ctx);
    return next();
  });

  // 入群验证必须早于命令处理器，否则待验证用户发出的命令不会被追踪清理。
  bot.on("message", async (ctx, next) => {
    if (await handleGroupJoinVerification(ctx.message, ctx.me.id)) return;
    return next();
  });

  bot.command("copy", (ctx) => handleCopyCommand(ctx));
  bot.command("r_copy", (ctx) => handleCopyCommand(ctx, "reverse"));
  bot.command("nya_copy", (ctx) => handleCopyCommand(ctx, "nya"));
  bot.command("ja_copy", (ctx) => handleJaCopyCommand(ctx));
  bot.command("steal_icon", (ctx) => handleStealIconCommand(ctx));
  bot.command("stop_copy", (ctx) => handleStopCommand(ctx));
  bot.command("kick", (ctx) => handleKickCommand(ctx));
  bot.command("ai_chat", (ctx) => handleAiChatCommand(ctx));
  bot.command("switch_mood", (ctx) => handleSwitchMoodCommand(ctx));
  bot.command("init", (ctx) => handleInitCommand(ctx));
  bot.command("quiet", (ctx) => handleQuietCommand(ctx));
  bot.command("unquiet", (ctx) => handleUnquietCommand(ctx));
  bot.command("send", (ctx) => handleSendCommand(ctx));
  // 菜单占位项，故意不做任何处理：它只为在命令菜单里曝光「/<单个中文字>」这个
  // 用法（那类命令名注册不进菜单，见 consts/commands.ts）。但必须注册成一个
  // 空 handler 并就此终止链路——点菜单会真的把 /x 发出去，不拦住的话它会落到
  // 下面的消息兜底，被当成普通消息进入 AI/复读流水线。
  bot.command("x", () => undefined);
  // `/咬` 这类单字中文动作命令拿不到 Telegram 的 bot_command 实体，bot.command
  // 匹配不到，只能按消息原文 hears。必须排在消息兜底处理器之前，否则会被当成
  // 普通消息进入 AI/复读流水线；不认领的形态由 handler 自己 next() 放行。
  bot.hears(CJK_ACTION_COMMAND_PATTERN, (ctx, next) => handleCjkActionCommand(ctx, next));
  bot.on(["message", "channel_post"], (ctx) => handleIncomingMessage(ctx));
  bot.on("message_reaction", (ctx) => handleReaction(ctx));
  bot.on("chat_member", (ctx) => handleChatMemberUpdate(ctx));
  bot.on("my_chat_member", (ctx) => handleMyChatMemberUpdate(ctx));
  bot.on("callback_query:data", (ctx) => handleVerificationCallback(ctx));
  bot.on("inline_query", (ctx) => handleLuckChallengeInlineQuery(ctx));
  bot.on("chosen_inline_result", (ctx) => handleLuckChosenInlineResult(ctx));

  bot.catch((err) => {
    // GrammyError 携带完整请求 payload；这里只记录状态码和描述，避免日志泄漏
    // 可能嵌在 URL 或 inline result 中的 BOT_TOKEN。
    if (err.error instanceof GrammyError) {
      logger.error(
        `Unhandled error while handling update ${err.ctx.update.update_id}: ` +
        `${err.error.error_code} ${err.error.description}`
      );
    } else {
      logger.error(`Unhandled error while handling update ${err.ctx.update.update_id}:`, err.error);
    }
    // 记录后必须继续向 acknowledged runner 传播。吞掉异常会让 bot.handleUpdate
    // resolve，下一次 getUpdates 随即确认本次失败（包括 durability barrier
    // 失败）的 update，进程重启后 Telegram 也不会重投。
    throw err.error;
  });

  return { getLastSeenUpdateId: (): number => lastSeenUpdateId };
}
