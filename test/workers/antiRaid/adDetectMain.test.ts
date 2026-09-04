import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "grammy/types";
import type { RemoveBlockedMembersParams } from "../../../packages/types/blocklist";
import type { ChatState } from "../../../packages/types/chatState";
import type { TelegramConfig } from "../../../packages/types/config";
import { botPermissions } from "../../helpers/botPermissions";
const chatStates = new Map<number, Record<string, unknown>>();
const activeVerificationSnapshots = new Map<string, unknown>();
const dispatched: RemoveBlockedMembersParams[][] = [];
const errorLogs: string[] = [];
const blockedIds = new Set<number>();
const temporaryWhitelistIds = new Set<number>();
const blockUser = mock((userId: number): boolean => blockedIds.has(userId) ? false : (blockedIds.add(userId), true));
const confirmBlocklistPersisted = mock(async (): Promise<boolean> => true);
const isUserBlocked = mock((userId: number): boolean => blockedIds.has(userId));
const diskMessages: unknown[] = [];
const postDiskIO = mock((message: unknown): boolean => (diskMessages.push(message), true));
const dispatchBlockedRemovals = mock(async (removals: readonly RemoveBlockedMembersParams[]): Promise<void> => {
  dispatched.push([...removals]);
});
let removalCounter: number = 0;
const resweepRequests: number[] = [];
const requestBlocklistResweep = mock((chatId: number): void => { resweepRequests.push(chatId); });
const trackBlockedRemoval = mock((params: Omit<RemoveBlockedMembersParams, "removalId">): RemoveBlockedMembersParams => ({
  ...params,
  removalId: ++removalCounter,
}));
/** 播报消息 id；真实 sendMessage 会把它同步交给 onSent，再作为返回值交出去。 */
const NOTICE_MESSAGE_ID: number = 555;
interface SendMessageMockParams {
  readonly chatId: number;
  readonly text: string;
  readonly onSent?: (messageId: number) => void;
}
/**
 * 复刻真实 sendMessage 的 onSent 契约：远端收下的同步时点先回调 onSent，
 * 之后才把 id 作为返回值交出。停机 abort 会吃掉返回值但吃不掉这次回调，
 * 因此删除 owner 只能挂在 onSent 上（见 infra/telegram/actions/core.ts）。
 */
const sendMessage = mock(async (params: SendMessageMockParams): Promise<number | undefined> => {
  params.onSent?.(NOTICE_MESSAGE_ID);
  return NOTICE_MESSAGE_ID;
});
const deleteMessageAfter = mock((..._args: unknown[]): void => {});
const clearTemporaryWhitelistActivity = mock((_id: number): boolean => true);
mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));
mock.module("../../../packages/config/telegram", () => ({
  SUPER_ADMIN_USER_ID: 1,
  getTelegramConfig: (): TelegramConfig => ({ botToken: "telegram-token", superAdminUserId: 1 }),
}));
// 1 是超级管理员：SQLite 没有其白名单记录，但由 packages/infra/identityPolicy/whitelist.ts
// 的读取边界直接算进白名单边界并持有全部权限，这里的 mock 照实模拟那层结论。
mock.module("../../../packages/infra/identityPolicy/whitelist", () => ({
  hasPermanentWhitelistPermission: (id: number, key: string): boolean =>
    id === 1 ||
    ((id === 100 || id === -200) && key === "isCanBypassFloodControl"),
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 1 ||
    ((id === 100 || id === -200 || temporaryWhitelistIds.has(id)) &&
      key === "isCanBypassAdDetection"),
  isWhitelisted: (id: number): boolean =>
    id === 1 || id === 100 || id === 101 || id === -200,
}));
mock.module("../../../packages/infra/telegram/actions", () => ({
  sendMessage,
  deleteMessageAfter,
}));
mock.module("../../../packages/infra/blocklist/membership", () => ({
  blockUser,
  confirmBlocklistPersisted,
  isUserBlocked,
}));
mock.module("../../../packages/infra/identityPolicy/temporaryWhitelist", () => ({
  clearTemporaryWhitelistActivity,
  hasActiveTemporaryWhitelist: (id: number): boolean =>
    temporaryWhitelistIds.has(id),
  hasActiveTemporaryWhitelistAt: (id: number): boolean => temporaryWhitelistIds.has(id),
  hydrateTemporaryWhitelistActivities: (): void => {},
  isTemporaryWhitelistActivityCached: (): boolean => true,
}));
mock.module("../../../packages/infra/blocklist/outbox", () => ({
  dispatchBlockedRemovals,
  trackBlockedRemoval,
}));
mock.module("../../../packages/infra/blocklist/sweep", () => ({ requestBlocklistResweep }));
mock.module("../../../packages/cache/main/antiRaid/verificationMirror", () => ({ activeVerificationSnapshots }));
mock.module("../../../packages/infra/diskIO", () => ({ postDiskIODiagnostic: postDiskIO }));
mock.module("../../../packages/infra/storage/stateStore", () => ({
  getChatStateCache: () => chatStates,
  getChatState: (chatId: number) => chatStates.get(chatId) ?? {},
}));
const { buildAdCandidate: buildAdCandidateFromContext } = await import(
  "../../../packages/antiRaid/adCandidate"
);
const { inFlightAdDisposals } = await import("../../../packages/cache/main/antiRaid/adDisposal");
const { blocklistIdentityMutationQueues } = await import("../../../packages/cache/main/blocklist");
const { inlineResultSources } = await import("../../../packages/cache/main/inlineResultSources");
const { recordInlineResultSources } = await import("../../../packages/infra/inlineResultSources");
const { markSelfSent } = await import("../../../packages/infra/selfSentTracker");
const { resetSelfSentTracker } = await import("../../../packages/cache/perThread/selfSentTracker");
const { blocklistEntryCache, whitelistEntryCache } =
  await import("../../../packages/cache/main/identityStorage");
function message(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 10,
    date: 0,
    chat: { id: -1001, type: "supergroup", title: "群" },
    from: { id: 7, is_bot: false, first_name: "Spammer", username: "spammer" },
    text: "加我微信",
    ...overrides,
  } as Message;
}
function buildAdCandidate(
  candidateMessage: Message,
  botId: number,
  chatState: Readonly<ChatState> = chatStates.get(candidateMessage.chat.id) ?? {}
): ReturnType<typeof buildAdCandidateFromContext> {
  return buildAdCandidateFromContext({
    message: candidateMessage, botId, chatState, now: Date.now(),
  });
}
beforeEach(() => {
  chatStates.clear();
  chatStates.set(-1001, {
    isAdDetectEnabled: true,
    isInitEnabled: true,
    botPermissions: botPermissions(),
  });
  activeVerificationSnapshots.clear();
  dispatched.length = 0;
  errorLogs.length = 0;
  removalCounter = 0;
  resweepRequests.length = 0;
  requestBlocklistResweep.mockClear();
  trackBlockedRemoval.mockClear();
  trackBlockedRemoval.mockImplementation((params: Omit<RemoveBlockedMembersParams, "removalId">): RemoveBlockedMembersParams => ({
    ...params,
    removalId: ++removalCounter,
  }));
  blockedIds.clear();
  temporaryWhitelistIds.clear();
  blocklistEntryCache.clear();
  whitelistEntryCache.clear();
  for (const id of [7, -300, -1005]) {
    blocklistEntryCache.set(id, null);
    whitelistEntryCache.set(id, null);
  }
  blockUser.mockClear();
  clearTemporaryWhitelistActivity.mockClear();
  confirmBlocklistPersisted.mockClear();
  confirmBlocklistPersisted.mockImplementation(async (): Promise<boolean> => true);
  isUserBlocked.mockClear();
  dispatchBlockedRemovals.mockClear();
  inFlightAdDisposals.clear();
  blocklistIdentityMutationQueues.clear();
  sendMessage.mockClear();
  sendMessage.mockImplementation(async (params: SendMessageMockParams): Promise<number | undefined> => {
    params.onSent?.(NOTICE_MESSAGE_ID);
    return NOTICE_MESSAGE_ID;
  });
  deleteMessageAfter.mockClear();
  diskMessages.length = 0;
  postDiskIO.mockClear();
  postDiskIO.mockImplementation((message: unknown): boolean => (diskMessages.push(message), true));
  resetSelfSentTracker();
  inlineResultSources.clear();
});

describe("广告检测投递门禁", () => {
  test("开了开关的群里的普通消息才生成待判定投递", () => {
    expect(buildAdCandidate(message(), 999)).toEqual({
      type: "adCandidate",
      chatId: -1001,
      senderId: 7,
      messageId: 10,
      text: "加我微信",
      label: "@spammer",
      meta: { firstName: "Spammer", lastName: "", username: "spammer" },
      isChannel: false,
      isForwarded: false,
      blocked: false,
      justJoined: false,
    });
    // 图片只看说明文字。
    expect(buildAdCandidate(message({ text: undefined, caption: "扫码进群" }), 999)?.text).toBe("扫码进群");
  });

  test("已进入临时白名单的成员回复、转发或引用广告都不生成候选", () => {
    temporaryWhitelistIds.add(7);

    expect(buildAdCandidate(message(), 999)).toBeUndefined();
    expect(buildAdCandidate(message({
      text: "看看",
      reply_to_message: {
        message_id: 9,
        date: 0,
        chat: { id: -1001, type: "supergroup", title: "群" },
        text: "日入过千 加V xxx996",
        reply_to_message: undefined,
      },
    }), 999)).toBeUndefined();
    expect(buildAdCandidate(message({
      forward_origin: {
        type: "user",
        date: 1,
        sender_user: { id: 8, is_bot: false, first_name: "Source" },
      },
    }), 999)).toBeUndefined();
    expect(buildAdCandidate(message({
      text: undefined,
      quote: { text: "日入过千 加V xxx996", position: 0, is_manual: true },
    }), 999)).toBeUndefined();
  });

  test("共享消息上下文里的群状态直接驱动门禁", () => {
    const expected: ReturnType<typeof buildAdCandidate> =
      buildAdCandidate(message(), 999);
    chatStates.clear();

    expect(buildAdCandidate(
      message(),
      999,
      { isAdDetectEnabled: true }
    )).toEqual(expected);
    expect(buildAdCandidate(message(), 999)).toBeUndefined();
  });

  test("没开开关、私聊、无正文与机器人自己的消息都不判定", () => {
    chatStates.set(-1002, {});
    expect(buildAdCandidate(message({ chat: { id: -1002, type: "supergroup", title: "群" } }), 999)).toBeUndefined();
    expect(buildAdCandidate(message({ chat: { id: 7, type: "private", first_name: "x" } }), 999)).toBeUndefined();
    expect(buildAdCandidate(message({ text: "   " }), 999)).toBeUndefined();
    expect(buildAdCandidate(message(), 7)).toBeUndefined();
  });

  test("自己人与拿本群当皮套的匿名管理员一律跳过", () => {
    // 名单不可逆：自己人连送进判定的机会都不该有（见 docs/cn/04-invariants.md）。
    expect(buildAdCandidate(message({ from: { id: 1, is_bot: false, first_name: "Super" } }), 999)).toBeUndefined();
    expect(buildAdCandidate(message({ from: { id: 100, is_bot: false, first_name: "Priv" } }), 999)).toBeUndefined();
    expect(buildAdCandidate(
      message({ sender_chat: { id: -1001, type: "supergroup", title: "群" } }),
      999
    )).toBeUndefined();
  });

  test("频道白名单可按频道 ID 绕过广告检测", () => {
    expect(buildAdCandidate(message({
      sender_chat: {
        id: -200,
        type: "channel",
        title: "Trusted Channel",
      },
    }), 999)).toBeUndefined();
  });

  test("永久白名单成员关闭广告豁免后仍进入检测", () => {
    const candidate = buildAdCandidate(message({
      from: { id: 101, is_bot: false, first_name: "Audited Member" },
    }), 999);
    expect(candidate?.senderId).toBe(101);
  });

  test("回复消息照常判定：正文在 message.text 里，回复关系不影响取值", () => {
    const candidate = buildAdCandidate(message({
      text: "加我微信",
      reply_to_message: { message_id: 9, date: 0, chat: { id: -1001, type: "supergroup", title: "群" }, reply_to_message: undefined },
      quote: { text: "别人说过的话", position: 0, is_manual: true },
    }), 999);
    expect(candidate?.text).toBe("加我微信");
  });

  test("被引用的原文与 text 分成两个字段跨线程传，但两样都参与判定", () => {
    // 分开传不是为了让判定读不到，而是因为接的时机不同：Worker 侧必须在正文按
    // AD_DETECT_MESSAGE_MAX_CHARS 截断之后再接（先拼后截等于零成本绕过），
    // 样本侧则要留一份没并进正文的原样。命中后的归因理由见 buildSampleContext。
    const candidate = buildAdCandidate(message({
      text: "这种广告真烦",
      quote: { text: "日入过千 加V xxx996", position: 0, is_manual: true },
      reply_to_message: {
        message_id: 9,
        date: 0,
        chat: { id: -1001, type: "supergroup", title: "群" },
        reply_to_message: undefined,
        text: "日入过千 加V xxx996",
      },
    }), 999);
    expect(candidate?.text).toBe("这种广告真烦");
    expect(candidate?.sampleContext).toEqual({
      quote: "日入过千 加V xxx996",
      replyTo: "日入过千 加V xxx996",
    });
  });

  test("回归用例：自己一个字都不打、只靠引用把编辑成广告的旧消息顶上来，照样送检", () => {
    // 只看 text 的话，不打字就能绕过去——而「编辑旧消息 + 回复/引用顶上来」
    // 正是当前最主流的广告形态。正文、URL、上下文三样全空才算没有可判定内容。
    const candidate = buildAdCandidate(message({
      text: undefined,
      quote: { text: "日入过千 加V xxx996", position: 0, is_manual: true },
    }), 999);
    expect(candidate?.text).toBe("");
    expect(candidate?.sampleContext).toEqual({ quote: "日入过千 加V xxx996" });
  });

  test("白名单来源的回复与引用不参与检测，但发送者自己的正文仍照常送检", () => {
    const repliedByWhitelist: NonNullable<Message["reply_to_message"]> = {
      message_id: 9,
      date: 0,
      chat: { id: -1001, type: "supergroup", title: "群" },
      // 101 的 isCanBypassAdDetection 被显式关掉，但它仍是白名单成员；来源豁免
      // 看成员边界，不看这项只约束「当前发言者」的权限。
      from: { id: 101, is_bot: false, first_name: "Trusted" },
      text: "日入过千 加V trusted",
      reply_to_message: undefined,
    };
    const candidate = buildAdCandidate(message({
      text: "这是我自己写的正文",
      quote: { text: "日入过千", position: 0, is_manual: true },
      reply_to_message: repliedByWhitelist,
    }), 999);

    expect(candidate?.text).toBe("这是我自己写的正文");
    expect(candidate?.sampleContext).toBeUndefined();
    expect(buildAdCandidate(message({
      text: undefined,
      quote: { text: "日入过千", position: 0, is_manual: true },
      reply_to_message: repliedByWhitelist,
    }), 999)).toBeUndefined();
    expect(buildAdCandidate(message({
      text: undefined,
      quote: { text: "日入过千", position: 0, is_manual: true },
      external_reply: {
        origin: {
          type: "user",
          date: 1,
          sender_user: { id: 101, is_bot: false, first_name: "Trusted" },
        },
      },
    }), 999)).toBeUndefined();
  });

  test("回复一条转发消息时按原作者判白名单，不按转发者判", () => {
    const candidate = buildAdCandidate(message({
      text: "看看这个",
      quote: { text: "日入过千", position: 0, is_manual: true },
      reply_to_message: {
        message_id: 9,
        date: 0,
        chat: { id: -1001, type: "supergroup", title: "群" },
        from: { id: 7, is_bot: false, first_name: "Reposter" },
        text: "日入过千 加V trusted",
        reply_to_message: undefined,
        forward_origin: {
          type: "user",
          date: 1,
          sender_user: { id: 100, is_bot: false, first_name: "Trusted" },
        },
      },
    }), 999);

    expect(candidate?.sampleContext).toBeUndefined();
  });

  test("白名单来源的手工转发整条跳过，非白名单与隐藏来源保留转发事实", () => {
    expect(buildAdCandidate(message({
      forward_origin: {
        type: "user",
        date: 1,
        sender_user: { id: 101, is_bot: false, first_name: "Trusted" },
      },
    }), 999)).toBeUndefined();

    expect(buildAdCandidate(message({
      forward_origin: {
        type: "channel",
        date: 1,
        chat: { id: -300, type: "channel", title: "Untrusted" },
        message_id: 1,
      },
    }), 999)).toMatchObject({ isForwarded: true, text: "加我微信" });
    expect(buildAdCandidate(message({
      forward_origin: {
        type: "hidden_user",
        date: 1,
        sender_user_name: "Hidden",
      },
    }), 999)).toMatchObject({ isForwarded: true });
  });

  test("来源身份预取失败时不把冷缺失误判成非白名单", () => {
    const repliedToColdSource: NonNullable<Message["reply_to_message"]> = {
      message_id: 9,
      date: 0,
      chat: { id: -1001, type: "supergroup", title: "群" },
      from: { id: 404, is_bot: false, first_name: "Unknown" },
      text: "日入过千 加V unknown",
      reply_to_message: undefined,
    };

    expect(buildAdCandidate(message({
      text: "发送者自己的正文",
      quote: { text: "日入过千", position: 0, is_manual: true },
      reply_to_message: repliedToColdSource,
    }), 999)).toMatchObject({
      text: "发送者自己的正文",
      sampleContext: undefined,
    });
    expect(buildAdCandidate(message({
      text: undefined,
      quote: { text: "日入过千", position: 0, is_manual: true },
      reply_to_message: repliedToColdSource,
    }), 999)).toBeUndefined();
    expect(buildAdCandidate(message({
      forward_origin: {
        type: "user",
        date: 1,
        sender_user: { id: 404, is_bot: false, first_name: "Unknown" },
      },
    }), 999)).toBeUndefined();
  });

  test("超链接背后的落地页与正文分开带，裸链接不重复", () => {
    // 可见文字可以完全无害，落点只在实体的 url 里；只读 text 的话，判定规则里
    // 最硬的那条「有没有把人带离本群」直接失效。URL 不拼进正文：Worker 侧按
    // 字数从头保留，拼在尾部的落地页正好是超长时被切掉的那一段。
    const linked = buildAdCandidate(message({
      text: "点这里",
      entities: [{ type: "text_link", offset: 0, length: 3, url: "https://t.me/spamchannel" }],
    }), 999);
    expect(linked?.text).toBe("点这里");
    expect(linked?.linkUrls).toEqual(["https://t.me/spamchannel"]);

    // 图片说明同样走 caption_entities。
    expect(buildAdCandidate(message({
      text: undefined,
      caption: "看这个",
      caption_entities: [{ type: "text_link", offset: 0, length: 3, url: "https://spam.example/a" }],
    }), 999)?.linkUrls).toEqual(["https://spam.example/a"]);

    // 正文里已经有的 URL 不再补一遍；非 text_link 实体也不产出内容。
    expect(buildAdCandidate(message({
      text: "看 https://t.me/x",
      entities: [
        { type: "url", offset: 2, length: 15 },
        { type: "text_link", offset: 0, length: 1, url: "https://t.me/x" },
      ],
    }), 999)?.linkUrls).toBeUndefined();
  });

  test("关联频道的自动转发与机器人自己的帖子回弹都不判定", () => {
    // 频道贴走 sender_chat，处置会在每个托管群 banChatSenderChat，把整个评论区
    // 连根拔掉；机器人自己发在频道里的帖回弹进来更是能把自己的频道拉黑。
    expect(buildAdCandidate(message({
      is_automatic_forward: true,
      sender_chat: { id: -1005, type: "channel", title: "关联频道" },
    }), 999)).toBeUndefined();
    markSelfSent(-1001, 10);
    expect(buildAdCandidate(message(), 999)).toBeUndefined();
  });

  test("本 bot 自己的 inline 结果一律按源文本判定，取不到源文本就不判", () => {
    // gag 落群正文由 renderGagSpeech 随机插点生成，正落在提示词「刻意变形」那条
    // 最强单项信号上，前缀那条隐藏主页 marker 又补上一个 t.me 落点；运势正文则是
    // 问候、抽签结果与防伪回执——两者都是本 bot 自己写的，送检的必须是应答那一刻
    // 登记下来的源文本。
    const gagSpeech = (overrides: Partial<Message> = {}): Message => message({
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）小. .. ..号. ...也有... . ..啊",
      entities: [{
        type: "text_link",
        offset: 0,
        length: 6,
        url: "https://t.me/spammer?profile#-1001",
      }],
      ...overrides,
    });
    recordInlineResultSources(7, "小号也有啊", [{
      type: "article",
      id: "gag--1001-7",
      title: "在 群 发言",
      input_message_content: {
        message_text: "（透过口塞）小. .. ..号. ...也有... . ..啊",
      },
    }]);
    const gagged = buildAdCandidate(gagSpeech(), 999);
    expect(gagged?.text).toBe("小号也有啊");
    expect(gagged?.messageId).toBe(10);
    expect(gagged?.senderId).toBe(7);
    expect(gagged?.linkUrls).toBeUndefined();

    // 运势结果同样只判用户写的所求事项，问候、抽签结果、防伪回执与那条回执
    // 链接都不进判定。
    const fortuneText: string =
      "你好，@spammer\n所求事项: 加我微信\n结果: 大吉\n防伪标记: 0123";
    recordInlineResultSources(7, "加我微信", [{
      type: "article",
      id: "luck-fortune-text",
      title: "未卜先知",
      input_message_content: { message_text: fortuneText },
    }]);
    const fortune = buildAdCandidate(message({
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: fortuneText,
      entities: [{
        type: "text_link",
        offset: 30,
        length: 4,
        url: "https://t.me/#luck-receipt=0123",
      }],
    }), 999);
    expect(fortune?.text).toBe("加我微信");
    expect(fortune?.linkUrls).toBeUndefined();

    // 正文对不上本次登记（客户端发的是上一次按键那条结果、或进程在发言之后
    // 重启）时整条不判：本 bot 的渲染结果一个字都不能送检。
    expect(buildAdCandidate(gagSpeech(), 999)).toBeUndefined();
    inlineResultSources.clear();
    expect(buildAdCandidate(message({
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: fortuneText,
    }), 999)).toBeUndefined();

    // 别的机器人的 inline 结果不是自己人：这条通道只对本 bot 的渲染结果生效，
    // 它照常按消息正文送检，落地页也照常补进去——广告最常见的形态之一就是借
    // 别人的 inline bot 发出来，绝不能跟着一起豁免。
    const otherBotMessage = (): Message => message({
      via_bot: { id: 1000, is_bot: true, first_name: "Other" },
      text: "点这里",
      entities: [{ type: "text_link", offset: 0, length: 3, url: "https://t.me/spamchannel" }],
    });
    const otherBot = buildAdCandidate(otherBotMessage(), 999);
    expect(otherBot?.text).toBe("点这里");
    expect(otherBot?.linkUrls).toEqual(["https://t.me/spamchannel"]);

    // 即使登记表里恰好有一条同样正文的源文本，别人的结果也不得改判成源文本。
    recordInlineResultSources(7, "换成这段就错了", [{
      type: "article",
      id: "gag--1001-7",
      title: "在 群 发言",
      input_message_content: { message_text: "点这里" },
    }]);
    expect(buildAdCandidate(otherBotMessage(), 999)?.text).toBe("点这里");
  });

  test("仍在入群验证窗口内时带上 justJoined 事实", () => {
    // 这条事实模型自己看不到（转录里没有入群时间），只能由主线程按待验证镜像喂。
    expect(buildAdCandidate(message(), 999)?.justJoined).toBe(false);
    activeVerificationSnapshots.set("-1001:7", {});
    expect(buildAdCandidate(message(), 999)?.justJoined).toBe(true);
  });

  test("已经在黑名单里的真人不再送检", () => {
    // 处置早就排上了，他还在说话只是因为封禁尚未落地；继续送检只会把额度烧在
    // 一个注定要被清出去的人身上，还会换来一次完全相同的处置。真人的封禁走
    // banChatMember，带 revoke_messages，这段空档里的消息会随封禁一起撤掉。
    blockedIds.add(7);
    expect(buildAdCandidate(message(), 999)).toBeUndefined();
  });

  test("已经在黑名单里的频道马甲照常投递，带着 blocked 交给判定线程删", () => {
    // 频道身份的封禁走 banChatSenderChat，那个接口没有 revoke_messages：在主线程
    // 就吞掉的话，它在封禁落地之前抢发的每一条广告都没有任何清理路径，会永久
    // 留在群里且没有任何日志。投递闸认得 blocked，会直接删掉而不进判定额度。
    blockedIds.add(-1005);
    const candidate = buildAdCandidate(
      message({ sender_chat: { id: -1005, type: "channel", title: "广告频道" } }),
      999
    );
    expect(candidate?.senderId).toBe(-1005);
    expect(candidate?.blocked).toBe(true);
  });

  test("已封频道转发白名单内容仍投递给 Worker 清理残留消息", () => {
    blockedIds.add(-1005);
    expect(buildAdCandidate(message({
      sender_chat: { id: -1005, type: "channel", title: "广告频道" },
      forward_origin: {
        type: "user",
        date: 1,
        sender_user: { id: 101, is_bot: false, first_name: "Trusted" },
      },
    }), 999)).toMatchObject({
      senderId: -1005,
      blocked: true,
      isForwarded: true,
    });
  });

  test("频道马甲发言按频道身份投递", () => {
    const candidate = buildAdCandidate(
      message({ sender_chat: { id: -1005, type: "channel", title: "广告频道" } }),
      999
    );
    expect(candidate?.senderId).toBe(-1005);
    expect(candidate?.isChannel).toBe(true);
    expect(candidate?.label).toBe("广告频道");
  });
});
