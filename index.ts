import { flushLogs, logger } from "./src/logger";
import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import { bot } from "./src/telegram";
import { acquireSingleInstanceLock, getOrCreateChatState, loadState, loadUsersFile, saveState } from "./src/storage";
import { handleBalanceCommand, handleCopyCommand, handleIncomingMessage, handleKickCommand, handleQuietCommand, handleReaction, handleStopCommand, handleUnquietCommand } from "./src/handlers";
import { handleChatMemberUpdate, handleVerificationCallback } from "./src/joinVerification";
import { initAiChat } from "./src/aiChat";
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

  // 追踪已进入处理的最大 update_id。内建 bot.stop() 停机时会用它向 Telegram
  // 做一次空 getUpdates 确认 offset，而 runner.stop() 只中止拉取、不做确认——
  // 不补上的话，每次重启都会把停机前最后一批已处理的更新重放一遍（重复复读、
  // 重复回复）。确认动作在 main 末尾、runner 完全停止后执行。
  let lastSeenUpdateId: number = 0;
  bot.use((ctx, next) => {
    if (ctx.update.update_id > lastSeenUpdateId) {
      lastSeenUpdateId = ctx.update.update_id;
    }
    return next();
  });

  // runner 会并发处理更新，必须用 sequentialize 约束顺序：消息/命令/成员变动
  // 按 chat 串行——复读消息的先后顺序、入群验证对每个群状态的修改都依赖这一点。
  // message_reaction 更新则不排队（返回空约束）：反应同步走 reactionQueue 自己
  // 的串行队列，且同一条消息的多次变化会合并成最新状态，天然不怕并发；让它
  // 绕开 chat 车道，目标刷屏被复读（ja 模式还要过一次翻译）时反应同步才不会
  // 跟着排队变慢。
  bot.use(sequentialize((ctx) => {
    if (ctx.messageReaction) return [];
    return ctx.chat ? [String(ctx.chat.id)] : [];
  }));

  // 私聊里不触发任何命令（/copy 系、/stop /kick /balance /quiet 等全部）：这些
  // 指令都是围绕群聊状态设计的（复读目标、群内踢人、群内静默），私聊语境下
  // 没有意义，也免得被人在 DM 里瞎捣鼓。放在命令处理器注册之前，直接吞掉
  // 这类更新，不再往下传给任何处理器。
  bot.use((ctx, next) => {
    if (ctx.chat?.type === "private" && ctx.message?.text?.startsWith("/")) {
      return;
    }
    return next();
  });

  // 命令处理器要注册在通用消息处理器之前：匹配到命令时 grammY 不会再往下传给它。
  bot.command("copy", (ctx) => handleCopyCommand(ctx, users, chatStates, usersData));
  bot.command("r_copy", (ctx) => handleCopyCommand(ctx, users, chatStates, usersData, "reverse"));
  bot.command("nya_copy", (ctx) => handleCopyCommand(ctx, users, chatStates, usersData, "nya"));
  bot.command("ja_copy", (ctx) => handleCopyCommand(ctx, users, chatStates, usersData, "ja"));
  bot.command("stop", (ctx) => handleStopCommand(ctx, chatStates, usersData));
  bot.command("kick", (ctx) => handleKickCommand(ctx, users));
  bot.command("balance", (ctx) => handleBalanceCommand(ctx));
  bot.command("quiet", (ctx) => handleQuietCommand(ctx, chatStates));
  bot.command("unquiet", (ctx) => handleUnquietCommand(ctx, chatStates));
  bot.on(["message", "channel_post"], (ctx) => handleIncomingMessage(ctx, users, chatStates));
  bot.on("message_reaction", (ctx) => handleReaction(ctx, chatStates));
  bot.on("chat_member", (ctx) => handleChatMemberUpdate(ctx));
  bot.on("callback_query:data", (ctx) => handleVerificationCallback(ctx));

  bot.catch((err) => {
    logger.error(`Unhandled error while handling update ${err.ctx.update.update_id}:`, err.error);
  });

  // 向 Telegram 注册命令列表，让聊天框输入 / 时弹出命令菜单。默认作用域即可
  // 覆盖群聊和私聊；注册失败不影响命令本身工作（只是没有菜单提示），所以
  // 不让它阻断启动。
  try {
    await bot.api.setMyCommands([
      { command: "copy", description: "复读" },
      { command: "r_copy", description: "复读并反转文本" },
      { command: "nya_copy", description: "复读并加喵~" },
      { command: "ja_copy", description: "复读并翻译为日语" },
      { command: "stop", description: "停止当前的复读" },
      { command: "kick", description: "踢出群聊并封禁（仅白名单用户可用）" },
      { command: "balance", description: "查询 DeepSeek 账户余额" },
      { command: "quiet", description: "让机器人安静一会（分钟数 1~15，默认 3）" },
      { command: "unquiet", description: "提前解除 /quiet 静默" },
    ]);
  } catch (error: unknown) {
    logger.error("Failed to register bot commands menu:", error);
  }

  // message_reaction / chat_member / callback_query 默认不在 Telegram 的隐式更新
  // 集合里，必须显式声明才能收到；一旦显式声明，就必须把 message/channel_post
  // 也列进来，否则它们反而会被排除。chat_member 是入群验证功能能收到"谁加入了
  // 群"的关键——群里如果开了"隐藏加入/离开提示"，new_chat_members 服务消息
  // 根本不会产生，只有 chat_member 这个更新类型不受影响，始终会推送；
  // callback_query 则是入群验证按钮点击的信号来源。
  // 用 @grammyjs/runner 代替 bot.start()：内建轮询对所有更新全局串行，一条
  // 消息的处理（复读、翻译）会卡住后面的 reaction 更新；runner 按上面的
  // sequentialize 约束并发处理。
  await bot.init();
  // 把机器人自己的账号身份注入 AI Worker：bot.init() 拿到 botInfo 之后、
  // runner 开始投喂更新之前注入，postMessage 的 FIFO 保证这条 init 消息
  // 先于一切「记录/触发」事件到达 Worker。
  initAiChat(bot.botInfo);
  const copyingChats: number = Array.from(chatStates.values()).filter((s) => s.isCopying).length;
  logger.log(
    `Bot started as @${bot.botInfo.username}. ` +
    `Restored state for ${chatStates.size} chat(s), ${copyingChats} currently copying.`
  );

  const runner: RunnerHandle = run(bot, {
    runner: {
      fetch: {
        allowed_updates: ["message", "channel_post", "message_reaction", "chat_member", "callback_query"],
      },
    },
  });

  const stopBot = (): void => {
    void runner.stop();
  };
  process.once("SIGINT", stopBot);
  process.once("SIGTERM", stopBot);

  await runner.task();

  // 与内建 bot.stop() 的停机行为对齐：用已处理的最大 update_id 做一次空
  // getUpdates，告知 Telegram 这批更新已消费，重启后不再重放。
  if (lastSeenUpdateId > 0) {
    try {
      await bot.api.getUpdates({ offset: lastSeenUpdateId + 1, limit: 1, timeout: 0 });
    } catch (error: unknown) {
      logger.error("Failed to confirm update offset on shutdown:", error);
    }
  }
}

main()
  .catch((err: unknown) => {
    logger.error("Unhandled error in bot main runner:", err);
  })
  .finally(() => flushLogs());
// 进程退出前的最后一刷：SIGINT/SIGTERM 经 stopBot 停掉 runner 后 main 才
// 结束，此时把日志线程 buffer 里的存货（最长滞留一分钟）强制落盘，停机
// 尾段产生的 error（如 offset 确认失败）也能收进去。崩溃路径同样覆盖。
