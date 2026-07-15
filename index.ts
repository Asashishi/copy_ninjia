import { flushLogs, logger } from "./src/infra/logger";
import { GrammyError } from "grammy";
import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import { bot } from "./src/infra/telegram";
import { acquireSingleInstanceLock, getAllChatStates, getGlobalCopyState, loadState } from "./src/infra/storage";
import { handleIncomingMessage, handleReaction } from "./src/auto";
import { handleAiChatCommand, handleBalanceCommand, handleCopyCommand, handleJaTransCommand, handleKickCommand, handleLuckChallengeInlineQuery, handleQuietCommand, handleStealIconCommand, handleStopCommand, handleUnquietCommand } from "./src/commands";
import { handleChatMemberUpdate, handleGroupJoinVerification, handleVerificationCallback, initAntiRaid } from "./src/antiRaid";
import { handleMyChatMemberUpdate } from "./src/infra/botAdmin";
import { initAiChat } from "./src/aiChat";
import type { CachedUser } from "./src/types";

/**
 * 注册各类更新处理器，并启动 grammY 的长轮询循环。
 */
async function main(): Promise<void> {
  await acquireSingleInstanceLock();

  // 全部持久化状态（各群独立状态 + 全局复读状态）由 storage.ts 独占持有，
  // 这里只触发从 state.json 的一次性加载；各处理器直接从 storage 读写，
  // 不再层层传引用。
  await loadState();

  // 恢复内存中的临时 users 缓存：目前正在被 copy 的用户/频道（全局唯一）
  // 直接从全局复读状态派生，不需要再从另一份文件读入合并。
  const users: Record<string, CachedUser> = {};
  const restoredCopiedUser: CachedUser | null = getGlobalCopyState().copiedUser;
  if (restoredCopiedUser?.username) {
    users[restoredCopiedUser.username.toLowerCase()] = restoredCopiedUser;
  }

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

  // 私聊里不触发任何命令（/copy 系、/stop_copy /kick /balance /quiet 等全部）：这些
  // 指令都是围绕群聊状态设计的（复读目标、群内踢人、群内静默），私聊语境下
  // 没有意义，也免得被人在 DM 里瞎捣鼓。放在命令处理器注册之前，直接吞掉
  // 这类更新，不再往下传给任何处理器。
  bot.use((ctx, next) => {
    if (ctx.chat?.type === "private" && ctx.message?.text?.startsWith("/")) {
      return;
    }
    return next();
  });

  // 入群守卫的消息投递必须挂在命令处理器之前：命令处理器匹配到命令后不再
  // 往下传，若放在其后（或放在 handleIncomingMessage 里），待验证用户发的
  // 命令消息就不会被追踪，超时踢人时清理不掉。返回 true 表示这是入群公告、
  // 已被守卫完全处理，直接吞掉，不再触发命令/复读/AI。
  bot.on("message", async (ctx, next) => {
    if (await handleGroupJoinVerification(ctx.message, ctx.me.id)) return;
    return next();
  });

  // 命令处理器要注册在通用消息处理器之前：匹配到命令时 grammY 不会再往下传给它。
  bot.command("copy", (ctx) => handleCopyCommand(ctx, users));
  bot.command("r_copy", (ctx) => handleCopyCommand(ctx, users, "reverse"));
  bot.command("nya_copy", (ctx) => handleCopyCommand(ctx, users, "nya"));
  bot.command("ja_copy", (ctx) => handleCopyCommand(ctx, users, "ja"));
  bot.command("steal_icon", (ctx) => handleStealIconCommand(ctx, users));
  bot.command("stop_copy", (ctx) => handleStopCommand(ctx));
  bot.command("kick", (ctx) => handleKickCommand(ctx, users));
  bot.command("ai_chat", (ctx) => handleAiChatCommand(ctx));
  bot.command("ja_trans", (ctx) => handleJaTransCommand(ctx));
  bot.command("balance", (ctx) => handleBalanceCommand(ctx));
  bot.command("quiet", (ctx) => handleQuietCommand(ctx));
  bot.command("unquiet", (ctx) => handleUnquietCommand(ctx));
  bot.on(["message", "channel_post"], (ctx) => handleIncomingMessage(ctx, users));
  bot.on("message_reaction", (ctx) => handleReaction(ctx));
  bot.on("chat_member", (ctx) => handleChatMemberUpdate(ctx));
  // 维护 ChatState.botIsAdmin（见该字段注释）。
  bot.on("my_chat_member", (ctx) => handleMyChatMemberUpdate(ctx));
  bot.on("callback_query:data", (ctx) => handleVerificationCallback(ctx));
  // /luck_challenge 仅通过内联模式触发（@本机器人 [文本]），没有对应的
  // 斜杠命令。这个入口需要先在 BotFather 里给机器人开启 Inline Mode，
  // 否则 Telegram 根本不会把 inline_query 更新发过来。
  bot.on("inline_query", (ctx) => handleLuckChallengeInlineQuery(ctx));

  bot.catch((err) => {
    // GrammyError 会把调用失败时的完整请求体原样挂在 .payload 上；logger 对
    // Error 是展开它的可枚举属性再落盘的，如果这里把 err.error 整个传进去，
    // payload 里任何带 token 的字段（比如 /luck_challenge 内联结果里的头像
    // 缩略图 URL，本身就嵌着 BOT_TOKEN）都会被原样写进日志文件。只取
    // error_code/description，不让 payload 有机会流入日志。
    if (err.error instanceof GrammyError) {
      logger.error(`Unhandled error while handling update ${err.ctx.update.update_id}: ${err.error.error_code} ${err.error.description}`);
    } else {
      logger.error(`Unhandled error while handling update ${err.ctx.update.update_id}:`, err.error);
    }
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
      { command: "stop_copy", description: "停止当前的复读" },
      { command: "steal_icon", description: "偷取目标头像作为 bot 头像" },
      { command: "kick", description: "在所有本天才管理的群里踢出并封禁（仅白名单用户可用）" },
      { command: "ai_chat", description: "开关本群 AI 闲聊功能，enable/disable（仅限定用户可用）" },
      { command: "ja_trans", description: "开关本群 /ja_copy 日语翻译功能，enable/disable（仅限定用户可用）" },
      { command: "balance", description: "查询 DeepSeek 账户余额" },
      { command: "quiet", description: "让机器人安静一会（分钟数 1~15，默认 3）" },
      { command: "unquiet", description: "提前解除 /quiet 静默" },
    ]);
  } catch (error: unknown) {
    logger.error("Failed to register bot commands menu:", error);
  }

  // 下面这个 allowed_updates 是完全自定义的一份列表，会整体替换 Telegram 的
  // 默认订阅集合，而不是在默认集合上追加——所以哪怕某个更新类型本来就在
  // 默认集合里，只要不在这份列表里就照样收不到，message/channel_post 必须
  // 跟着一起列进来，否则反而会被排除。message_reaction / chat_member 默认
  // 确实不在隐式集合里，必须显式声明才能收到。chat_member 是入群验证功能能
  // 收到"谁加入了群"的关键——群里如果开了"隐藏加入/离开提示"，new_chat_members
  // 服务消息根本不会产生，只有 chat_member 这个更新类型不受影响，始终会推送；
  // callback_query 是入群验证按钮点击的信号来源；inline_query 是
  // `@本机器人 ...` 内联模式（/luck_challenge）的信号来源（还需要在
  // BotFather 里手动开启该开关，光加这里不够）。
  // 用 @grammyjs/runner 代替 bot.start()：内建轮询对所有更新全局串行，一条
  // 消息的处理（复读、翻译）会卡住后面的 reaction 更新；runner 按上面的
  // sequentialize 约束并发处理。
  await bot.init();
  // 把机器人自己的账号身份注入 AI Worker：bot.init() 拿到 botInfo 之后、
  // runner 开始投喂更新之前注入，postMessage 的 FIFO 保证这条 init 消息
  // 先于一切「记录/触发」事件到达 Worker。
  initAiChat(bot.botInfo);
  // 接管上次进程退出时仍在生效的反刷群私密模式（各群 ChatState.lockdown，
  // 已随上面的 loadState() 一次性读出）：同样要赶在 runner 投喂更新之前
  // adopt 给守卫 Worker，让它重排解锁计时。
  initAntiRaid();
  logger.log(
    `Bot started as @${bot.botInfo.username}. ` +
    `Restored state for ${getAllChatStates().size} chat(s)` +
    (restoredCopiedUser ? `, currently copying ${restoredCopiedUser.id}.` : ".")
  );

  const runner: RunnerHandle = run(bot, {
    runner: {
      fetch: {
        allowed_updates: ["message", "channel_post", "message_reaction", "chat_member", "my_chat_member", "callback_query", "inline_query"],
      },
    },
  });

  const stopBot = (): void => {
    runner.stop().catch((error: unknown) => {
      logger.error("Error stopping runner:", error);
    });
  };
  process.once("SIGINT", stopBot);
  process.once("SIGTERM", stopBot);

  await runner.task();

  // 兑现上面 lastSeenUpdateId 声明处的承诺：确认 offset，避免重启重放。
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
    // 以非零码退出：不设的话进程会以 0 正常退出，systemd 配 Restart=on-failure
    // 时启动期的致命错误（状态文件损坏等）就不会触发自动重启。
    process.exitCode = 1;
  })
  .finally(() => flushLogs());
// 进程退出前的最后一刷：SIGINT/SIGTERM 经 stopBot 停掉 runner 后 main 才
// 结束，此时把日志线程 buffer 里的存货（最长滞留一分钟）强制落盘，停机
// 尾段产生的 error（如 offset 确认失败）也能收进去。崩溃路径同样覆盖。
