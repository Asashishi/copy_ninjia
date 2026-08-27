/**
 * registerHandlers 的**分发**行为：把真实的注册链装在真实的 grammY Bot 上，
 * 用真实 update 走一遍 bot.handleUpdate，断言每条 update 落到哪个 handler、
 * 以及认领之后链路是否按约定终止。
 *
 * 与 registerHandlers.test.ts 分工：那一条只看「注册了什么、顺序如何」，
 * 拦得住漏注册与错序，但拦不住「注册对了却分发错了」——例如命令收进
 * `:entities:bot_command` 子链后命中集合变窄、ingress 认领后仍然放行下游。
 * 本文件只 mock handler 本体（记录调用名），注册链、过滤与分发全用生产实现。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Bot, Context } from "grammy";

/** 本次 update 命中的 handler 名，按调用顺序。 */
const calls: string[] = [];
/** 三条 ingress 是否认领本条 update；每个用例自行设置。 */
const claims: { antiRaid: boolean; gag: boolean; qa: boolean; qaBoard: boolean } = {
  antiRaid: false,
  gag: false,
  qa: false,
  qaBoard: false,
};
/** 两道前置网关的判定；缺省全放行。 */
const gates: { init: boolean; privateCommand: boolean; privateProxy: boolean } = {
  init: true,
  privateCommand: true,
  privateProxy: false,
};

function record(name: string): () => Promise<void> {
  return (): Promise<void> => {
    calls.push(name);
    return Promise.resolve();
  };
}

/** 命令名 -> 该命令应当命中的 handler 导出名。 */
const COMMAND_HANDLERS: Readonly<Record<string, string>> = {
  permission: "handlePermissionCommand",
  white: "handleWhiteCommand",
  copy: "handleCopyCommand",
  r_copy: "handleCopyCommand",
  nya_copy: "handleCopyCommand",
  ja_copy: "handleJaCopyCommand",
  steal_icon: "handleStealIconCommand",
  reset_icon: "handleResetIconCommand",
  stop_copy: "handleStopCommand",
  block: "handleBlockCommand",
  batch_kick: "handleBatchKickCommand",
  unblock: "handleUnblockCommand",
  ai_chat: "handleAiChatCommand",
  ad_detect: "handleAdDetectCommand",
  flood_control: "handleFloodControlCommand",
  antiraid: "handleAntiRaidCommand",
  bot_status: "handleBotStatusCommand",
  query_mood: "handleQueryMoodCommand",
  switch_mood: "handleSwitchMoodCommand",
  init: "handleInitCommand",
  quiet: "handleQuietCommand",
  unquiet: "handleUnquietCommand",
  mute: "handleMuteCommand",
  unmute: "handleUnmuteCommand",
  gag: "handleGagCommand",
  ungag: "handleUngagCommand",
  send: "handleSendCommand",
  set_qa: "handleSetQaCommand",
  query_qa: "handleQueryQaCommand",
  remove_qa: "handleRemoveQaCommand",
  x: "handleCjkActionUsageCommand",
};

const commandsModule: Record<string, unknown> = {
  confirmLuckDraw: (): undefined => undefined,
  // 中文动作命令按原文 hears；不认领时由 handler 自己 next()，这里照搬那条语义。
  handleCjkActionCommand: (_ctx: Context, next: () => Promise<void>): Promise<void> => {
    calls.push("handleCjkActionCommand");
    return next();
  },
  handleGagMessageIngress: (): Promise<boolean> => {
    calls.push("handleGagMessageIngress");
    return Promise.resolve(claims.gag);
  },
  handleQaMessageIngress: (): Promise<boolean> => {
    calls.push("handleQaMessageIngress");
    return Promise.resolve(claims.qa);
  },
  handleQaBoardCallback: (): Promise<boolean> => {
    calls.push("handleQaBoardCallback");
    return Promise.resolve(claims.qaBoard);
  },
  handleInlineQuery: record("handleInlineQuery"),
  handleLuckChosenInlineResult: record("handleLuckChosenInlineResult"),
};
for (const handlerName of new Set(Object.values(COMMAND_HANDLERS))) {
  commandsModule[handlerName] = record(handlerName);
}

mock.module("../../packages/commands", () => commandsModule);
mock.module("../../packages/auto", () => ({
  handleIncomingMessageMiddleware: (): undefined => {
    calls.push("handleIncomingMessageMiddleware");
    return undefined;
  },
  handleReaction: record("handleReaction"),
}));
mock.module("../../packages/antiRaid", () => ({
  handleChatMemberUpdate: record("handleChatMemberUpdate"),
  handleAntiRaidMessageIngress: (): Promise<boolean> => {
    calls.push("handleAntiRaidMessageIngress");
    return Promise.resolve(claims.antiRaid);
  },
  handleVerificationCallback: record("handleVerificationCallback"),
}));
mock.module("../../packages/infra/botAdmin", () => ({
  handleMyChatMemberUpdate: record("handleMyChatMemberUpdate"),
}));
mock.module("../../packages/infra/logger", () => ({
  logger: {
    log: (): undefined => undefined,
    info: (): undefined => undefined,
    warn: (): undefined => undefined,
    error: (): undefined => undefined,
  },
}));
mock.module("../../packages/infra/identityStorage", () => ({
  isIdentityPolicyCached: (): boolean => true,
  prefetchIdentityPolicies: (): Promise<boolean> => Promise.resolve(true),
}));
mock.module("../../packages/infra/updateGate", () => ({
  shouldPassInitGate: (): boolean => gates.init,
  shouldPassPrivateCommandGate: (): boolean => gates.privateCommand,
  shouldRoutePrivateProxyMessage: (): boolean => gates.privateProxy,
}));
mock.module("../../packages/users/messageOrigin", () => ({
  messageOriginIdentityId: (): undefined => undefined,
}));

const { Bot: RealBot } = await import("grammy");
const { registerHandlers } = await import("../../packages/app/registerHandlers");

const BOT_ID: number = 4242;
const BOT_USERNAME: string = "tensai_bot";
const CHAT = { id: -1001234567890, type: "supergroup", title: "dispatch" } as const;
const CHANNEL = { id: -1009876543210, type: "channel", title: "dispatch channel" } as const;
const FROM = { id: 42, is_bot: false, first_name: "Stable" } as const;

const bot: Bot = new RealBot("1:AAA", {
  botInfo: {
    id: BOT_ID,
    is_bot: true,
    first_name: "Tensai",
    username: BOT_USERNAME,
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: true,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  },
});
registerHandlers(bot);

let nextUpdateId: number = 1;

/** 群消息 update；`entities` 由调用方决定，命令用例自己给 bot_command。 */
function groupMessage(text: string, entities?: readonly unknown[]): unknown {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: {
      message_id: nextUpdateId,
      date: 1,
      chat: CHAT,
      from: FROM,
      text,
      ...(entities === undefined ? {} : { entities }),
    },
  };
}

/** 把 `/name…` 渲染成带 offset 0 的 bot_command 实体，与 Telegram 一致。 */
function commandMessage(text: string): unknown {
  const length: number = text.split(" ")[0]!.length;
  return groupMessage(text, [{ type: "bot_command", offset: 0, length }]);
}

async function dispatch(update: unknown): Promise<readonly string[]> {
  calls.length = 0;
  await bot.handleUpdate(update as Parameters<Bot["handleUpdate"]>[0]);
  return [...calls];
}

beforeEach((): void => {
  claims.antiRaid = false;
  claims.gag = false;
  claims.qa = false;
  claims.qaBoard = false;
  gates.init = true;
  gates.privateCommand = true;
  gates.privateProxy = false;
});

describe("registerHandlers 分发", () => {
  test("31 条命令全部经 :entities:bot_command 子链落到各自 handler，且不再进消息兜底", async () => {
    for (const [command, handler] of Object.entries(COMMAND_HANDLERS)) {
      const observed: readonly string[] = await dispatch(commandMessage(`/${command}`));
      // 命令消息同样要先过三条 ingress：待验证成员发的命令必须计入刷屏窗口、
      // 被 gag 的命令消息不得继续，`/set_qa` 表单投递也要先被认领。
      expect(observed).toEqual([
        "handleAntiRaidMessageIngress",
        "handleGagMessageIngress",
        "handleQaMessageIngress",
        handler,
      ]);
      expect(observed).not.toContain("handleIncomingMessageMiddleware");
    }
  });

  test("带 @ 后缀的命令仍命中同一 handler，指向别的 bot 时不认领", async () => {
    expect(await dispatch(commandMessage(`/permission@${BOT_USERNAME}`)))
      .toContain("handlePermissionCommand");
    const other: readonly string[] = await dispatch(commandMessage("/permission@other_bot"));
    expect(other).not.toContain("handlePermissionCommand");
    // 不是发给本 bot 的命令按普通消息继续流转，与分组前一致。
    expect(other).toContain("handleIncomingMessageMiddleware");
  });

  test("bot_command 实体不在 offset 0 时不算命令，落回消息兜底", async () => {
    const observed: readonly string[] = await dispatch(
      groupMessage("看 /permission", [{ type: "bot_command", offset: 2, length: 11 }])
    );
    expect(observed).not.toContain("handlePermissionCommand");
    expect(observed).toContain("handleIncomingMessageMiddleware");
  });

  test("没有 bot_command 实体的消息一次跳过整组命令，直达 hears 与消息兜底", async () => {
    // 这条正是分组的收益点：整组 31 层 lazy 一次都不走。
    expect(await dispatch(groupMessage("普通群消息"))).toEqual([
      "handleAntiRaidMessageIngress",
      "handleGagMessageIngress",
      "handleQaMessageIngress",
      "handleIncomingMessageMiddleware",
    ]);
  });

  test("中文动作命令走 hears，且排在消息兜底之前", async () => {
    const observed: readonly string[] = await dispatch(groupMessage("/咬"));
    expect(observed).toContain("handleCjkActionCommand");
    expect(observed.indexOf("handleCjkActionCommand"))
      .toBeLessThan(observed.indexOf("handleIncomingMessageMiddleware"));
  });

  test("频道帖里的命令同样命中：命令组覆盖 channel_post", async () => {
    nextUpdateId += 1;
    const observed: readonly string[] = await dispatch({
      update_id: nextUpdateId,
      channel_post: {
        message_id: nextUpdateId,
        date: 1,
        chat: CHANNEL,
        text: "/set_qa",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
    });
    expect(observed).toContain("handleSetQaCommand");
    // 频道帖不进 Anti-Raid / gag 那两条只挂在 message 上的 ingress。
    expect(observed).not.toContain("handleAntiRaidMessageIngress");
    expect(observed).toContain("handleQaMessageIngress");
  });

  test("Anti-Raid ingress 认领后整条 update 终止", async () => {
    claims.antiRaid = true;
    expect(await dispatch(commandMessage("/permission")))
      .toEqual(["handleAntiRaidMessageIngress"]);
  });

  test("gag ingress 认领后整条 update 终止", async () => {
    claims.gag = true;
    expect(await dispatch(commandMessage("/permission"))).toEqual([
      "handleAntiRaidMessageIngress",
      "handleGagMessageIngress",
    ]);
  });

  test("/set_qa 表单投递认领后整条 update 终止", async () => {
    claims.qa = true;
    expect(await dispatch(groupMessage("回答: 一段答案"))).toEqual([
      "handleAntiRaidMessageIngress",
      "handleGagMessageIngress",
      "handleQaMessageIngress",
    ]);
  });

  test("init 网关拒绝时命令与消息流水线都不执行", async () => {
    gates.init = false;
    expect(await dispatch(commandMessage("/permission"))).toEqual([]);
    expect(await dispatch(groupMessage("普通群消息"))).toEqual([]);
  });

  test("翻页看板先认领 callback_query，未认领才交给入群验证", async () => {
    nextUpdateId += 1;
    const query = {
      id: "q1",
      from: FROM,
      chat_instance: "ci",
      data: "qa_board:2",
      message: { message_id: 7, date: 1, chat: CHAT },
    };
    claims.qaBoard = true;
    expect(await dispatch({ update_id: nextUpdateId, callback_query: query }))
      .toEqual(["handleQaBoardCallback"]);
    claims.qaBoard = false;
    nextUpdateId += 1;
    expect(await dispatch({ update_id: nextUpdateId, callback_query: query }))
      .toEqual(["handleQaBoardCallback", "handleVerificationCallback"]);
  });

  test("非消息 update 各自落到对应 handler", async () => {
    const member = {
      chat: CHAT,
      from: FROM,
      date: 1,
      old_chat_member: { status: "left", user: FROM },
      new_chat_member: { status: "member", user: FROM },
    };
    nextUpdateId += 1;
    expect(await dispatch({ update_id: nextUpdateId, chat_member: member }))
      .toEqual(["handleChatMemberUpdate"]);
    nextUpdateId += 1;
    expect(await dispatch({ update_id: nextUpdateId, my_chat_member: member }))
      .toEqual(["handleMyChatMemberUpdate"]);
    nextUpdateId += 1;
    expect(await dispatch({
      update_id: nextUpdateId,
      message_reaction: {
        chat: CHAT, message_id: 3, user: FROM, date: 1, old_reaction: [], new_reaction: [],
      },
    })).toEqual(["handleReaction"]);
    nextUpdateId += 1;
    expect(await dispatch({
      update_id: nextUpdateId,
      inline_query: { id: "i1", from: FROM, query: "", offset: "" },
    })).toEqual(["handleInlineQuery"]);
    nextUpdateId += 1;
    expect(await dispatch({
      update_id: nextUpdateId,
      chosen_inline_result: { result_id: "r1", from: FROM, query: "" },
    })).toEqual(["handleLuckChosenInlineResult"]);
  });
});
