import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatMember } from "@grammyjs/types";
import type { BotChatPermissions } from "../../packages/types/telegram";

const states = new Map<number, Record<string, unknown>>();
let member: ChatMember = { status: "administrator", can_restrict_members: true } as ChatMember;
let getChatMemberCalls: number = 0;
let getChatMemberFails: boolean = false;
let onGetChatMember: (() => void) | undefined;

mock.module("../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../packages/infra/telegram", () => ({
  bot: {
    botInfo: { id: 99 },
    api: {
      getChatMember: async (): Promise<ChatMember> => {
        getChatMemberCalls++;
        onGetChatMember?.();
        if (getChatMemberFails) throw new Error("telegram unavailable");
        return member;
      },
    },
  },
}));
mock.module("../../packages/infra/telegram/client", () => ({ joinVerificationApi: { kind: "guard-api" } }));
// botAdmin -> blocklist 的新晋管理员补扫会取这三个；本文件名单为空，不触发。
mock.module("../../packages/infra/telegram/actions", () => ({
  isChatMember: async (): Promise<boolean> => false,
  banChatMember: async (): Promise<boolean> => true,
  banChatSenderChat: async (): Promise<boolean> => true,
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getAllChatStates: (): ReadonlyMap<number, Record<string, unknown>> => states,
  getChatState: (chatId: number): Record<string, unknown> => states.get(chatId) ?? {},
  getOrCreateChatState: (chatId: number): Record<string, unknown> => {
    let state: Record<string, unknown> | undefined = states.get(chatId);
    if (!state) {
      state = {};
      states.set(chatId, state);
    }
    return state;
  },
  clearChatStateField: (chatId: number, field: string): boolean => {
    const state: Record<string, unknown> | undefined = states.get(chatId);
    if (!state || !(field in state)) return false;
    delete state[field];
    return true;
  },
  pruneDepartedChatState: (chatId: number): void => { states.delete(chatId); },
  persistAuthoritativeState: async (): Promise<void> => {},
  saveStateInBackground: (): void => {},
}));

const {
  botCanDeleteMessagesIn,
  botChatPermissionsIn,
  ensureBotChatPermissions,
  forgetBotChatPermissions,
  handleMyChatMemberUpdate,
  invalidateBotAdminStatus,
  markBotAdminObserved,
  registerBotPermissionObserver,
} = await import("../../packages/infra/botAdmin");
const {
  botChatPermissions,
  botPermissionObserver,
  botPermissionProbeBackoff,
} = await import("../../packages/cache/main/botAdmin");
const { BOT_PERMISSION_PROBE_RETRY_MS } = await import("../../packages/consts/botAdmin");

const CHAT_ID: number = -1001;
/** 观察者收到的每一次广播，供断言镜像内容与次数。 */
const broadcasts: { chatId: number; permissions: BotChatPermissions | undefined }[] = [];

beforeEach(() => {
  states.clear();
  states.set(CHAT_ID, { isInitEnabled: true });
  botChatPermissions.clear();
  botPermissionProbeBackoff.clear();
  botPermissionObserver.current = null;
  broadcasts.length = 0;
  member = { status: "administrator", can_restrict_members: true } as ChatMember;
  getChatMemberCalls = 0;
  getChatMemberFails = false;
  onGetChatMember = undefined;
});

function observe(): void {
  registerBotPermissionObserver((chatId: number, permissions: BotChatPermissions | undefined): void => {
    broadcasts.push({ chatId, permissions });
  });
}

function myChatMemberContext(newMember: Partial<ChatMember>, oldStatus: string = "member"): never {
  return {
    myChatMember: {
      chat: { id: CHAT_ID, type: "supergroup" },
      old_chat_member: { status: oldStatus },
      new_chat_member: newMember,
    },
  } as never;
}

describe("机器人自身权限位缓存", () => {
  test("同步删除权限读取保留 true/false/unknown 三态", () => {
    expect(botCanDeleteMessagesIn(CHAT_ID)).toBeUndefined();
    botChatPermissions.set(CHAT_ID, { canRestrictMembers: true, canDeleteMessages: false });
    expect(botCanDeleteMessagesIn(CHAT_ID)).toBeFalse();
    botChatPermissions.set(CHAT_ID, { canRestrictMembers: true, canDeleteMessages: true });
    expect(botCanDeleteMessagesIn(CHAT_ID)).toBeTrue();
  });

  test("my_chat_member 落地后判定是纯内存命中，不打 getChatMember", async () => {
    await handleMyChatMemberUpdate(myChatMemberContext({
      status: "administrator",
      can_restrict_members: true,
      can_delete_messages: true,
    }));

    expect(await botChatPermissionsIn(CHAT_ID)).toEqual({ canRestrictMembers: true, canDeleteMessages: true });
    expect(getChatMemberCalls).toBe(0);
  });

  test("群主恒为全真，普通管理员逐项看自己的开关", async () => {
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "creator" }));
    expect(botChatPermissions.get(CHAT_ID)).toEqual({ canRestrictMembers: true, canDeleteMessages: true });

    // 仍是管理员、只是被取消了限制成员权限：这类改动同样以 my_chat_member 送达，
    // 缓存必须跟着降级，否则禁言/踢人会拿着一份作废的快照继续放行。
    await handleMyChatMemberUpdate(myChatMemberContext({
      status: "administrator",
      can_restrict_members: false,
      can_delete_messages: true,
    }, "administrator"));
    expect(botChatPermissions.get(CHAT_ID)).toEqual({ canRestrictMembers: false, canDeleteMessages: true });
  });

  test("撤管理员与被移出群聊都当场清掉权限位", async () => {
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "administrator", can_restrict_members: true }));
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "member" }, "administrator"));
    expect(botChatPermissions.has(CHAT_ID)).toBeFalse();

    states.set(CHAT_ID, { isInitEnabled: true });
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "administrator", can_restrict_members: true }));
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "kicked" }, "administrator"));
    expect(botChatPermissions.has(CHAT_ID)).toBeFalse();
  });

  test("收到别人的 chat_member 更新只证明「我是管理员」，不写权限位", async () => {
    await markBotAdminObserved(CHAT_ID);
    // 「没观测到」不能被折算成「观测到没有」，否则这个群会被永久判成不能动手。
    expect(botChatPermissions.has(CHAT_ID)).toBeFalse();
  });

  test("从未记录过的群按需现查一次并回填，同群并发判定共享同一次请求", async () => {
    const [first, second]: (BotChatPermissions | undefined)[] = await Promise.all([
      botChatPermissionsIn(CHAT_ID),
      botChatPermissionsIn(CHAT_ID),
    ]);

    expect(getChatMemberCalls).toBe(1);
    expect(first).toEqual({ canRestrictMembers: true, canDeleteMessages: false });
    expect(second).toBe(first);
    // 回填之后就是纯内存命中了。
    expect(await botChatPermissionsIn(CHAT_ID)).toBe(first);
    expect(getChatMemberCalls).toBe(1);
  });

  test("现查失败、以及查回来根本不是管理员，都给出 undefined 且不落缓存", async () => {
    getChatMemberFails = true;
    expect(await botChatPermissionsIn(CHAT_ID)).toBeUndefined();
    expect(botChatPermissions.has(CHAT_ID)).toBeFalse();

    getChatMemberFails = false;
    member = { status: "member" } as ChatMember;
    expect(await botChatPermissionsIn(CHAT_ID)).toBeUndefined();
    expect(botChatPermissions.has(CHAT_ID)).toBeFalse();
    // 失败不留痕：下一次判定照常重查。
    expect(getChatMemberCalls).toBe(2);
  });

  test("现查在途期间被失效的结果不回填", async () => {
    onGetChatMember = (): void => { forgetBotChatPermissions(CHAT_ID); };
    expect(await botChatPermissionsIn(CHAT_ID)).toBeUndefined();
    expect(botChatPermissions.has(CHAT_ID)).toBeFalse();

    // 作废只针对那一次在途请求，下一次照常重查并回填。
    onGetChatMember = undefined;
    expect(await botChatPermissionsIn(CHAT_ID)).toEqual({ canRestrictMembers: true, canDeleteMessages: false });
  });

  test("现查在途期间权威信号先落地时，采用权威值而不是用旧快照顶掉它", async () => {
    const authoritative: BotChatPermissions = { canRestrictMembers: false, canDeleteMessages: false };
    onGetChatMember = (): void => { botChatPermissions.set(CHAT_ID, authoritative); };

    // 现查发出时看到的还是「能限制成员」，但 my_chat_member 已经把权限改动写进
    // 缓存了；这次响应描述的是它到达之前的旧身份，不能回填。
    expect(await botChatPermissionsIn(CHAT_ID)).toBe(authoritative);
    expect(botChatPermissions.get(CHAT_ID)).toBe(authoritative);
  });

  test("/init 开关切换会连权限位一起作废", async () => {
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "administrator", can_restrict_members: true }));
    expect(botChatPermissions.has(CHAT_ID)).toBeTrue();

    invalidateBotAdminStatus(CHAT_ID);
    expect(botChatPermissions.has(CHAT_ID)).toBeFalse();
  });

  test("权限位变化广播给下游（Anti-Raid Worker 的镜像），逐位相同的观测不重复广播", async () => {
    observe();
    await handleMyChatMemberUpdate(myChatMemberContext({
      status: "administrator",
      can_restrict_members: true,
      can_delete_messages: true,
    }));
    expect(broadcasts).toEqual([
      { chatId: CHAT_ID, permissions: { canRestrictMembers: true, canDeleteMessages: true } },
    ]);

    // my_chat_member 会为任何一次成员变动送达（改头衔、改群名片都算）；权限位
    // 没变就不该往 Worker mailbox 里塞一条一模一样的消息。
    await handleMyChatMemberUpdate(myChatMemberContext({
      status: "administrator",
      can_restrict_members: true,
      can_delete_messages: true,
    }, "administrator"));
    expect(broadcasts).toHaveLength(1);

    // 只降一位也要广播。
    await handleMyChatMemberUpdate(myChatMemberContext({
      status: "administrator",
      can_restrict_members: false,
      can_delete_messages: true,
    }, "administrator"));
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1]?.permissions).toEqual({ canRestrictMembers: false, canDeleteMessages: true });

    // 作废（撤管理员/离群/`/init` 切换）广播「未知」，下游据此 fail closed。
    forgetBotChatPermissions(CHAT_ID);
    expect(broadcasts[2]).toEqual({ chatId: CHAT_ID, permissions: undefined });
    // 已经没有值了，重复 teardown 不再广播。
    forgetBotChatPermissions(CHAT_ID);
    expect(broadcasts).toHaveLength(3);
  });

  test("观察者抛错不影响权限记录本身", async () => {
    registerBotPermissionObserver((): never => { throw new Error("worker unavailable"); });
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "administrator", can_restrict_members: true }));
    expect(botChatPermissions.get(CHAT_ID)).toEqual({ canRestrictMembers: true, canDeleteMessages: false });
  });

  test("按需补齐只现查一次，随后是纯内存命中", async () => {
    observe();
    ensureBotChatPermissions(CHAT_ID);
    ensureBotChatPermissions(CHAT_ID);
    await Promise.resolve();
    await Promise.resolve();

    expect(getChatMemberCalls).toBe(1);
    expect(broadcasts).toHaveLength(1);
    ensureBotChatPermissions(CHAT_ID);
    expect(getChatMemberCalls).toBe(1);
  });

  test("补齐失败后退避，不让一场刷屏换来每条消息一次注定失败的现查", async () => {
    getChatMemberFails = true;
    ensureBotChatPermissions(CHAT_ID, 1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(getChatMemberCalls).toBe(1);

    // 退避窗口内不再重试。
    ensureBotChatPermissions(CHAT_ID, 1_000 + BOT_PERMISSION_PROBE_RETRY_MS - 1);
    expect(getChatMemberCalls).toBe(1);

    getChatMemberFails = false;
    ensureBotChatPermissions(CHAT_ID, 1_000 + BOT_PERMISSION_PROBE_RETRY_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(getChatMemberCalls).toBe(2);
    // 成功之后退避记录一并清掉，不留历史群条目。
    expect(botPermissionProbeBackoff.has(CHAT_ID)).toBeFalse();
  });

  test("回归用例：探测发现「其实已经不是管理员」时退避必须留住，" +
    "否则这次探测把自己的退避擦掉，5 分钟一次退化成每条消息一次", async () => {
    // state.json 记着是管理员（停机期间被撤管理员，收不到 my_chat_member），
    // 实际查回来只是普通成员——BOT_PERMISSION_PROBE_RETRY_MS 正是为这一档写的。
    states.set(CHAT_ID, { isInitEnabled: true, botIsAdmin: true });
    member = { status: "member" } as ChatMember;

    ensureBotChatPermissions(CHAT_ID, 1_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(getChatMemberCalls).toBe(1);
    expect(botPermissionProbeBackoff.has(CHAT_ID)).toBeTrue();

    // 同一时刻再来一条消息：退避还在，不该再打一次 getChatMember。
    ensureBotChatPermissions(CHAT_ID, 1_000);
    expect(getChatMemberCalls).toBe(1);
    ensureBotChatPermissions(CHAT_ID, 1_000 + BOT_PERMISSION_PROBE_RETRY_MS - 1);
    expect(getChatMemberCalls).toBe(1);

    // 顺带把过期的 botIsAdmin 纠正掉，让 resolveBotAdminStatus 不再放行——这才是自愈的
    // 那一半，光有退避只是把每条消息一次压成 5 分钟一次。
    expect(states.get(CHAT_ID)?.botIsAdmin).toBe(false);
  });

  test("没 /init enable 的群不留内存条目，光是被拉进去不会长出一张表", async () => {
    states.clear();
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "administrator", can_restrict_members: true }));
    expect(botChatPermissions.size).toBe(0);

    // 现查这一路同样过这道门禁：结果照常返回给调用方，只是不留缓存。
    expect(await botChatPermissionsIn(CHAT_ID)).toEqual({ canRestrictMembers: true, canDeleteMessages: false });
    expect(botChatPermissions.size).toBe(0);
  });
});
