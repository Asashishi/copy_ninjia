import { logger } from "./src/infra/logger";
import { flushDiskIO, loadPersistedData, type LoadedData } from "./src/infra/diskIO";
import { GrammyError } from "grammy";
import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import { bot } from "./src/infra/telegram";
import { BOT_TOKEN } from "./src/infra/config";
import { acquireSingleInstanceLock, getAllChatStates, getGlobalCopyState, loadState, releaseSingleInstanceLock } from "./src/infra/storage";
import { shouldPassInitGate, shouldPassPrivateCommandGate } from "./src/infra/updateGate";
import { handleIncomingMessage, handleReaction } from "./src/auto";
import { confirmLuckDraw, handleAiChatCommand, handleCopyCommand, handleInitCommand, handleJaCopyCommand, handleKickCommand, handleLuckChallengeInlineQuery, handleLuckChosenInlineResult, handleQuietCommand, handleSendCommand, handleStealIconCommand, handleStopCommand, handleUnquietCommand, restoreLuckCache } from "./src/commands";
import { handleChatMemberUpdate, handleGroupJoinVerification, handleVerificationCallback, initAntiRaid } from "./src/antiRaid";
import { handleMyChatMemberUpdate } from "./src/infra/botAdmin";
import { refreshAllChatTitles } from "./src/infra/chatTitle";
import { flushAiMemory, hydrateAiMemory, hydrateStickerCatalog, initAiChat } from "./src/aiChat";
import { seedSenderCache } from "./src/users/senderIdentity";
import type { CachedUser } from "./src/types";

/**
 * 注册各类更新处理器，并启动 grammY 的长轮询循环。
 */
async function main(): Promise<void> {
  await acquireSingleInstanceLock(BOT_TOKEN);

  // 全部持久化状态（各群独立状态 + 全局复读状态）由 storage.ts 独占持有，
  // 这里只触发从 state.json 的一次性加载；各处理器直接从 storage 读写，
  // 不再层层传引用。
  await loadState();

  // 启动流程：给 state.json 里已知的每个群现查一次当前群名称并回填（见
  // infra/chatTitle.ts）——纯粹方便人手动核对/编辑这个文件，不阻塞 bot
  // 启动主流程，失败只记日志，不影响正常运行。
  void refreshAllChatTitles();

  // AI 记忆快照 + 每日运势缓存由 diskIOWorker 落盘，这里触发一次启动恢复
  // 并等待回执（带超时，见 loadPersistedData）。灌回操作在 initAiChat /
  // initAntiRaid 之后才做（见下方），这里先只是把数据请回来。
  const loaded: LoadedData = await loadPersistedData();

  // 目前正在被 copy 的用户/频道（全局唯一）直接从全局复读状态派生，预热进
  // 发送者身份缓存（见 users/senderIdentity.ts 的 seedSenderCache），让进程
  // 重启后立刻能用 /copy @username 重新指到 TA，不必等 TA 再发一条消息刷新缓存。
  const restoredCopiedUser: CachedUser | null = getGlobalCopyState().copiedUser;
  if (restoredCopiedUser) {
    seedSenderCache(restoredCopiedUser);
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

  // 运势签名回执是 chosen_inline_result 之外的确认路径。转发副本也有效，
  // 因此必须在 isInit 网关前检查；正文不参与确认，详见 luckChallenge.ts。
  bot.use((ctx, next) => {
    confirmLuckDraw(ctx.msg?.text);
    return next();
  });

  // isInit 网关：见 ChatState.isInit 注释、判断逻辑见 src/infra/updateGate.ts
  // 的 shouldPassInitGate（含放行哪些更新的完整说明）。Bot API 长轮询没有
  // 「取消订阅某个群」的机制，Telegram 仍会把机器人所在所有群的更新推给这个
  // 进程；未通过 /init enable 初始化的群，整条处理链在这里终止——只做一次
  // Map 查找就丢弃，不再往下走 sequentialize、入群验证、指令匹配、AI 调用等
  // 任何开销，是应用层面能做到的最接近「不监听」的效果，避免被拉进大量群时
  // 被拖垮。放在最前端（先于 sequentialize，仅次于上面的运势认领——那一步
  // 必须看见未初始化群的消息），未初始化群的每条更新成本降到最低。
  bot.use((ctx, next) => (shouldPassInitGate(ctx) ? next() : undefined));

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

  // 私聊命令默认拦截，只放行 /send 入口和活动中转会话；规则集中在 updateGate。
  bot.use((ctx, next) => (shouldPassPrivateCommandGate(ctx) ? next() : undefined));

  // 入群守卫的消息投递必须挂在命令处理器之前：命令处理器匹配到命令后不再
  // 往下传，若放在其后（或放在 handleIncomingMessage 里），待验证用户发的
  // 命令消息就不会被追踪，超时踢人时清理不掉。返回 true 表示这是入群公告、
  // 已被守卫完全处理，直接吞掉，不再触发命令/复读/AI。
  bot.on("message", async (ctx, next) => {
    if (await handleGroupJoinVerification(ctx.message, ctx.me.id)) return;
    return next();
  });

  // 命令处理器要注册在通用消息处理器之前：匹配到命令时 grammY 不会再往下传给它。
  bot.command("copy", (ctx) => handleCopyCommand(ctx));
  bot.command("r_copy", (ctx) => handleCopyCommand(ctx, "reverse"));
  bot.command("nya_copy", (ctx) => handleCopyCommand(ctx, "nya"));
  bot.command("ja_copy", (ctx) => handleJaCopyCommand(ctx));
  bot.command("steal_icon", (ctx) => handleStealIconCommand(ctx));
  bot.command("stop_copy", (ctx) => handleStopCommand(ctx));
  bot.command("kick", (ctx) => handleKickCommand(ctx));
  bot.command("ai_chat", (ctx) => handleAiChatCommand(ctx));
  bot.command("init", (ctx) => handleInitCommand(ctx));
  bot.command("quiet", (ctx) => handleQuietCommand(ctx));
  bot.command("unquiet", (ctx) => handleUnquietCommand(ctx));
  // /send：刻意不放进下面的 setMyCommands 菜单（见 commands/send.ts 头注），
  // 只能私聊触发、仅 SUPER_ADMIN_USER_ID 本人可用。/send <群组id> 开一轮中转，
  // 此后这个私聊里发的每条消息都会被同步转发进该群一次，直到 /send finish。
  bot.command("send", (ctx) => handleSendCommand(ctx));
  bot.on(["message", "channel_post"], (ctx) => handleIncomingMessage(ctx));
  bot.on("message_reaction", (ctx) => handleReaction(ctx));
  bot.on("chat_member", (ctx) => handleChatMemberUpdate(ctx));
  // 维护 ChatState.botIsAdmin（见该字段注释）。
  bot.on("my_chat_member", (ctx) => handleMyChatMemberUpdate(ctx));
  bot.on("callback_query:data", (ctx) => handleVerificationCallback(ctx));
  // /luck_challenge 仅通过内联模式触发（@本机器人 [文本]），没有对应的
  // 斜杠命令。这个入口需要先在 BotFather 里给机器人开启 Inline Mode，
  // 否则 Telegram 根本不会把 inline_query 更新发过来。
  bot.on("inline_query", (ctx) => handleLuckChallengeInlineQuery(ctx));
  // 抽签确认主路：用户在任意聊天选中内联结果时 Telegram 直推的回执，
  // 不依赖机器人在那个聊天在场（需在 BotFather 开 /setinlinefeedback），
  // 见 commands/luckChallenge.ts 的 handleLuckChosenInlineResult。
  bot.on("chosen_inline_result", (ctx) => handleLuckChosenInlineResult(ctx));

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
      { command: "ja_copy", description: "复读并翻译为日语；enable/disable 开关本群该功能（仅限定用户可用）" },
      { command: "stop_copy", description: "停止当前的复读" },
      { command: "steal_icon", description: "偷取目标头像作为 bot 头像" },
      { command: "kick", description: "在所有本天才管理的群里踢出并封禁（仅白名单用户可用）" },
      { command: "ai_chat", description: "开关本群 AI 闲聊功能，enable/disable（仅限定用户可用）" },
      { command: "init", description: "开关本群的机器人监听/初始化，enable/disable（仅限定用户可用）" },
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
  // BotFather 里手动开启 Inline Mode，光加这里不够）；chosen_inline_result
  // 是抽签确认的主信号（同样要在 BotFather 用 /setinlinefeedback 开启，
  // 建议 100%，否则 Telegram 不发这类更新，确认只剩签名回执兜底路）。
  // 用 @grammyjs/runner 代替 bot.start()：内建轮询对所有更新全局串行，一条
  // 消息的处理（复读、翻译）会卡住后面的 reaction 更新；runner 按上面的
  // sequentialize 约束并发处理。
  await bot.init();
  // 把机器人自己的账号身份注入 AI Worker：bot.init() 拿到 botInfo 之后、
  // runner 开始投喂更新之前注入，postMessage 的 FIFO 保证这条 init 消息
  // 先于一切「记录/触发」事件到达 Worker。
  initAiChat(bot.botInfo);
  // 紧随 init 之后灌回持久化的 AI 记忆快照，FIFO 保证先于一切 record/trigger
  // 到达 Worker（见 aiChat.ts 的 hydrateAiMemory）。
  hydrateAiMemory(loaded.aiMemories);
  // 同样紧随 init 之后灌回持久化的白名单贴纸目录，让 Worker 收到 init 后
  // 台启动的目录生成能看到已恢复的条目、不重复调视觉模型（见 aiChat.ts 的
  // hydrateStickerCatalog）。
  hydrateStickerCatalog(loaded.stickerCatalogs);
  // 接管当日运势缓存（day 对不上今天则整体丢弃，见 restoreLuckCache）：
  // dailyLuckCache 是主线程同步读写的，必须赶在 runner 开始投喂
  // inline_query 之前灌好，否则会出现「今天已抽过却又抽出新结果」。
  restoreLuckCache(loaded.luckDay);
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
        allowed_updates: ["message", "channel_post", "message_reaction", "chat_member", "my_chat_member", "callback_query", "inline_query", "chosen_inline_result"],
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

/**
 * 尽力跑一遍完整的落盘链：先让 aiChatWorker 把 dirty 记忆快照吐给主线程
 * （转投 diskIOWorker），再让 diskIOWorker 把三类 dirty 数据（日志/AI 记忆/
 * 运势）全部落盘。①②两步必须顺序执行，不能并发——AI 记忆要先经过主线程
 * 中转落进 diskIOWorker 的缓存，flush 才有东西可落；调换顺序或并发跑，
 * flush 可能抢在记忆转投完成之前执行，白白丢掉这一份增量。
 */
async function flushAllToDisk(aiMemoryTimeoutMs: number, diskIOTimeoutMs: number): Promise<void> {
  await flushAiMemory(aiMemoryTimeoutMs); // ①
  await flushDiskIO(diskIOTimeoutMs); // ②
}

// 可选加固：uncaughtException / unhandledRejection 默认会直接崩溃进程、
// 不走下面 main().finally() 的正常落盘链。这里兜底捕获，记日志后尽力跑
// 一遍同样的 flush 链（短超时，避免进程被一次异常的清理流程拖住太久），
// 再退出——退出码非零，systemd 配 Restart=on-failure 时会照常自动重启。
process.on("uncaughtException", (error: unknown) => {
  logger.error("Uncaught exception, attempting a best-effort flush before exit:", error);
  void flushAllToDisk(1000, 1000).finally(() => process.exit(1));
});
process.on("unhandledRejection", (reason: unknown) => {
  logger.error("Unhandled rejection, attempting a best-effort flush before exit:", reason);
  void flushAllToDisk(1000, 1000).finally(() => process.exit(1));
});

main()
  .catch((err: unknown) => {
    logger.error("Unhandled error in bot main runner:", err);
    // 以非零码退出：不设的话进程会以 0 正常退出，systemd 配 Restart=on-failure
    // 时启动期的致命错误（状态文件损坏等）就不会触发自动重启。
    process.exitCode = 1;
  })
  .finally(async () => {
    await flushAllToDisk(2000, 3000);
    await releaseSingleInstanceLock(BOT_TOKEN);
  });
// 进程退出前的最后一刷：SIGINT/SIGTERM 经 stopBot 停掉 runner 后 main 才
// 结束，此时把 aiChatWorker/diskIOWorker 里的存货（AI 记忆最长滞留
// 30 秒 + 10 秒、运势和日志最长滞留 30 秒）强制落盘，停机
// 尾段产生的 error（如 offset 确认失败）也能收进去。硬崩（kill -9/OOM/
// 断电）走不到这里——那正是定时写窗口 + 原子 rename + 启动修复兜底的场景，
// 丢失量有上界，接受。
