import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanReply, isEmojiOnly } from "../../../packages/aiChat/ai/utils/replyText";
import { buildCharacterTypo, pickTypoCorrectionMode } from "../../../packages/aiChat/ai/utils/typo";
import type { TelegramSendResult } from "../../../packages/types/telegram";

let nextMessageId: number = 100;
const sendMessageMock = mock(async (
  params: { replyToMessageId?: number }
): Promise<TelegramSendResult | undefined> => ({
  messageId: nextMessageId++,
  ...(params.replyToMessageId !== undefined ? { repliedToMessageId: params.replyToMessageId } : {}),
}));
const deleteMessageMock = mock(async (..._args: unknown[]): Promise<boolean> => true);
const setMessageReactionMock = mock(async (..._args: unknown[]): Promise<boolean> => true);
const sendStickerMock = mock(async (..._args: unknown[]): Promise<number | undefined> => nextMessageId++);
const sleepMock = mock(async (..._args: unknown[]): Promise<void> => {});
const realTelegram = await import("../../../packages/infra/telegram");

mock.module("../../../packages/infra/telegram", () => ({
  ...realTelegram,
  telegramApi: { getStickerSet: mock(async (): Promise<null> => null) },
  sendMessageWithResult: sendMessageMock,
  deleteMessage: deleteMessageMock,
  setMessageReaction: setMessageReactionMock,
  sendChooseStickerAction: mock(async (): Promise<boolean> => true),
  sendTypingAction: mock(async (): Promise<boolean> => true),
  sendUploadPhotoAction: mock(async (): Promise<boolean> => true),
  sendSticker: sendStickerMock,
}));

mock.module("../../../packages/libs/sleep", () => ({
  sleep: sleepMock,
}));

const {
  ADD_REACTION_TOOL,
  GROUP_QA_ANSWER_TOOL,
  GROUP_QA_QUERY_TOOL,
  SEND_MESSAGE_TOOL,
} = await import("../../../packages/consts/tools");
const { AI_MAX_ACTIONS_PER_REPLY, HARD_MAX_ACTIONS_PER_REPLY } = await import("../../../packages/consts/aiChat/tools");
const { REPLY_ACTION_INSTRUCTION, SEND_MESSAGE_TOOL_INSTRUCTION } = await import("../../../packages/consts/aiChat/prompts/tools");
const { createReplyToolset } = await import("../../../packages/aiChat/ai/tools/replyToolset/orchestrator");
const { SEND_STICKER_TOOL, VIEW_STICKER_PACK_TOOL } = await import("../../../packages/consts/tools");
const { stickerMenuCache, stickerMenuRevision } =
  await import("../../../packages/cache/workers/aiChat/stickers/menu");

beforeEach(() => {
  nextMessageId = 100;
  sendMessageMock.mockClear();
  deleteMessageMock.mockClear();
  setMessageReactionMock.mockClear();
  setMessageReactionMock.mockImplementation(async (): Promise<boolean> => true);
  sendStickerMock.mockClear();
  sleepMock.mockClear();
});

test("工具集真实挂载服务端联网检索，并同时提供函数行动工具", async () => {
  const toolset = await createReplyToolset({
    chatId: -100800,
    replyToMessageId: 10,
    messageThreadId: undefined,
    mediaToolsRequested: true,
    bypassMediaToolCooldown: false,
    chatAction: {
      current: () => "idle",
      set: mock((..._args: unknown[]): void => {}),
      settle: mock(async (): Promise<void> => {}),
    },
    stickerLock: { tryAcquire: () => true, release: () => {} },
    roundHasTypo: false,
    isActive: () => true,
    onMessageSent: mock((..._args: unknown[]): void => {}),
    onStickerSent: mock((..._args: unknown[]): void => {}),
    onImageSent: mock((..._args: unknown[]): void => {}),
    onSongSent: mock((..._args: unknown[]): void => {}),
  });

  expect(toolset.webSearch).toBe(true);
  expect(toolset.functions.length).toBeGreaterThan(0);
  expect(toolset.has("delete_own_message")).toBe(false);
});

describe("add_reaction 成功动作计数", () => {
  function buildContext() {
    return {
      chatId: -100800,
      replyToMessageId: 10,
      messageThreadId: undefined,
      mediaToolsRequested: true,
      bypassMediaToolCooldown: false,
      chatAction: {
        current: () => "idle" as const,
        set: mock((..._args: unknown[]): void => {}),
        settle: mock(async (): Promise<void> => {}),
      },
      stickerLock: { tryAcquire: () => true, release: () => {} },
      roundHasTypo: false,
      isActive: () => true,
      onMessageSent: mock((..._args: unknown[]): void => {}),
      onStickerSent: mock((..._args: unknown[]): void => {}),
      onImageSent: mock((..._args: unknown[]): void => {}),
      onSongSent: mock((..._args: unknown[]): void => {}),
    };
  }

  test("Telegram 反应成功后才返回成功并占用一个动作", async () => {
    const toolset = await createReplyToolset(buildContext());

    const result = JSON.parse(await toolset.execute(ADD_REACTION_TOOL, JSON.stringify({ emoji: "👍" })));

    expect(result).toEqual({ success: true });
    expect(setMessageReactionMock).toHaveBeenCalledWith({ chatId: -100800, messageId: 10, emoji: "👍" });
    expect(toolset.actionsUsed()).toBe(1);
  });

  test("Telegram 反应失败不占动作，也不消耗成功反应限额", async () => {
    setMessageReactionMock
      .mockImplementationOnce(async (): Promise<boolean> => false)
      .mockImplementationOnce(async (): Promise<boolean> => true);
    const toolset = await createReplyToolset(buildContext());

    const failed = JSON.parse(await toolset.execute(ADD_REACTION_TOOL, JSON.stringify({ emoji: "👍" })));
    expect(failed.error).toContain("Failed to set reaction");
    expect(toolset.actionsUsed()).toBe(0);

    const retried = JSON.parse(await toolset.execute(ADD_REACTION_TOOL, JSON.stringify({ emoji: "👍" })));
    expect(retried).toEqual({ success: true });
    expect(setMessageReactionMock).toHaveBeenCalledTimes(2);
    expect(toolset.actionsUsed()).toBe(1);
  });
});

test("回复提示把独立文字限死在 send_message，媒体配文走对应 caption，最终响应不得夹带正文", () => {
  expect(SEND_MESSAGE_TOOL_INSTRUCTION).toContain("主回复、贴纸说明、动作之后的补充文字都必须显式调用");
  expect(REPLY_ACTION_INSTRUCTION).toContain("独立文字只用 send_message");
  // 媒体配文必须随对应动作落地，不能再用 send_message 复述或留进最终正文。
  expect(SEND_MESSAGE_TOOL_INSTRUCTION).toContain("写进 generate_image 的 caption");
  expect(REPLY_ACTION_INSTRUCTION).toContain("随附文字写进对应工具的 caption，不要再复述");
  expect(REPLY_ACTION_INSTRUCTION).toContain("最终响应保持空白");
});

test("模型提示限制为 8 个动作，执行侧留余量到 11 个动作才触发硬顶", async () => {
  expect(AI_MAX_ACTIONS_PER_REPLY).toBe(8);
  expect(HARD_MAX_ACTIONS_PER_REPLY).toBe(11);
  expect(REPLY_ACTION_INSTRUCTION).toContain(`最多 ${AI_MAX_ACTIONS_PER_REPLY} 个`);
  expect(REPLY_ACTION_INSTRUCTION).not.toContain(`最多 ${HARD_MAX_ACTIONS_PER_REPLY} 个`);

  const toolset = await createReplyToolset({
    chatId: -100800,
    replyToMessageId: 10,
    messageThreadId: undefined,
    mediaToolsRequested: false,
    bypassMediaToolCooldown: false,
    chatAction: {
      current: () => "idle",
      set: mock((..._args: unknown[]): void => {}),
      settle: mock(async (): Promise<void> => {}),
    },
    stickerLock: { tryAcquire: () => true, release: () => {} },
    roundHasTypo: false,
    isActive: () => true,
    onMessageSent: mock((..._args: unknown[]): void => {}),
    onStickerSent: mock((..._args: unknown[]): void => {}),
    onImageSent: mock((..._args: unknown[]): void => {}),
    onSongSent: mock((..._args: unknown[]): void => {}),
  });

  for (let action: number = 1; action <= HARD_MAX_ACTIONS_PER_REPLY; action++) {
    const result = JSON.parse(await toolset.execute(
      SEND_MESSAGE_TOOL,
      JSON.stringify({ text: `第 ${action} 个动作` })
    ));
    expect(result.success).toBe(true);
  }
  const overflow = JSON.parse(await toolset.execute(
    SEND_MESSAGE_TOOL,
    JSON.stringify({ text: "第 12 个动作" })
  ));

  expect(toolset.actionsUsed()).toBe(HARD_MAX_ACTIONS_PER_REPLY);
  expect(overflow.error).toContain(`at most ${HARD_MAX_ACTIONS_PER_REPLY} actions`);
  expect(sendMessageMock).toHaveBeenCalledTimes(HARD_MAX_ACTIONS_PER_REPLY);
});

test("reply_to_trigger 请求退化为普通发送时，自录回调不伪造回复关系", async () => {
  sendMessageMock.mockImplementationOnce(async (): Promise<TelegramSendResult> => ({ messageId: 100 }));
  const onMessageSent = mock((..._args: unknown[]): void => {});
  const toolset = await createReplyToolset({
    chatId: -100800,
    replyToMessageId: 10,
    messageThreadId: undefined,
    mediaToolsRequested: false,
    bypassMediaToolCooldown: false,
    chatAction: {
      current: () => "idle",
      set: mock((..._args: unknown[]): void => {}),
      settle: mock(async (): Promise<void> => {}),
    },
    stickerLock: { tryAcquire: () => true, release: () => {} },
    roundHasTypo: false,
    isActive: () => true,
    onMessageSent,
    onStickerSent: mock((..._args: unknown[]): void => {}),
    onImageSent: mock((..._args: unknown[]): void => {}),
    onSongSent: mock((..._args: unknown[]): void => {}),
  });

  const result = JSON.parse(await toolset.execute(
    SEND_MESSAGE_TOOL,
    JSON.stringify({ text: "目标已删除也照常发", reply_to_trigger: true })
  ));

  expect(result.success).toBe(true);
  expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -100800, text: "目标已删除也照常发", replyToMessageId: 10 });
  expect(onMessageSent).toHaveBeenCalledWith("目标已删除也照常发", 100, undefined);
});

test("话题群：reply_to_trigger=false 的正文照样带上本轮话题，不掉进 General", async () => {
  // 话题群里唯一带路的东西是 reply_parameters；模型选择不挂回复（随机插话恒是
  // 这一路）时，缺了 message_thread_id 这条就落进 General。
  sendMessageMock.mockImplementationOnce(async (): Promise<TelegramSendResult> => ({ messageId: 101 }));
  const toolset = await createReplyToolset({
    chatId: -100800,
    replyToMessageId: 10,
    messageThreadId: 77,
    mediaToolsRequested: false,
    bypassMediaToolCooldown: false,
    chatAction: {
      current: () => "idle",
      set: mock((..._args: unknown[]): void => {}),
      settle: mock(async (): Promise<void> => {}),
    },
    stickerLock: { tryAcquire: () => true, release: () => {} },
    roundHasTypo: false,
    isActive: () => true,
    onMessageSent: mock((..._args: unknown[]): void => {}),
    onStickerSent: mock((..._args: unknown[]): void => {}),
    onImageSent: mock((..._args: unknown[]): void => {}),
    onSongSent: mock((..._args: unknown[]): void => {}),
  });

  const result = JSON.parse(await toolset.execute(
    SEND_MESSAGE_TOOL,
    JSON.stringify({ text: "本天才自己插一句", reply_to_trigger: false })
  ));

  expect(result.success).toBe(true);
  expect(sendMessageMock).toHaveBeenCalledWith({
    chatId: -100800,
    text: "本天才自己插一句",
    replyToMessageId: undefined,
    messageThreadId: 77,
  });
});

describe("isEmojiOnly", () => {
  test("纯 emoji（含多枚、空白、肤色/ZWJ 组合）判为 true", () => {
    expect(isEmojiOnly("😂")).toBe(true);
    expect(isEmojiOnly("😂😂 🤣")).toBe(true);
    expect(isEmojiOnly("👍🏻")).toBe(true);
    expect(isEmojiOnly("👨‍👩‍👧")).toBe(true);
  });

  test("带任何正文文字的消息判为 false", () => {
    expect(isEmojiOnly("笑死😂")).toBe(false);
    expect(isEmojiOnly("哈哈哈")).toBe(false);
    expect(isEmojiOnly("w😂w")).toBe(false);
  });

  test("纯数字/标点不含图形 emoji，判为 false（数字属于 emoji 组件，不能误伤）", () => {
    expect(isEmojiOnly("233")).toBe(false);
    expect(isEmojiOnly("？？？")).toBe(false);
  });
});

describe("cleanReply", () => {
  test("剥离行内引用标记，不吞掉标记之后无关括号包裹的正文（回归：过匹配曾把整段正文误删）", () => {
    const raw: string = "股价涨了[[1]](https://x.com/a)公司公告细节未知(具体后续待公布)大家再等等";
    expect(cleanReply(raw)).toBe("股价涨了公司公告细节未知(具体后续待公布)大家再等等");
  });

  test("URL 自身带一层平衡括号（维基百科消歧义链接式）时，整个链接连同引用标记一并剥离", () => {
    const raw: string = "参考[[2]](https://en.wikipedia.org/wiki/Foo_(bar))这个说法";
    expect(cleanReply(raw)).toBe("参考这个说法");
  });

  test("单条引用标记，标记前无空白、标记后紧跟空白分隔的正文", () => {
    const raw: string = "查了一下[[1]](https://example.com/path) 确实是这样";
    expect(cleanReply(raw)).toBe("查了一下 确实是这样");
  });

  test("多条引用标记全部剥离", () => {
    const raw: string = "一个说法[[1]](https://a.com)另一个说法[[2]](https://b.com)完了";
    expect(cleanReply(raw)).toBe("一个说法另一个说法完了");
  });

  test("没有引用标记时原样返回（去除首尾空白）", () => {
    expect(cleanReply("  普通回复，没有引用  ")).toBe("普通回复，没有引用");
  });

  test("全空白/清洗后为空返回 null", () => {
    expect(cleanReply("   ")).toBeNull();
  });

  test("剥掉包裹的代码块围栏与成对引号", () => {
    expect(cleanReply("```\n就这么点内容\n```")).toBe("就这么点内容");
    expect(cleanReply(`"带引号的话"`)).toBe("带引号的话");
  });
});

describe("buildCharacterTypo", () => {
  test("原字在 text 里存在时，替换出对应的错字版本", () => {
    expect(buildCharacterTypo("笨蛋", "蛋", "旦")).toEqual({ typoText: "笨旦", expected: "蛋", typo: "旦" });
    expect(buildCharacterTypo("看一下", "看", "砍")).toEqual({ typoText: "砍一下", expected: "看", typo: "砍" });
  });

  test("拒绝多字段、原字不在 text 里、或两字相同（模型主动选择不出错）", () => {
    expect(buildCharacterTypo("笨蛋", "笨蛋", "旦")).toBeNull();
    expect(buildCharacterTypo("笨蛋", "蛋", "旦丹")).toBeNull();
    expect(buildCharacterTypo("笨蛋", "本", "旦")).toBeNull();
    expect(buildCharacterTypo("笨蛋", "蛋", "蛋")).toBeNull();
  });

  test("原字或错字是 emoji 时拒绝", () => {
    expect(buildCharacterTypo("笨蛋😂", "蛋", "旦")).toEqual({ typoText: "笨旦😂", expected: "蛋", typo: "旦" });
    expect(buildCharacterTypo("笨蛋😂", "😂", "😅")).toBeNull();
    expect(buildCharacterTypo("笨蛋", "蛋", "😅")).toBeNull();
  });
});

describe("pickTypoCorrectionMode", () => {
  test("90% 补发正确单字，从 0.9 起的剩余 10% 当作没发现", () => {
    const originalRandom = Math.random;
    try {
      Math.random = () => 0.899999;
      expect(pickTypoCorrectionMode()).toBe("quick");
      Math.random = () => 0.9;
      expect(pickTypoCorrectionMode()).toBe("ignore");
      Math.random = () => 0.999999;
      expect(pickTypoCorrectionMode()).toBe("ignore");
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe("send_message typo correction", () => {
  test("禁用发生在输入停顿期间时不再发出消息", async () => {
    let active: boolean = true;
    sleepMock.mockImplementationOnce(async (): Promise<void> => {
      active = false;
    });
    const toolset = await createReplyToolset({
      chatId: -100800,
      replyToMessageId: 10,
      messageThreadId: undefined,
      mediaToolsRequested: true,
      bypassMediaToolCooldown: false,
      chatAction: {
        current: () => "idle",
        set: mock((..._args: unknown[]): void => {}),
        settle: mock(async (): Promise<void> => {}),
      },
      stickerLock: { tryAcquire: () => true, release: () => {} },
      roundHasTypo: false,
      isActive: () => active,
      onMessageSent: mock((..._args: unknown[]): void => {}),
      onStickerSent: mock((..._args: unknown[]): void => {}),
      onImageSent: mock((..._args: unknown[]): void => {}),
      onSongSent: mock((..._args: unknown[]): void => {}),
    });

    const result = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "不该发出" })));
    expect(result.error).toContain("disabled");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("快速补发只发送唯一错字对应的正确字，不接受模型给的整词", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const onMessageSent = mock((..._args: unknown[]): void => {});
      const toolset = await createReplyToolset({
        chatId: -100800,
        replyToMessageId: 10,
        messageThreadId: undefined,
        mediaToolsRequested: true,
        bypassMediaToolCooldown: false,
        chatAction: {
          current: () => "idle",
          set: mock((..._args: unknown[]): void => {}),
          settle: mock(async (): Promise<void> => {}),
        },
        stickerLock: {
          tryAcquire: () => true,
          release: () => {},
        },
        roundHasTypo: true,
        isActive: () => true,
        onMessageSent,
        onStickerSent: mock((..._args: unknown[]): void => {}),
        onImageSent: mock((..._args: unknown[]): void => {}),
        onSongSent: mock((..._args: unknown[]): void => {}),
      });

      const result = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));

      expect(result.success).toBe(true);
      expect(result.typo.mode).toBe("quick");
      expect(result.typo.correction).toBe("sent");
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(sendMessageMock).toHaveBeenNthCalledWith(1, { chatId: -100800, text: "天汽", replyToMessageId: undefined });
      expect(sendMessageMock).toHaveBeenNthCalledWith(2, { chatId: -100800, text: "气", replyToMessageId: undefined });
      expect(onMessageSent).toHaveBeenNthCalledWith(1, "天汽", 100, undefined);
      expect(onMessageSent).toHaveBeenNthCalledWith(2, "气", 101, undefined);
      expect(deleteMessageMock).not.toHaveBeenCalled();
    } finally {
      Math.random = originalRandom;
    }
  });

  test("本轮未抽中出错分支时，即使模型提供 typo_original_char/typo_replacement_char 也原样发送正确文本，不制造错字", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const onMessageSent = mock((..._args: unknown[]): void => {});
      const toolset = await createReplyToolset({
        chatId: -100800,
        replyToMessageId: 10,
        messageThreadId: undefined,
        mediaToolsRequested: true,
        bypassMediaToolCooldown: false,
        chatAction: {
          current: () => "idle",
          set: mock((..._args: unknown[]): void => {}),
          settle: mock(async (): Promise<void> => {}),
        },
        stickerLock: {
          tryAcquire: () => true,
          release: () => {},
        },
        roundHasTypo: false,
        isActive: () => true,
        onMessageSent,
        onStickerSent: mock((..._args: unknown[]): void => {}),
        onImageSent: mock((..._args: unknown[]): void => {}),
        onSongSent: mock((..._args: unknown[]): void => {}),
      });

      const result = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));

      expect(result.success).toBe(true);
      expect(result.typo).toBeUndefined();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenNthCalledWith(1, { chatId: -100800, text: "天气", replyToMessageId: undefined });
      expect(onMessageSent).toHaveBeenCalledTimes(1);
      expect(onMessageSent).toHaveBeenNthCalledWith(1, "天气", 100, undefined);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("同一轮内第二次带错字候选的调用不再采纳，只吃一次手滑", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const toolset = await createReplyToolset({
        chatId: -100800,
        replyToMessageId: 10,
        messageThreadId: undefined,
        mediaToolsRequested: true,
        bypassMediaToolCooldown: false,
        chatAction: {
          current: () => "idle",
          set: mock((..._args: unknown[]): void => {}),
          settle: mock(async (): Promise<void> => {}),
        },
        stickerLock: {
          tryAcquire: () => true,
          release: () => {},
        },
        roundHasTypo: true,
        isActive: () => true,
        onMessageSent: mock((..._args: unknown[]): void => {}),
        onStickerSent: mock((..._args: unknown[]): void => {}),
        onImageSent: mock((..._args: unknown[]): void => {}),
        onSongSent: mock((..._args: unknown[]): void => {}),
      });

      const first = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));
      const second = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
        text: "还好吧",
        typo_original_char: "好",
        typo_replacement_char: "号",
      })));

      expect(first.typo?.mode).toBe("quick");
      expect(second.typo).toBeUndefined();
      expect(sendMessageMock).toHaveBeenNthCalledWith(3, { chatId: -100800, text: "还好吧", replyToMessageId: undefined });
    } finally {
      Math.random = originalRandom;
    }
  });

  test("快速补字等待期间 AI 被禁用时不再落地，且不额外占动作数", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    let active: boolean = true;
    sleepMock
      .mockImplementationOnce(async (): Promise<void> => {})
      .mockImplementationOnce(async (): Promise<void> => {
        active = false;
      });
    try {
      const toolset = await createReplyToolset({
        chatId: -100800,
        replyToMessageId: 10,
        messageThreadId: undefined,
        mediaToolsRequested: true,
        bypassMediaToolCooldown: false,
        chatAction: {
          current: () => "idle",
          set: mock((..._args: unknown[]): void => {}),
          settle: mock(async (): Promise<void> => {}),
        },
        stickerLock: { tryAcquire: () => true, release: () => {} },
        roundHasTypo: true,
        isActive: () => active,
        onMessageSent: mock((..._args: unknown[]): void => {}),
        onStickerSent: mock((..._args: unknown[]): void => {}),
        onImageSent: mock((..._args: unknown[]): void => {}),
        onSongSent: mock((..._args: unknown[]): void => {}),
      });

      const result = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));

      expect(result.typo).toEqual({ mode: "quick", correction: "failed" });
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(toolset.actionsUsed()).toBe(1);
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe("send_message 重复消息去重", () => {
  function buildContext(roundHasTypo: boolean) {
    return {
      chatId: -100800,
      replyToMessageId: 10,
      messageThreadId: undefined,
      mediaToolsRequested: true,
      bypassMediaToolCooldown: false,
      chatAction: {
        current: () => "idle" as const,
        set: mock((..._args: unknown[]): void => {}),
        settle: mock(async (): Promise<void> => {}),
      },
      stickerLock: { tryAcquire: () => true, release: () => {} },
      roundHasTypo,
      isActive: () => true,
      onMessageSent: mock((..._args: unknown[]): void => {}),
      onStickerSent: mock((..._args: unknown[]): void => {}),
      onImageSent: mock((..._args: unknown[]): void => {}),
      onSongSent: mock((..._args: unknown[]): void => {}),
    };
  }

  test("同一轮内容完全相同的第二次调用静默跳过，不重复发送", async () => {
    const toolset = await createReplyToolset(buildContext(false));

    const first = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "笨蛋" })));
    const second = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "笨蛋" })));

    expect(first.success).toBe(true);
    expect(second).toEqual({ success: true, skipped: "duplicate", actions_used: 0 });
    expect(toolset.actionsUsed()).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  test("用文字伪造一次动作会被拒发，动作预算也不消耗", async () => {
    // 生图撞上群冷却时，模型有概率不说「发不了」，而是照着转录里见过的形状打一段
    // 「（…生成并发送了一张图片：…）」出来：群友收到一条声称配了图、实际什么都没有
    // 的消息，记忆里还会留下一条假的动作记录，下一轮它自己也会当真。
    const toolset = await createReplyToolset(buildContext(false));

    const forgedImage = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
      text: "（参考上传的素材生成并发送了一张图片：橙色云朵弧线加蓝色光纤流光）",
    })));
    const forgedSticker = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
      text: "（发了一枚贴纸：情绪含义 😂）",
    })));

    expect(forgedImage.error).toContain("must not narrate an action");
    expect(forgedSticker.error).toContain("must not narrate an action");
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(toolset.actionsUsed()).toBe(0);

    // 老老实实说发不了的那句话照发不误。
    const honest = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
      text: "生图还在冷却，等会儿再帮你画喵~",
    })));
    expect(honest.success).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  test("括号外只是提到这两个词的正常回答不算伪造", async () => {
    // 「发了一枚贴纸」「生成并发送了一张图片」本身是日常中文。按裸子串拦的话，
    // 群友直接问起时模型照常作答就会被硬拒，而本轮兜底文本走同一个执行器会被
    // 再拒一次——结果是对着一条 @ 提及完全沉默。
    const toolset = await createReplyToolset(buildContext(false));

    const answer = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
      text: "本天才才没有生成并发送了一张图片呢，笨蛋♡",
    })));

    expect(answer.success).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  test("错字轮按本意文本判重：可见消息是错字版本，重发同一句正确原文仍静默跳过", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const toolset = await createReplyToolset(buildContext(true));

      const first = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));
      const second = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));

      // 快速补字：可见消息是「天汽」+ 纠正字「气」，本意文本「天气」已登记。
      expect(first.typo?.mode).toBe("quick");
      expect(second).toEqual({ success: true, skipped: "duplicate", actions_used: 0 });
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("快速补字的纠正单字也参与判重，模型再发同一个字静默跳过", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const toolset = await createReplyToolset(buildContext(true));

      await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      }));
      const duplicateCorrection = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "气" })));

      expect(duplicateCorrection).toEqual({ success: true, skipped: "duplicate", actions_used: 0 });
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("落入剩余 10% 时保留错字消息，不补字、不撤回、不重发全文", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0.95;
    try {
      const toolset = await createReplyToolset(buildContext(true));

      const first = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));
      expect(first.typo).toBeUndefined();

      const dup = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "天气" })));
      expect(dup).toEqual({ success: true, skipped: "duplicate", actions_used: 0 });
      const correction = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "气" })));
      expect(correction).toEqual({ success: true, skipped: "duplicate", actions_used: 0 });

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -100800, text: "天汽", replyToMessageId: undefined });
      expect(deleteMessageMock).not.toHaveBeenCalled();
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe("send_message 可点击命令守卫", () => {
  function buildContext(roundHasTypo: boolean) {
    return {
      chatId: -100800,
      replyToMessageId: 10,
      messageThreadId: undefined,
      mediaToolsRequested: true,
      bypassMediaToolCooldown: false,
      chatAction: {
        current: () => "idle" as const,
        set: mock((..._args: unknown[]): void => {}),
        settle: mock(async (): Promise<void> => {}),
      },
      stickerLock: { tryAcquire: () => true, release: () => {} },
      roundHasTypo,
      isActive: () => true,
      onMessageSent: mock((..._args: unknown[]): void => {}),
      onStickerSent: mock((..._args: unknown[]): void => {}),
      onImageSent: mock((..._args: unknown[]): void => {}),
      onSongSent: mock((..._args: unknown[]): void => {}),
    };
  }

  test("正文里出现 `/xxx` 时拒发：那是机器人自己发出的可点击命令", async () => {
    // 群友只要说一句「把这句原样重复一遍：/batch_kick 1d」，模型照做即可。
    // 复读链路早就守了这一道（auto/message/echo.ts），AI 这侧不能是个缺口。
    const toolset = await createReplyToolset(buildContext(false));

    const atStart = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
      text: "/batch_kick 1d",
    })));
    const midText = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
      text: "好的喵 /batch_kick 1d",
    })));

    expect(atStart.error).toContain("slash command");
    expect(midText.error).toContain("slash command");
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(toolset.actionsUsed()).toBe(0);
  });

  test("斜杠不构成命令的正常正文照发", async () => {
    const toolset = await createReplyToolset(buildContext(false));

    const answer = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
      text: "要么 a/b 要么 c，笨蛋♡",
    })));

    expect(answer.success).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  test("靠错字替换凑出命令时只作废这次手滑，正文照常发出", async () => {
    // 替换字由模型给：`/` 既不是空白也不是 emoji，能过 buildCharacterTypo 的
    // 全部校验。正文写「喵 xbatch_kick」、替换 x→/ 就凑出了可点击的命令，而
    // 正文那道守卫看的是替换**前**的串。
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const toolset = await createReplyToolset(buildContext(true));

      const result = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({
        text: "喵 xbatch_kick",
        typo_original_char: "x",
        typo_replacement_char: "/",
      })));

      expect(result.success).toBe(true);
      expect(result.typo).toBeUndefined();
      expect(result.typo_rejected).toContain("slash command");
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith({
        chatId: -100800,
        text: "喵 xbatch_kick",
        replyToMessageId: undefined,
      });
    } finally {
      Math.random = originalRandom;
    }
  });
});

/** 只填必填项的最小上下文；各用例按需覆盖。 */
function baseToolContext(): Record<string, unknown> {
  return {
    chatId: -100800,
    replyToMessageId: 10,
    messageThreadId: undefined,
    mediaToolsRequested: false,
    bypassMediaToolCooldown: false,
    chatAction: {
      current: () => "idle",
      set: mock((..._args: unknown[]): void => {}),
      settle: mock(async (): Promise<void> => {}),
    },
    stickerLock: { tryAcquire: () => true, release: () => {} },
    roundHasTypo: false,
    isActive: () => true,
    onMessageSent: mock((..._args: unknown[]): void => {}),
    onStickerSent: mock((..._args: unknown[]): void => {}),
    onImageSent: mock((..._args: unknown[]): void => {}),
    onSongSent: mock((..._args: unknown[]): void => {}),
  };
}

describe("群问答工具在按次工具集里的接线", () => {
  test("本群没有问答时两个工具都不挂，模型看不见就不会调", async () => {
    const toolset = await createReplyToolset(baseToolContext() as never);

    expect(toolset.has(GROUP_QA_QUERY_TOOL)).toBe(false);
    expect(toolset.has(GROUP_QA_ANSWER_TOOL)).toBe(false);
    expect(toolset.functions.some((f) => f.name === GROUP_QA_QUERY_TOOL)).toBe(false);
  });

  test("本群有问答时两个工具都挂上，且 dispatch 真的走到执行器", async () => {
    const toolset = await createReplyToolset({
      ...baseToolContext(),
      chatQa: new Map([["怎么入群？", "点置顶那条链接"]]),
    } as never);

    expect(toolset.has(GROUP_QA_QUERY_TOOL)).toBe(true);
    expect(toolset.has(GROUP_QA_ANSWER_TOOL)).toBe(true);

    // 直接断言 ReplyToolContext.chatQa 被交给执行器，而不只依赖类型保证。
    const listed: { questions: string[] } = JSON.parse(
      await toolset.execute(GROUP_QA_QUERY_TOOL, "{}")
    );
    expect(listed.questions).toEqual(["怎么入群？"]);

    const answered: { found: boolean; answer?: string } = JSON.parse(
      await toolset.execute(GROUP_QA_ANSWER_TOOL, JSON.stringify({ question: "怎么入群？" }))
    );
    expect(answered.found).toBe(true);
    expect(answered.answer).toBe("点置顶那条链接");
  });

  test("问答工具不消耗整轮可见动作预算", async () => {
    const toolset = await createReplyToolset({
      ...baseToolContext(),
      chatQa: new Map([["a", "1"]]),
    } as never);

    // 预算耗尽后动作工具会被拒，查询工具必须照常可用——否则模型查一次清单
    // 就少发一条消息。
    for (let index: number = 0; index < HARD_MAX_ACTIONS_PER_REPLY + 1; index++) {
      await toolset.execute(GROUP_QA_QUERY_TOOL, "{}");
    }
    const listed: { questions: string[] } = JSON.parse(
      await toolset.execute(GROUP_QA_QUERY_TOOL, "{}")
    );
    expect(listed.questions).toEqual(["a"]);
  });
});

describe("工具分派", () => {
  /** 只挂菜单记忆化缓存，不碰贴纸集合与目录：分派本身与怎么拉到菜单无关。 */
  function seedStickerMenu(): void {
    stickerMenuCache.current = {
      revision: stickerMenuRevision.current,
      menu: [{
        pack: "pack_a",
        title: "甲包",
        summary: "一句简介",
        stickers: [{
          sticker: {
            file_id: "file-a",
            file_unique_id: "uid-a",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
          },
          emoji: "😂",
          description: "在笑",
        }],
      }],
    };
  }

  function stickerContext() {
    return {
      chatId: -100800,
      replyToMessageId: 10,
      messageThreadId: undefined,
      mediaToolsRequested: false,
      bypassMediaToolCooldown: false,
      chatAction: {
        current: () => "idle" as const,
        set: mock((..._args: unknown[]): void => {}),
        settle: mock(async (): Promise<void> => {}),
      },
      stickerLock: { tryAcquire: () => true, release: () => {} },
      roundHasTypo: false,
      isActive: () => true,
      onMessageSent: mock((..._args: unknown[]): void => {}),
      onStickerSent: mock((..._args: unknown[]): void => {}),
      onImageSent: mock((..._args: unknown[]): void => {}),
      onSongSent: mock((..._args: unknown[]): void => {}),
    };
  }

  test("两个贴纸工具都从分派表接到本轮共享的菜单与状态", async () => {
    // 看包与发贴纸必须落在同一份菜单和同一份轮内状态上：分派时各建一份的话，
    // 模型按 view 返回的编号去发，发出去的会是另一份菜单里的同号贴纸。
    seedStickerMenu();
    const context = stickerContext();
    const toolset = await createReplyToolset(context);

    const viewed = JSON.parse(await toolset.execute(
      VIEW_STICKER_PACK_TOOL,
      JSON.stringify({ pack_index: 1, intent: "想表达好笑" })
    ));
    expect(viewed.pack).toBe("甲包");
    expect(viewed.stickers).toContain("😂");

    const sent = JSON.parse(await toolset.execute(
      SEND_STICKER_TOOL,
      JSON.stringify({ pack_index: 1, sticker_index: 1 })
    ));

    expect(sent.success).toBe(true);
    expect(sendStickerMock).toHaveBeenCalledTimes(1);
    expect(context.onStickerSent).toHaveBeenCalledTimes(1);
    expect(toolset.actionsUsed()).toBe(1);
  });

  test("没看过包就直接发贴纸会被本轮状态拦下", async () => {
    seedStickerMenu();
    const toolset = await createReplyToolset(stickerContext());

    const sent = JSON.parse(await toolset.execute(
      SEND_STICKER_TOOL,
      JSON.stringify({ pack_index: 1, sticker_index: 1 })
    ));

    expect(sent.error).toBeDefined();
    expect(sendStickerMock).not.toHaveBeenCalled();
  });

  test("未知工具名走统一错误，不消耗动作预算", async () => {
    seedStickerMenu();
    const toolset = await createReplyToolset(stickerContext());

    const result = JSON.parse(await toolset.execute("no_such_tool", "{}"));

    expect(result.error).toBeDefined();
    expect(toolset.actionsUsed()).toBe(0);
  });
});
