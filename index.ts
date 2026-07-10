import { bot } from "./src/telegram";
import { acquireSingleInstanceLock, getOrCreateChatState, loadState, loadUsersFile, saveState } from "./src/storage";
import { handleCopyCommand, handleIncomingMessage, handleKickCommand, handleReaction, handleStopCommand } from "./src/handlers";
import { handleChatMemberUpdate } from "./src/joinVerification";
import type { CachedUser, ChatState, UsersFileSchema } from "./src/types";

/**
 * 注册各类更新处理器，并启动 grammY 的长轮询循环。
 */
async function main(): Promise<void> {
  await acquireSingleInstanceLock();

  // 机器人可能同时在多个群里运行，每个群各自独立的复制状态存在
  // Map<chatId, ChatState> 里，互不影响。
  const usersData: UsersFileSchema = await loadUsersFile();
  const chatStates: Map<number, ChatState> = await loadState();

  // 恢复内存中的临时 users 缓存，包含所有群里目前正在被 copy 的用户/频道
  const users: Record<string, CachedUser> = {};
  for (const entry of Object.values(usersData)) {
    if (entry.copiedUser && entry.copiedUser.username) {
      users[entry.copiedUser.username.toLowerCase()] = entry.copiedUser;
    }
  }

  // 逐个群聊同步状态，以防 state.json 损坏或与 users.json 不一致。
  // 注意：lastCopiedUserId 不能从 usersData 派生——users.json 的 copiedUser 在
  // /stop 后就是 null，若照抄会把冷却计时的目标 ID 冲掉（/stop 后 copiedUser
  // 变 null 但冷却本该继续针对上一个目标生效），冷却机制就在下次重启后失效了。
  // state.json 里的 lastCopiedUserId 由 loadState() 读入即可，无需在这里覆盖。
  for (const [chatIdStr, entry] of Object.entries(usersData)) {
    const chatId: number = Number(chatIdStr);
    const state: ChatState = getOrCreateChatState(chatStates, chatId);
    state.lastCopyTime = entry.lastCopyTime;
    if (entry.copiedUser) {
      state.copiedUserId = entry.copiedUser.id;
      state.copiedIsChannel = !!entry.copiedUser.isChannel;
    } else {
      state.copiedUserId = null;
      state.isCopying = false;
      state.copiedIsChannel = false;
      state.copyMode = undefined;
    }
  }
  await saveState(chatStates);

  // 命令处理器要注册在通用消息处理器之前：匹配到命令时 grammY 不会再往下传给它。
  bot.command("copy", (ctx) => handleCopyCommand(ctx, users, chatStates, usersData));
  bot.command("r_copy", (ctx) => handleCopyCommand(ctx, users, chatStates, usersData, "reverse"));
  bot.command("nya_copy", (ctx) => handleCopyCommand(ctx, users, chatStates, usersData, "nya"));
  bot.command("ja_copy", (ctx) => handleCopyCommand(ctx, users, chatStates, usersData, "ja"));
  bot.command("stop", (ctx) => handleStopCommand(ctx, chatStates, usersData));
  bot.command("kick", (ctx) => handleKickCommand(ctx));
  bot.on(["message", "channel_post"], (ctx) => handleIncomingMessage(ctx, users, chatStates));
  bot.on("message_reaction", (ctx) => handleReaction(ctx, chatStates));
  bot.on("chat_member", (ctx) => handleChatMemberUpdate(ctx));

  bot.catch((err) => {
    console.error(`Unhandled error while handling update ${err.ctx.update.update_id}:`, err.error);
  });

  // 向 Telegram 注册命令列表，让聊天框输入 / 时弹出命令菜单。默认作用域即可
  // 覆盖群聊和私聊；注册失败不影响命令本身工作（只是没有菜单提示），所以
  // 不让它阻断启动。
  try {
    await bot.api.setMyCommands([
      { command: "copy", description: "复制某人：/copy @username 或回复 TA 的消息" },
      { command: "r_copy", description: "复制并反转复读的文字" },
      { command: "nya_copy", description: "复制并在复读末尾加上喵~" },
      { command: "ja_copy", description: "复制并把复读翻译成日语" },
      { command: "stop", description: "停止当前的复制" },
      { command: "kick", description: "回复某人的消息将 TA 踢出并封禁（仅主人可用）" },
    ]);
  } catch (error: unknown) {
    console.error("Failed to register bot commands menu:", error);
  }

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
      const copyingChats: number = Array.from(chatStates.values()).filter((s) => s.isCopying).length;
      console.log(
        `Bot started as @${botInfo.username}. ` +
        `Restored state for ${chatStates.size} chat(s), ${copyingChats} currently copying.`
      );
    },
  });
}

main().catch((err: unknown) => {
  console.error("Unhandled error in bot main runner:", err);
});
