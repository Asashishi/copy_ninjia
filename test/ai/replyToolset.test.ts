import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanReply, isEmojiOnly } from "../../src/ai/utils/replyText";
import { buildCharacterTypo, pickTypoCorrectionMode } from "../../src/ai/utils/typo";

let nextMessageId: number = 100;
const sendMessageMock = mock(async (..._args: unknown[]): Promise<number | undefined> => nextMessageId++);
const deleteMessageMock = mock(async (..._args: unknown[]): Promise<boolean> => true);
const setMessageReactionMock = mock((..._args: unknown[]): void => {});
const sendStickerMock = mock(async (..._args: unknown[]): Promise<number | undefined> => nextMessageId++);
const sleepMock = mock(async (..._args: unknown[]): Promise<void> => {});
const realTelegram = await import("../../src/infra/telegram");

mock.module("../../src/infra/telegram", () => ({
  ...realTelegram,
  bot: { api: { getStickerSet: mock(async (): Promise<null> => null), getFile: mock(async (): Promise<null> => null) } },
  buildFileDownloadUrl: mock((_filePath: string): string => "https://example.invalid/file"),
  sendMessage: sendMessageMock,
  deleteMessage: deleteMessageMock,
  setMessageReaction: setMessageReactionMock,
  sendChooseStickerAction: mock(async (): Promise<boolean> => true),
  sendTypingAction: mock(async (): Promise<boolean> => true),
  sendUploadPhotoAction: mock(async (): Promise<boolean> => true),
  sendSticker: sendStickerMock,
}));

mock.module("../../src/libs/sleep", () => ({
  sleep: sleepMock,
}));

const { SEND_MESSAGE_TOOL } = await import("../../src/consts/tools");
const { REPLY_ACTION_INSTRUCTION, SEND_MESSAGE_TOOL_INSTRUCTION } = await import("../../src/consts/aiChat/prompts/tools");
const { createReplyToolset } = await import("../../src/ai/tools/replyToolset");

beforeEach(() => {
  nextMessageId = 100;
  sendMessageMock.mockClear();
  deleteMessageMock.mockClear();
  setMessageReactionMock.mockClear();
  sendStickerMock.mockClear();
  sleepMock.mockClear();
});

test("工具集真实注册 googleSearch，并同时提供函数行动工具", async () => {
  const toolset = await createReplyToolset({
    chatId: -100800,
    replyToMessageId: 10,
    imageGenerationRequested: true,
    bypassImageGenerationCooldown: false,
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
  });

  expect(toolset.tools).toHaveLength(2);
  expect(toolset.tools[0]?.googleSearch).toEqual({});
  expect(toolset.tools[1]?.functionDeclarations?.length).toBeGreaterThan(0);
  expect(toolset.definitions.map((definition) => definition.name)).not.toContain("delete_own_message");
});

test("回复提示明确要求所有可见文本经 send_message，最终响应不得夹带正文", () => {
  expect(SEND_MESSAGE_TOOL_INSTRUCTION).toContain("任何主回复、图片/贴纸说明或动作后的补充文字都必须显式调用本工具");
  expect(REPLY_ACTION_INSTRUCTION).toContain("所有需要让群友看到的文本发言都必须显式调用 send_message");
  expect(REPLY_ACTION_INSTRUCTION).toContain("最终响应保持空白");
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
      imageGenerationRequested: true,
      bypassImageGenerationCooldown: false,
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
        imageGenerationRequested: true,
        bypassImageGenerationCooldown: false,
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
      expect(onMessageSent).toHaveBeenNthCalledWith(1, "天汽", 100);
      expect(onMessageSent).toHaveBeenNthCalledWith(2, "气", 101);
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
        imageGenerationRequested: true,
        bypassImageGenerationCooldown: false,
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
      expect(onMessageSent).toHaveBeenNthCalledWith(1, "天气", 100);
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
        imageGenerationRequested: true,
        bypassImageGenerationCooldown: false,
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
        imageGenerationRequested: true,
        bypassImageGenerationCooldown: false,
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
      imageGenerationRequested: true,
      bypassImageGenerationCooldown: false,
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
    };
  }

  test("同一轮内容完全相同的第二次调用被拒绝，不重复发送", async () => {
    const toolset = await createReplyToolset(buildContext(false));

    const first = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "笨蛋" })));
    const second = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "笨蛋" })));

    expect(first.success).toBe(true);
    expect(second.error).toContain("identical message");
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  test("错字轮按本意文本判重：可见消息是错字版本，重发同一句正确原文仍被拒绝", async () => {
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
      expect(second.error).toContain("identical message");
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("快速补字的纠正单字也参与判重，模型再发同一个字被拒绝", async () => {
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

      expect(duplicateCorrection.error).toContain("identical message");
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
      expect(dup.error).toContain("identical message");
      const correction = JSON.parse(await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: "气" })));
      expect(correction.error).toContain("identical message");

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -100800, text: "天汽", replyToMessageId: undefined });
      expect(deleteMessageMock).not.toHaveBeenCalled();
    } finally {
      Math.random = originalRandom;
    }
  });
});
