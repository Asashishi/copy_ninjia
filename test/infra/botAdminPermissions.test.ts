import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatMember, ChatMemberAdministrator } from "@grammyjs/types";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { settleBackgroundWork, settleTestBatch } from "../libs/helpers";
import { botPermissions } from "../helpers/botPermissions";

const states = new Map<number, Record<string, unknown>>();
/** 每一次后台落盘请求，供断言「清掉内存快照也把磁盘一起清了」。 */
const backgroundSaves: { chatId: number; context: string }[] = [];
const TEST_BOT_USER = { id: 99, is_bot: true, first_name: "Bot" } as const;

function adminMember(
  overrides: Partial<ChatMemberAdministrator> = {}
): ChatMemberAdministrator {
  return {
    status: "administrator",
    user: TEST_BOT_USER,
    can_be_edited: false,
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: false,
    can_manage_video_chats: false,
    can_restrict_members: false,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: false,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false,
    ...overrides,
  };
}

function completeMember(partial: Partial<ChatMember>): ChatMember {
  if (partial.status === "administrator") {
    return adminMember(partial as Partial<ChatMemberAdministrator>);
  }
  if (partial.status === "creator") {
    return { status: "creator", user: TEST_BOT_USER, is_anonymous: false };
  }
  if (partial.status === "kicked") {
    return { status: "kicked", user: TEST_BOT_USER, until_date: 0 };
  }
  if (partial.status === "left") return { status: "left", user: TEST_BOT_USER };
  return { status: "member", user: TEST_BOT_USER };
}

function statePermissions(chatId: number = CHAT_ID): BotChatPermissions | undefined {
  return states.get(chatId)?.botPermissions as BotChatPermissions | undefined;
}

function setStatePermissions(permissions: BotChatPermissions, chatId: number = CHAT_ID): void {
  const state: Record<string, unknown> = states.get(chatId) ?? { isInitEnabled: true };
  state.botPermissions = permissions;
  states.set(chatId, state);
}

let member: ChatMember = adminMember({ can_restrict_members: true });
let getChatMemberCalls: number = 0;
let getChatMemberFails: boolean = false;
let onGetChatMember: (() => void) | undefined;
/** 设成一个未完成的 Promise 就能把现查悬在途中，用来验证调用方没有被它挡住。 */
let getChatMemberGate: Promise<void> | undefined;

mock.module("../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../packages/infra/telegram/mainClient", () => ({
  bot: {
    botInfo: { id: 99 },
    api: {
      getChatMember: async (): Promise<ChatMember> => {
        getChatMemberCalls++;
        onGetChatMember?.();
        if (getChatMemberGate !== undefined) await getChatMemberGate;
        if (getChatMemberFails) throw new Error("telegram unavailable");
        return member;
      },
    },
  },
}));
mock.module("../../packages/infra/telegram/client", () => ({
  installTelegramApi: (): void => {},
  telegramApi: { kind: "guard-api" },
}));
// botAdmin -> blocklist 的新晋管理员补扫会取这三个；本文件名单为空，不触发。
mock.module("../../packages/infra/telegram/actions", () => ({
  isChatMember: async (): Promise<boolean> => false,
  banChatMember: async (): Promise<boolean> => true,
  banChatSenderChat: async (): Promise<boolean> => true,
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatStateCache: (): ReadonlyMap<number, Record<string, unknown>> => states,
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
  persistChatState: async (): Promise<void> => {},
  saveChatStateInBackground: (chatId: number, context: string): void => {
    backgroundSaves.push({ chatId, context });
  },
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
  botPermissionFetches,
  botPermissionObserver,
  botPermissionProbeBackoff,
  botPermissionRequestTokens,
} =
  await import("../../packages/cache/main/botAdmin");
const { BOT_PERMISSION_PROBE_RETRY_MS } = await import("../../packages/consts/botAdmin");

const CHAT_ID: number = -1001;
/** 观察者收到的每一次广播，供断言镜像内容与次数。 */
const broadcasts: { chatId: number; permissions: BotChatPermissions | undefined }[] = [];

beforeEach(() => {
  states.clear();
  states.set(CHAT_ID, { isInitEnabled: true });
  botPermissionFetches.clear();
  botPermissionProbeBackoff.clear();
  botPermissionRequestTokens.clear();
  botPermissionObserver.current = null;
  broadcasts.length = 0;
  backgroundSaves.length = 0;
  member = adminMember({ can_restrict_members: true });
  getChatMemberCalls = 0;
  getChatMemberFails = false;
  onGetChatMember = undefined;
  getChatMemberGate = undefined;
});

function observe(): void {
  registerBotPermissionObserver((chatId: number, permissions: BotChatPermissions | undefined): void => {
    broadcasts.push({ chatId, permissions });
  });
}

function myChatMemberContext(
  newMember: Partial<ChatMember>,
  oldStatus: ChatMember["status"] = "member"
): never {
  return {
    myChatMember: {
      chat: { id: CHAT_ID, type: "supergroup" },
      old_chat_member: completeMember({ status: oldStatus }),
      new_chat_member: completeMember(newMember),
    },
  } as never;
}

describe("机器人自身权限 State 快照", () => {
  test("同步删除权限读取保留 true/false/unknown 三态", () => {
    expect(botCanDeleteMessagesIn(CHAT_ID)).toBeUndefined();
    setStatePermissions(botPermissions({ canRestrictMembers: true }));
    expect(botCanDeleteMessagesIn(CHAT_ID)).toBeFalse();
    setStatePermissions(botPermissions({
      canRestrictMembers: true,
      canDeleteMessages: true,
    }));
    expect(botCanDeleteMessagesIn(CHAT_ID)).toBeTrue();
  });

  test("my_chat_member 落地后判定是纯内存命中，不打 getChatMember", async () => {
    await handleMyChatMemberUpdate(myChatMemberContext({
      status: "administrator",
      can_restrict_members: true,
      can_delete_messages: true,
    }));

    expect(await botChatPermissionsIn(CHAT_ID)).toEqual(botPermissions({
      canRestrictMembers: true,
      canDeleteMessages: true,
    }));
    expect(getChatMemberCalls).toBe(0);
  });

  test("群主恒为全真，普通管理员逐项看自己的开关", async () => {
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "creator" }));
    const ownerPermissions: BotChatPermissions = statePermissions()!;
    expect(ownerPermissions.isAdministrator).toBeTrue();
    expect(ownerPermissions.isAnonymous).toBeFalse();
    expect(Object.entries(ownerPermissions)
      .filter(([key]: [string, boolean]): boolean => key.startsWith("can"))
      .every(([, allowed]: [string, boolean]): boolean => allowed)).toBeTrue();

    // 仍是管理员、只是被取消了限制成员权限：这类改动同样以 my_chat_member 送达，
    // 缓存必须跟着降级，否则禁言/踢人会拿着一份作废的快照继续放行。
    await handleMyChatMemberUpdate(myChatMemberContext({
      status: "administrator",
      can_restrict_members: false,
      can_delete_messages: true,
    }, "administrator"));
    expect(statePermissions()).toEqual(botPermissions({ canDeleteMessages: true }));
  });

  test("撤管理员保留全 false 快照，被移出群聊才删掉群状态", async () => {
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "administrator", can_restrict_members: true }));
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "member" }, "administrator"));
    expect(statePermissions()).toEqual(botPermissions({
      isAdministrator: false,
      canManageChat: false,
    }));

    states.set(CHAT_ID, { isInitEnabled: true });
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "administrator", can_restrict_members: true }));
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "kicked" }, "administrator"));
    expect(statePermissions()).toBeUndefined();
  });

  test("收到别人的 chat_member 更新时，缺快照就现查完整权限", async () => {
    await markBotAdminObserved(CHAT_ID);
    expect(getChatMemberCalls).toBe(1);

    await settleBackgroundWork();
    expect(statePermissions()).toEqual(botPermissions({ canRestrictMembers: true }));
  });

  // 这条路径挂在入群洪流上，而 update runner 严格串行：一条 update 没跑完就不再
  // getUpdates。现查要付一次 getChatMember 往返加一次 durable 落盘，await 它等于让
  // 冷进程里刷群的第一条 chat_member 把整条 ingress 顶住。
  test("现查不再挡住调用方：getChatMember 悬在途中，markBotAdminObserved 照常返回", async () => {
    let releaseProbe: () => void = (): void => {};
    getChatMemberGate = new Promise((resolve: () => void): void => { releaseProbe = resolve; });

    await markBotAdminObserved(CHAT_ID);

    // 请求已经发出，但调用方没有等它，快照此刻仍是未知。
    expect(getChatMemberCalls).toBe(1);
    expect(statePermissions()).toBeUndefined();

    const pending: Promise<unknown> | undefined = botPermissionFetches.get(CHAT_ID);
    expect(pending).toBeDefined();
    releaseProbe();
    await pending;
    expect(statePermissions()).toEqual(botPermissions({ canRestrictMembers: true }));
  });

  // 这一路挂在入群洪流上：每个新成员一条 chat_member。现查失败时按约定不落任何
  // 快照，不设闸就等于按入群速率一条一条重发注定失败的请求。
  test("chat_member 这一路的现查同样过退避闸，一场刷屏不会换来逐条重查", async () => {
    getChatMemberFails = true;

    await markBotAdminObserved(CHAT_ID);
    expect(getChatMemberCalls).toBe(1);
    expect(botPermissionProbeBackoff.has(CHAT_ID)).toBeTrue();

    await markBotAdminObserved(CHAT_ID);
    await markBotAdminObserved(CHAT_ID);
    expect(getChatMemberCalls).toBe(1);

    // 窗口过去之后照常再试一次。
    botPermissionProbeBackoff.set(CHAT_ID, Date.now() - 1);
    getChatMemberFails = false;
    await markBotAdminObserved(CHAT_ID);
    expect(getChatMemberCalls).toBe(2);

    await settleBackgroundWork();
    expect(statePermissions()).toEqual(botPermissions({ canRestrictMembers: true }));
  });

  test("与事实冲突的陈旧快照只作废一次，随后的 chat_member 落进退避而不是逐条重查", async () => {
    setStatePermissions(botPermissions({ isAdministrator: false, canManageChat: false }));
    getChatMemberFails = true;

    await markBotAdminObserved(CHAT_ID);
    expect(getChatMemberCalls).toBe(1);
    expect(statePermissions()).toBeUndefined();

    await markBotAdminObserved(CHAT_ID);
    expect(getChatMemberCalls).toBe(1);
  });

  test("丢掉权限快照会把磁盘一起清掉——只清内存的话重启会读回一份已经作废的快照", () => {
    setStatePermissions(botPermissions({ canRestrictMembers: true }));

    forgetBotChatPermissions(CHAT_ID);

    expect(statePermissions()).toBeUndefined();
    expect(backgroundSaves).toEqual([{ chatId: CHAT_ID, context: "bot permissions forgotten" }]);

    // 没有已知值可丢时不写盘：teardown 路径会对同一个群反复调用。
    backgroundSaves.length = 0;
    forgetBotChatPermissions(CHAT_ID);
    expect(backgroundSaves).toHaveLength(0);
  });

  test("只改下游不读的权限位：快照照常刷新，但不再往 Worker mailbox 里塞一条相同的消息", async () => {
    observe();
    await handleMyChatMemberUpdate(myChatMemberContext({
      status: "administrator",
      can_restrict_members: true,
    }));
    expect(broadcasts).toHaveLength(1);

    await handleMyChatMemberUpdate(myChatMemberContext({
      status: "administrator",
      can_restrict_members: true,
      can_change_info: true,
    }, "administrator"));
    expect(statePermissions()?.canChangeInfo).toBeTrue();
    expect(broadcasts).toHaveLength(1);

    // 下游真正读的那两位变了才广播。
    await handleMyChatMemberUpdate(myChatMemberContext({
      status: "administrator",
      can_restrict_members: true,
      can_change_info: true,
      can_delete_messages: true,
    }, "administrator"));
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts.at(-1)?.permissions?.canDeleteMessages).toBeTrue();
  });

  test("从未记录过的群按需现查一次并回填，同群并发判定共享同一次请求", async () => {
    const [first, second]: (BotChatPermissions | undefined)[] = await settleTestBatch([
      botChatPermissionsIn(CHAT_ID),
      botChatPermissionsIn(CHAT_ID),
    ]);

    expect(getChatMemberCalls).toBe(1);
    expect(first).toEqual(botPermissions({ canRestrictMembers: true }));
    expect(second).toBe(first);
    // 回填之后就是纯内存命中了。
    expect(await botChatPermissionsIn(CHAT_ID)).toBe(first);
    expect(getChatMemberCalls).toBe(1);
  });

  test("现查失败保持未知，查回非管理员则落入完整全 false 快照", async () => {
    getChatMemberFails = true;
    expect(await botChatPermissionsIn(CHAT_ID)).toBeUndefined();
    expect(statePermissions()).toBeUndefined();

    getChatMemberFails = false;
    member = completeMember({ status: "member" });
    const nonAdmin: BotChatPermissions = botPermissions({
      isAdministrator: false,
      canManageChat: false,
    });
    expect(await botChatPermissionsIn(CHAT_ID)).toEqual(nonAdmin);
    expect(statePermissions()).toEqual(nonAdmin);
    expect(getChatMemberCalls).toBe(2);
  });

  test("现查在途期间被失效的结果不回填", async () => {
    onGetChatMember = (): void => { forgetBotChatPermissions(CHAT_ID); };
    expect(await botChatPermissionsIn(CHAT_ID)).toBeUndefined();
    expect(statePermissions()).toBeUndefined();

    // 作废只针对那一次在途请求，下一次照常重查并回填。
    onGetChatMember = undefined;
    expect(await botChatPermissionsIn(CHAT_ID)).toEqual(
      botPermissions({ canRestrictMembers: true })
    );
  });

  test("现查在途期间权威信号先落地时，采用权威值而不是用旧快照顶掉它", async () => {
    const authoritative: BotChatPermissions = botPermissions();
    onGetChatMember = (): void => { setStatePermissions(authoritative); };

    // 现查发出时看到的还是「能限制成员」，但 my_chat_member 已经把权限改动写进
    // 缓存了；这次响应描述的是它到达之前的旧身份，不能回填。
    expect(await botChatPermissionsIn(CHAT_ID)).toBe(authoritative);
    expect(statePermissions()).toBe(authoritative);
  });

  test("/init 开关切换会连权限位一起作废", async () => {
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "administrator", can_restrict_members: true }));
    expect(statePermissions()).toBeDefined();

    invalidateBotAdminStatus(CHAT_ID);
    expect(statePermissions()).toBeUndefined();
  });

  test("权限位变化广播给下游（Anti-Raid Worker 的镜像），逐位相同的观测不重复广播", async () => {
    observe();
    await handleMyChatMemberUpdate(myChatMemberContext({
      status: "administrator",
      can_restrict_members: true,
      can_delete_messages: true,
    }));
    const fullPermissions: BotChatPermissions = botPermissions({
      canRestrictMembers: true,
      canDeleteMessages: true,
    });
    expect(broadcasts).toEqual([
      { chatId: CHAT_ID, permissions: fullPermissions },
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
    expect(broadcasts[1]?.permissions).toEqual(botPermissions({ canDeleteMessages: true }));

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
    expect(statePermissions()).toEqual(botPermissions({ canRestrictMembers: true }));
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

  test("探测发现非管理员时写入全 false 快照，后续消息不再重查", async () => {
    member = completeMember({ status: "member" });

    ensureBotChatPermissions(CHAT_ID, 1_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(getChatMemberCalls).toBe(1);
    expect(botPermissionProbeBackoff.has(CHAT_ID)).toBeFalse();
    expect(statePermissions()).toEqual(botPermissions({
      isAdministrator: false,
      canManageChat: false,
    }));

    // State 快照命中，不依赖退避节流。
    ensureBotChatPermissions(CHAT_ID, 1_000);
    expect(getChatMemberCalls).toBe(1);
    ensureBotChatPermissions(CHAT_ID, 1_000 + BOT_PERMISSION_PROBE_RETRY_MS);
    expect(getChatMemberCalls).toBe(1);
  });

  test("没 /init enable 的群不留 State 条目，光是被拉进去不会增加管理群数", async () => {
    states.clear();
    await handleMyChatMemberUpdate(myChatMemberContext({ status: "administrator", can_restrict_members: true }));
    expect(states.size).toBe(0);

    // 现查这一路同样过这道门禁：结果照常返回给调用方，只是不留 State。
    expect(await botChatPermissionsIn(CHAT_ID)).toEqual(
      botPermissions({ canRestrictMembers: true })
    );
    expect(states.size).toBe(0);
  });
});
