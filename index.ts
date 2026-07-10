import { bot } from "./src/telegram";
import { acquireSingleInstanceLock, loadState, loadUsersFile, saveState } from "./src/storage";
import { handleCopyCommand, handleIncomingMessage, handleKickCommand, handleReaction, handleStopCommand } from "./src/handlers";
import { handleChatMemberUpdate } from "./src/joinVerification";
import type { BotState, CachedUser, UsersFileSchema } from "./src/types";

/**
 * 注册各类更新处理器，并启动 grammY 的长轮询循环。
 */
async function main(): Promise<void> {
  await acquireSingleInstanceLock();

  const usersData: UsersFileSchema = await loadUsersFile();
  const state: BotState = await loadState();

  // 恢复内存中的临时 users 缓存，仅包含目前正在被 copy 的用户/频道
  const users: Record<string, CachedUser> = {};
  if (usersData.copiedUser && usersData.copiedUser.username) {
    users[usersData.copiedUser.username.toLowerCase()] = usersData.copiedUser;
  }

  // 同步状态，以防 state.json 损坏或不一致。
  // 注意：lastCopiedUserId 不能从 usersData 派生——users.json 的 copiedUser 在
  // /stop 后就是 null，若照抄会把冷却计时的目标 ID 冲掉（/stop 后 copiedUser
  // 变 null 但冷却本该继续针对上一个目标生效），冷却机制就在下次重启后失效了。
  // state.json 里的 lastCopiedUserId 由 loadState() 读入即可，无需在这里覆盖。
  state.lastCopyTime = usersData.lastCopyTime;
  if (usersData.copiedUser) {
    state.copiedUserId = usersData.copiedUser.id;
    state.copiedIsChannel = !!usersData.copiedUser.isChannel;
  } else {
    state.copiedUserId = null;
    state.isCopying = false;
    state.copiedIsChannel = false;
    state.copyMode = undefined;
  }
  await saveState(state);

  // 命令处理器要注册在通用消息处理器之前：匹配到命令时 grammY 不会再往下传给它。
  bot.command("copy", (ctx) => handleCopyCommand(ctx, users, state));
  bot.command("r_copy", (ctx) => handleCopyCommand(ctx, users, state, "reverse"));
  bot.command("nya_copy", (ctx) => handleCopyCommand(ctx, users, state, "nya"));
  bot.command("ja_copy", (ctx) => handleCopyCommand(ctx, users, state, "ja"));
  bot.command("stop", (ctx) => handleStopCommand(ctx, state));
  bot.command("kick", (ctx) => handleKickCommand(ctx));
  bot.on(["message", "channel_post"], (ctx) => handleIncomingMessage(ctx, users, state));
  bot.on("message_reaction", (ctx) => handleReaction(ctx, state));
  bot.on("chat_member", (ctx) => handleChatMemberUpdate(ctx));

  bot.catch((err) => {
    console.error(`Unhandled error while handling update ${err.ctx.update.update_id}:`, err.error);
  });

  const stopBot = (): void => {
    void bot.stop();
  };
  process.once("SIGINT", stopBot);
  process.once("SIGTERM", stopBot);

  // message_reaction / chat_member 默认不在 Telegram 的隐式更新集合里，必须显式
  // 声明才能收到；一旦显式声明，就必须把 message/channel_post 也列进来，否则
  // 它们反而会被排除。chat_member 是入群验证功能能收到"谁加入了群"的关键——
  // 群里如果开了"隐藏加入/离开提示"，new_chat_members 服务消息根本不会产生，
  // 只有 chat_member 这个更新类型不受影响，始终会推送。
  await bot.start({
    allowed_updates: ["message", "channel_post", "message_reaction", "chat_member"],
    onStart: (botInfo) => {
      console.log(
        `Bot started as @${botInfo.username}. ` +
        `isCopying=${state.isCopying} copiedUserId=${state.copiedUserId} copiedIsChannel=${!!state.copiedIsChannel}`
      );
    },
  });
}

main().catch((err: unknown) => {
  console.error("Unhandled error in bot main runner:", err);
});
