import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "@grammyjs/types";
import type { AdDetectedEvent } from "../../../packages/types/antiRaid";
import type { RemoveBlockedMembersParams } from "../../../packages/types/blocklist";

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
mock.module("../../../packages/infra/config", () => ({
  AD_DETECT_DEEPSEEK_API_KEY: "test-deepseek-key",
  SUPER_ADMIN_USER_ID: 1,
}));
mock.module("../../../packages/config/whitelist", () => ({
  hasWhitelistPermission: (id: number, key: string): boolean =>
    (id === 100 || id === -200) && key === "isCanBypassAdDetection",
  isWhitelisted: (id: number): boolean => id === 100 || id === 101 || id === -200,
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
  getAllChatStates: () => chatStates,
  getChatState: (chatId: number) => chatStates.get(chatId) ?? {},
}));

const { buildAdCandidate } = await import("../../../packages/antiRaid/adCandidate");
const { drainAdDisposals, formatAdNotice, handleAdDetected } =
  await import("../../../packages/antiRaid/adDetect");
const { KICK_NOTICE_AUTO_DELETE_MS } = await import("../../../packages/consts/telegram");
const { inFlightAdDisposals } = await import("../../../packages/cache/main/antiRaid/adDisposal");
const { markSelfSent } = await import("../../../packages/infra/selfSentTracker");
const { sentMessages } = await import("../../../packages/cache/perThread/selfSentTracker");

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
    reason: "引流",
    messages: [{ messageId: 11, text: "加我微信", replyTo: "在吗", quote: "别人说过的话" }],
    ...overrides,
  };
}

beforeEach(() => {
  chatStates.clear();
  chatStates.set(-1001, { isAdDetectEnabled: true, isInitEnabled: true, botIsAdmin: true });
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
  blockUser.mockClear();
  confirmBlocklistPersisted.mockClear();
  confirmBlocklistPersisted.mockImplementation(async (): Promise<boolean> => true);
  isUserBlocked.mockClear();
  dispatchBlockedRemovals.mockClear();
  inFlightAdDisposals.clear();
  sendMessage.mockClear();
  sendMessage.mockImplementation(async (): Promise<number | undefined> => 555);
  deleteMessageAfter.mockClear();
  diskMessages.length = 0;
  postDiskIO.mockClear();
  postDiskIO.mockImplementation((message: unknown): boolean => (diskMessages.push(message), true));
  for (const timer of sentMessages.values()) clearTimeout(timer);
  sentMessages.clear();
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
      isChannel: false,
      blocked: false,
      justJoined: false,
    });
    // 图片只看说明文字。
    expect(buildAdCandidate(message({ text: undefined, caption: "扫码进群" }), 999)?.text).toBe("扫码进群");
  });

  test("没开开关、私聊、无正文与机器人自己的消息都不判定", () => {
    chatStates.set(-1002, {});
    expect(buildAdCandidate(message({ chat: { id: -1002, type: "supergroup", title: "群" } }), 999)).toBeUndefined();
    expect(buildAdCandidate(message({ chat: { id: 7, type: "private", first_name: "x" } }), 999)).toBeUndefined();
    expect(buildAdCandidate(message({ text: "   " }), 999)).toBeUndefined();
    expect(buildAdCandidate(message(), 7)).toBeUndefined();
  });

  test("自己人与拿本群当皮套的匿名管理员一律跳过", () => {
    // 名单不可逆：自己人连送进判定的机会都不该有（见 docs/04-invariants.md）。
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
    // 样本侧则要留一份没并进正文的原样。连坐的理由见 buildSampleContext。
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
    chatStates.set(-1002, { isInitEnabled: true, botIsAdmin: true });
    chatStates.set(-1003, { isInitEnabled: true, botIsAdmin: false });
    chatStates.set(-1004, { botIsAdmin: true });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(blockUser).toHaveBeenCalledWith(7);
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

  test("重复命中只补触发群一批封禁，不再重走整套落盘与各群登记", async () => {
    chatStates.set(-1002, { isInitEnabled: true, botIsAdmin: true });

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

    chatStates.set(-1001, { isAdDetectEnabled: true, isInitEnabled: true, botIsAdmin: false });
    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(dispatched).toHaveLength(1);
    expect(errorLogs.some((line) => line.includes("no chat to enforce"))).toBe(true);
  });

  test("某个群登记失败只作废那个群：其余群照常封，失败的群改欠一次补扫", async () => {
    chatStates.set(-1002, { isInitEnabled: true, botIsAdmin: true });
    chatStates.set(-1003, { isInitEnabled: true, botIsAdmin: true });
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
    chatStates.set(-1002, { isInitEnabled: true, botIsAdmin: true });
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

  test("一个可执行的群都没有时只留名单与日志，不投空批次", async () => {
    chatStates.set(-1001, { isAdDetectEnabled: true, isInitEnabled: true, botIsAdmin: false });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(blockUser).toHaveBeenCalledWith(7);
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
    expect(blockUser).toHaveBeenCalledWith(7);
    expect(dispatched).toHaveLength(1);
  });

  test("自己人被判成广告时连样本都不写：那是模型错了，不是素材", async () => {
    handleAdDetected(detected({ senderId: 100 }));
    await drainAdDisposals(5_000);
    expect(diskMessages).toHaveLength(0);
  });

  test("排空受预算约束：预算为 0 时立刻结算成 timedOut，不拖到强制退出线", async () => {
    // 异常退出路径把全部预算设成 0（FATAL_FLUSH_TIMEOUTS）。裸等的话，处置内部
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
