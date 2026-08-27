import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "@grammyjs/types";
import type { AdDetectedEvent } from "../../../packages/types/antiRaid";
import type { RemoveBlockedMembersParams } from "../../../packages/types/blocklist";
import type { TelegramConfig } from "../../../packages/types/config";
import { botPermissions } from "../../helpers/botPermissions";

const chatStates = new Map<number, Record<string, unknown>>();
const activeVerificationSnapshots = new Map<string, unknown>();
const dispatched: RemoveBlockedMembersParams[][] = [];
const errorLogs: string[] = [];
const blockedIds = new Set<number>();
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
const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 555);
const deleteMessageAfter = mock((..._args: unknown[]): void => {});

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
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 1 || ((id === 100 || id === -200) && key === "isCanBypassAdDetection"),
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

const { buildAdCandidate } = await import("../../../packages/antiRaid/adCandidate");
const { drainAdDisposals, formatAdNotice, handleAdDetected } =
  await import("../../../packages/antiRaid/adDetect");
const { KICK_NOTICE_AUTO_DELETE_MS } = await import("../../../packages/consts/telegram");
const { inFlightAdDisposals } = await import("../../../packages/cache/main/antiRaid/adDisposal");
const { blocklistIdentityMutationQueues } = await import("../../../packages/cache/main/blocklist");
const { runBlocklistIdentityMutation } = await import("../../../packages/infra/identityPolicy/coordination");
const { inlineResultSources } = await import("../../../packages/cache/main/inlineResultSources");
const { recordInlineResultSources } = await import("../../../packages/infra/inlineResultSources");
const { markSelfSent } = await import("../../../packages/infra/selfSentTracker");
const { sentMessages } = await import("../../../packages/cache/perThread/selfSentTracker");
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

function detected(overrides: Partial<AdDetectedEvent> = {}): AdDetectedEvent {
  return {
    type: "adDetected",
    chatId: -1001,
    senderId: 7,
    isChannel: false,
    label: "@spammer",
    meta: { firstName: "Spammer", lastName: "", username: "spammer" },
    reason: "引流",
    messages: [{ messageId: 11, text: "加我微信", replyTo: "在吗", quote: "别人说过的话" }],
    ...overrides,
  };
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
  blocklistEntryCache.clear();
  whitelistEntryCache.clear();
  for (const id of [7, -300, -1005]) {
    blocklistEntryCache.set(id, null);
    whitelistEntryCache.set(id, null);
  }
  blockUser.mockClear();
  confirmBlocklistPersisted.mockClear();
  confirmBlocklistPersisted.mockImplementation(async (): Promise<boolean> => true);
  isUserBlocked.mockClear();
  dispatchBlockedRemovals.mockClear();
  inFlightAdDisposals.clear();
  blocklistIdentityMutationQueues.clear();
  sendMessage.mockClear();
  sendMessage.mockImplementation(async (): Promise<number | undefined> => 555);
  deleteMessageAfter.mockClear();
  diskMessages.length = 0;
  postDiskIO.mockClear();
  postDiskIO.mockImplementation((message: unknown): boolean => (diskMessages.push(message), true));
  for (const timer of sentMessages.values()) clearTimeout(timer);
  sentMessages.clear();
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

  test("调用方预读的群状态直接驱动门禁，旧的双参数调用仍自行查表", () => {
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

  test("关闭广告绕过权限的白名单成员仍可送检，但不会因此失去 protected 身份", () => {
    expect(buildAdCandidate(message({
      from: { id: 101, is_bot: false, first_name: "Audited Member" },
    }), 999)).toMatchObject({ senderId: 101 });
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

describe("广告判定命中后的处置", () => {
  test("按 /block 同样的动作：先写名单落盘，再给每个在管群登记一批封禁", async () => {
    chatStates.set(-1002, { isInitEnabled: true, botPermissions: botPermissions() });
    chatStates.set(-1003, {
      isInitEnabled: true,
      botPermissions: botPermissions({ isAdministrator: false, canManageChat: false }),
    });
    chatStates.set(-1004, { botPermissions: botPermissions() });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(blockUser).toHaveBeenCalledWith(7, {
      firstName: "Spammer",
      lastName: "",
      username: "spammer",
    });
    expect(confirmBlocklistPersisted).toHaveBeenCalledTimes(1);
    // 触发判定的群排最前：那里正躺着刚发出来的广告。未初始化或没有管理员
    // 身份的群不进清单——在那里封人本来就会失败。
    expect(dispatched[0]?.map((params) => params.chatId)).toEqual([-1001, -1002]);
    expect(dispatched[0]?.[0]).toMatchObject({ userIds: [7], probeMembership: false });
  });

  test("落盘失败留下可排查的错误日志", async () => {
    confirmBlocklistPersisted.mockImplementation(async (): Promise<boolean> => false);

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(errorLogs.some((line) => line.includes("memory-only"))).toBe(true);
    expect(dispatched).toHaveLength(1);
  });

  test("较晚的同身份解封等待广告处置完整结算，最终不会被旧封禁覆盖", async () => {
    let releasePersist: (() => void) | undefined;
    confirmBlocklistPersisted.mockImplementationOnce((): Promise<boolean> =>
      new Promise<boolean>((resolve: (value: boolean) => void): void => {
        releasePersist = (): void => resolve(true);
      }));

    handleAdDetected(detected());
    await Bun.sleep(0);
    expect(releasePersist).toBeFunction();

    let unblockStarted: boolean = false;
    const laterUnblock: Promise<void> = runBlocklistIdentityMutation(7, (): void => {
      unblockStarted = true;
      blockedIds.delete(7);
    });
    await Bun.sleep(0);

    // 广告处置持有同身份尾链；管理员的较晚解封不能先跑完，再被旧任务补封。
    expect(unblockStarted).toBeFalse();
    expect(trackBlockedRemoval).not.toHaveBeenCalled();

    releasePersist!();
    await drainAdDisposals(5_000);
    await laterUnblock;

    expect(dispatched).toHaveLength(1);
    expect(unblockStarted).toBeTrue();
    expect(blockedIds.has(7)).toBeFalse();
    expect(blocklistIdentityMutationQueues.size).toBe(0);
  });

  test("重复命中只补触发群一批封禁，不再重走整套落盘与各群登记", async () => {
    chatStates.set(-1002, { isInitEnabled: true, botPermissions: botPermissions() });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);
    expect(dispatched[0]?.map((params) => params.chatId)).toEqual([-1001, -1002]);
    expect(confirmBlocklistPersisted).toHaveBeenCalledTimes(1);

    // 封禁落地前这人又被判了一次：整套重来的代价是一次带 fsync 的名单落盘 +
    // 每个在管群各一批封禁（每批都要整份 outbox 落盘），按群数放大成 O(n²)。
    handleAdDetected(detected());
    await drainAdDisposals(5_000);
    expect(confirmBlocklistPersisted).toHaveBeenCalledTimes(1);
    expect(dispatched[1]?.map((params) => params.chatId)).toEqual([-1001]);
  });

  test("重复命中时若触发群已停管，则一批都不登记", async () => {
    handleAdDetected(detected());
    await drainAdDisposals(5_000);
    expect(dispatched).toHaveLength(1);

    chatStates.set(-1001, {
      isAdDetectEnabled: true,
      isInitEnabled: true,
      botPermissions: botPermissions({ isAdministrator: false, canManageChat: false }),
    });
    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(dispatched).toHaveLength(1);
    expect(errorLogs.some((line) => line.includes("no chat to enforce"))).toBe(true);
  });

  test("某个群登记失败只作废那个群：其余群照常封，失败的群改欠一次补扫", async () => {
    chatStates.set(-1002, { isInitEnabled: true, botPermissions: botPermissions() });
    chatStates.set(-1003, { isInitEnabled: true, botPermissions: botPermissions() });
    // outbox 满：登记在第二个群上抛出。整段用 map 的话这一抛会让已登记的第一
    // 批留在 outbox 里而 dispatchBlockedRemovals 一次都调不到，这个刷屏号在
    // 所有群都封不掉。
    trackBlockedRemoval.mockImplementation(
      (params: Omit<RemoveBlockedMembersParams, "removalId">): RemoveBlockedMembersParams => {
        if (params.chatId === -1002) throw new Error("Blocklist removal outbox reached its capacity.");
        return { ...params, removalId: ++removalCounter };
      }
    );

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(dispatched[0]?.map((params) => params.chatId)).toEqual([-1001, -1003]);
    expect(resweepRequests).toEqual([-1002]);
    expect(errorLogs.some((line) => line.includes("owe a resweep"))).toBe(true);
  });

  test("每个群都登记失败时不投空批次，且每个群都欠上补扫", async () => {
    chatStates.set(-1002, { isInitEnabled: true, botPermissions: botPermissions() });
    trackBlockedRemoval.mockImplementation((): RemoveBlockedMembersParams => {
      throw new Error("Blocklist removal outbox reached its capacity.");
    });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(dispatched).toHaveLength(0);
    expect(resweepRequests).toEqual([-1001, -1002]);
    expect(errorLogs.some((line) => line.includes("no chat to enforce"))).toBe(true);
  });

  test("播报发在触发的群里，带展示标签与理由，30 秒后自撤", async () => {
    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    const notice = sendMessage.mock.calls[0]?.[0] as { chatId: number; text: string };
    expect(notice.chatId).toBe(-1001);
    expect(notice.text).toContain("@spammer");
    expect(notice.text).toContain("引流");
    expect(notice.text).toContain("在所有盯着的群里一起封掉了");
    expect(deleteMessageAfter).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1001,
      messageId: 555,
      delayMs: KICK_NOTICE_AUTO_DELETE_MS,
    }));
  });

  test("一个群都没登记上时改口点名管理员，绝不宣称已经到处封了", async () => {
    trackBlockedRemoval.mockImplementation((): RemoveBlockedMembersParams => {
      throw new Error("Blocklist removal outbox reached its capacity.");
    });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    const notice = sendMessage.mock.calls[0]?.[0] as { text: string };
    // 人根本没被踢走，说「在所有盯着的群里一起封掉了」就是一条与事实相反的公告。
    expect(notice.text).not.toContain("在所有盯着的群里一起封掉了");
    expect(notice.text).toContain("一个群都封不动");
  });

  test("模型没给理由时播报用兜底文案，不留空", () => {
    expect(formatAdNotice({ label: "@spammer", reason: "", enforcedChats: 2, failedChats: 0 }))
      .toContain("整串消息通篇都是推广引流");
    expect(formatAdNotice({ label: "@spammer", reason: "卖号", enforcedChats: 2, failedChats: 0 }))
      .toContain("理由：卖号");
  });

  test("部分群登记失败时只报封上的群数，不说「在所有盯着的群里」", () => {
    // 那些登记失败的群里人还坐着，说「所有」同样是假话。
    const notice: string = formatAdNotice({
      label: "@spammer",
      reason: "卖号",
      enforcedChats: 3,
      failedChats: 2,
    });
    expect(notice).not.toContain("在所有盯着的群里一起封掉了");
    expect(notice).toContain("在 3 个群封掉了");
    expect(notice).toContain("2 个群没封动");
  });

  test("回归用例：播报不断言删消息——删除跑在判定线程上、排在事件回投之后，" +
    "主线程根本不知道它成没成，机器人也可能压根没有 can_delete_messages", () => {
    // 只说这边确证得了的两件事：记进名单、封了几个群。
    for (const enforcedChats of [0, 2]) {
      const notice: string = formatAdNotice({
        label: "@spammer",
        reason: "卖号",
        enforcedChats,
        failedChats: 0,
      });
      expect(notice).not.toContain("删干净");
      expect(notice).toContain("记进小本本");
    }
  });

  test("播报发送失败时不安排删除", async () => {
    sendMessage.mockImplementation(async (): Promise<number | undefined> => undefined);

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(deleteMessageAfter).not.toHaveBeenCalled();
  });

  test("自己人即使被判成广告也不处置", async () => {
    handleAdDetected(detected({ senderId: 100 }));
    await drainAdDisposals(5_000);

    expect(blockUser).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
    expect(errorLogs.some((line) => line.includes("protected sender"))).toBe(true);
  });

  test("白名单关闭广告绕过权限后即使命中，也不得写入永久黑名单", async () => {
    handleAdDetected(detected({ senderId: 101 }));
    await drainAdDisposals(5_000);

    expect(blockUser).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
    expect(diskMessages).toHaveLength(0);
    expect(errorLogs.some((line) => line.includes("protected sender 101"))).toBe(true);
  });

  test("处置排到写名单之前 /ad_detect disable 已经生效时，整条判定丢掉", async () => {
    // 事件回调是同步的，而处置要先排过 identity 串行队列才轮到写名单——这中间
    // 正好够管理员那条 /ad_detect disable 落地。clearAdDetection 只清得掉判定
    // 线程里还没判的队列，够不到一条已经发布出来的判定，所以这道复查必须在
    // 主线程这边（见 antiRaid/adDetect.ts）。
    handleAdDetected(detected());
    chatStates.set(-1001, {
      isAdDetectEnabled: false,
      isInitEnabled: true,
      botPermissions: botPermissions(),
    });
    await drainAdDisposals(5_000);

    expect(blockUser).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
    expect(diskMessages).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();
    // 这是预期内的竞态结局，不是错误：不该占用 protected sender 那条告警。
    expect(errorLogs.some((line) => line.includes("protected sender"))).toBeFalse();
  });

  test("一个可执行的群都没有时只留名单与日志，不投空批次", async () => {
    chatStates.set(-1001, {
      isAdDetectEnabled: true,
      isInitEnabled: true,
      botPermissions: botPermissions({ isAdministrator: false, canManageChat: false }),
    });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(blockUser).toHaveBeenCalledWith(7, expect.objectContaining({ username: "spammer" }));
    expect(dispatched).toHaveLength(0);
    expect(errorLogs.some((line) => line.includes("no chat to enforce"))).toBe(true);
  });

  test("命中即写一条旁路样本，含时间、消息、理由与引用/回复上下文", async () => {
    // 判定规则由提示词定死，题材口径全靠 config/ad_samples.json 的示例，而示例
    // 只能从真实命中里攒——这条旁路就是那份原始素材。
    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(diskMessages).toEqual([{
      type: "adSample",
      chatId: -1001,
      senderId: 7,
      label: "@spammer",
      detectedAt: expect.any(String),
      reason: "引流",
      messages: [{ messageId: 11, text: "加我微信", replyTo: "在吗", quote: "别人说过的话" }],
    }]);
  });

  test("样本投递失败不影响封禁本身：只记一行日志", async () => {
    // 纯旁路：丢了不影响任何运行时状态，绝不该反过来拖住不可丢的那一半。
    postDiskIO.mockImplementation((): boolean => false);

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(errorLogs.some((line) => line.includes("Failed to queue the ad detection sample"))).toBe(true);
    expect(blockUser).toHaveBeenCalledWith(7, expect.objectContaining({ username: "spammer" }));
    expect(dispatched).toHaveLength(1);
  });

  test("自己人被判成广告时连样本都不写：那是模型错了，不是素材", async () => {
    handleAdDetected(detected({ senderId: 100 }));
    await drainAdDisposals(5_000);
    expect(diskMessages).toHaveLength(0);
  });

  test("排空受预算约束：预算为 0 时立刻结算成 timedOut，不拖到强制退出线", async () => {
    // 异常退出路径把全部预算设成 0（EMERGENCY_FLUSH_TIMEOUTS）。裸等的话，处置内部
    // 的落盘确认与 outbox 屏障会把停机一路拖到 15 秒强制退出：进程带非零码死在
    // 半路，实例锁不释放、offset 不确认。
    let release: (() => void) | undefined;
    dispatchBlockedRemovals.mockImplementationOnce((): Promise<void> =>
      new Promise<void>((resolve) => { release = resolve; }));

    handleAdDetected(detected());
    expect(await drainAdDisposals(0)).toBe("timedOut");
    expect(inFlightAdDisposals.size).toBe(1);

    // protected-identity 串行边界与落盘确认各让步一次；零预算 drain 本身不会
    // 等这些 microtask，先让处置推进到故意悬挂的投递点再释放。
    await Bun.sleep(0);
    expect(release).toBeFunction();
    release!();
    expect(await drainAdDisposals(5_000)).toBe("flushed");
    expect(inFlightAdDisposals.size).toBe(0);
  });

  test("投递失败不上抛，处置任务照样从在途集合里摘掉", async () => {
    dispatchBlockedRemovals.mockImplementationOnce(async (): Promise<void> => {
      throw new Error("worker unavailable");
    });

    handleAdDetected(detected());
    expect(inFlightAdDisposals.size).toBe(1);
    await drainAdDisposals(5_000);

    expect(inFlightAdDisposals.size).toBe(0);
    expect(errorLogs.some((line) => line.includes("Failed to dispose the ad verdict"))).toBe(true);
  });
});
