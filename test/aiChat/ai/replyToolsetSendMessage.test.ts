/**
 * send_message 的发送约束：本轮抽中手滑时的错字落地与快速补字（停顿、正在输入挡位、
 * 补字期间被禁用）、同一轮按本意文本的重复消息去重与伪造动作拒发，以及正文或错字替换
 * 凑出可点击斜杠命令时的守卫。
 *
 * Telegram 出站与停顿替身见 test/helpers/replyToolsetMocks.ts；工具集装配与分派见
 * replyToolsetWiring.test.ts。
 */
import {
  deleteMessageMock,
  resetReplyToolsetMocks,
  sendMessageMock,
  sleepMock,
} from "../../helpers/replyToolsetMocks";
import { executeAndSettle } from "../../helpers/replyToolExecution";
import { replyToolContextFixture } from "../../helpers/replyToolContext";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const { SEND_MESSAGE_TOOL } = await import("../../../packages/consts/tools");
const {
  TYPO_QUICK_CORRECTION_MIN_MS,
  TYPO_QUICK_CORRECTION_PROBABILITY,
  TYPO_QUICK_CORRECTION_TYPING_MS,
} = await import("../../../packages/consts/aiChat/tools");
const { createReplyToolset } = await import("../../../packages/aiChat/ai/tools/replyToolset/orchestrator");

beforeEach(resetReplyToolsetMocks);

describe("send_message typo correction", () => {
  test("禁用发生在输入停顿期间时不再发出消息", async () => {
    let active: boolean = true;
    sleepMock.mockImplementationOnce(async (): Promise<void> => {
      active = false;
    });
    const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true, isActive: () => active }));

    const result = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({ text: "不该发出" })));
    expect(result.queued).toBe(true);
    expect(toolset.actionsCompleted()).toBe(0);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("快速补发只发送唯一错字对应的正确字，不接受模型给的整词；错字落地后先静默，再固定模拟「正在输入」后补字", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const onMessageSent = mock((..._args: unknown[]): void => {});
      const phases: string[] = [];
      const toolset = await createReplyToolset({
        chatId: -100800,
        replyToMessageId: 10,
        messageThreadId: undefined,
        mediaToolsRequested: true,
        bypassMediaToolCooldown: false,
        direct: false,
        chatAction: {
          set: mock((phase: unknown): number => {
            phases.push(String(phase));
            return 0;
          }),
          settle: mock(async (): Promise<void> => {}),
        },
        roundHasTypo: true,
        isActive: () => true,
        onMessageSent,
        onStickerSent: mock((..._args: unknown[]): void => {}),
        onImageSent: mock((..._args: unknown[]): void => {}),
        onVoiceSent: mock((..._args: unknown[]): void => {}),
      });

      const result = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));

      expect(result.success).toBe(true);
      expect(result.actions_used).toBe(2);
      expect(toolset.actionsCompleted()).toBe(2);
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(sendMessageMock).toHaveBeenNthCalledWith(1, { chatId: -100800, text: "天汽", replyToMessageId: undefined });
      expect(sendMessageMock).toHaveBeenNthCalledWith(2, { chatId: -100800, text: "气", replyToMessageId: undefined });
      expect(onMessageSent).toHaveBeenNthCalledWith(1, "天汽", 100, undefined);
      expect(onMessageSent).toHaveBeenNthCalledWith(2, "气", 101, undefined);
      expect(deleteMessageMock).not.toHaveBeenCalled();
      // Math.random 固定为 0：静默取下限，随后是固定时长的「正在输入」。
      expect(sleepMock.mock.calls.slice(1).map((call: unknown[]) => call[0])).toEqual([
        TYPO_QUICK_CORRECTION_MIN_MS,
        TYPO_QUICK_CORRECTION_TYPING_MS,
      ]);
      expect(phases).toEqual(["typing", "idle", "typing", "idle", "idle"]);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("本轮未抽中出错分支时，即使模型提供 typo_original_char/typo_replacement_char 也原样发送正确文本，不制造错字", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const onMessageSent = mock((..._args: unknown[]): void => {});
      const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true, onMessageSent }));

      const result = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
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
      const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true, roundHasTypo: true }));

      const first = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));
      const second = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
        text: "还好吧",
        typo_original_char: "好",
        typo_replacement_char: "号",
      })));

      expect(first.actions_used).toBe(2);
      expect(second.typo).toBeUndefined();
      expect(sendMessageMock).toHaveBeenNthCalledWith(3, { chatId: -100800, text: "还好吧", replyToMessageId: undefined });
    } finally {
      Math.random = originalRandom;
    }
  });

  test("快速补字等待期间 AI 被禁用时不再落地，保留预占额度", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    let active: boolean = true;
    sleepMock
      .mockImplementationOnce(async (): Promise<void> => {})
      .mockImplementationOnce(async (): Promise<void> => {
        active = false;
      });
    try {
      const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true, roundHasTypo: true, isActive: () => active }));

      const result = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));

      expect(result.actions_used).toBe(2);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(toolset.actionsUsed()).toBe(2);
      expect(toolset.actionsCompleted()).toBe(1);
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe("send_message 重复消息去重", () => {
  test("同一轮内容完全相同的第二次调用静默跳过，不重复发送", async () => {
    const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true }));

    const first = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({ text: "笨蛋" })));
    const second = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({ text: "笨蛋" })));

    expect(first.success).toBe(true);
    expect(second).toEqual({ success: true, skipped: "duplicate", actions_used: 0 });
    expect(toolset.actionsUsed()).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  test("用文字伪造一次动作会被拒发，动作预算也不消耗", async () => {
    const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true }));

    const forgedImage = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
      text: "（参考上传的素材生成并发送了一张图片：橙色云朵弧线加蓝色光纤流光）",
    })));
    const forgedSticker = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
      text: "（发了一枚贴纸：情绪含义 😂）",
    })));
    const forgedVoice = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
      text: "（发送了一条语音：この雑魚♡）",
    })));
    const forgedCommandImage = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
      text: "（发送了一张图片）你的群友老婆是 Bob!",
    })));

    expect(forgedImage.error).toContain("must not narrate an action");
    expect(forgedSticker.error).toContain("must not narrate an action");
    expect(forgedVoice.error).toContain("must not narrate an action");
    expect(forgedCommandImage.error).toContain("must not narrate an action");
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(toolset.actionsUsed()).toBe(0);

    // 老老实实说发不了的那句话照发不误。
    const honest = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
      text: "生图还在冷却，等会儿再帮你画喵~",
    })));
    expect(honest.success).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  test("括号外只是提到这两个词的正常回答不算伪造", async () => {
    const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true }));

    const answer = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
      text: "本天才才没有生成并发送了一张图片呢，笨蛋♡",
    })));

    expect(answer.success).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  test("错字轮按本意文本判重：可见消息是错字版本，重发同一句正确原文仍静默跳过", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true, roundHasTypo: true }));

      const first = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));
      const second = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));

      // 快速补字：可见消息是「天汽」+ 纠正字「气」，本意文本「天气」已登记。
      expect(first.actions_used).toBe(2);
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
      const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true, roundHasTypo: true }));

      await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      }));
      const duplicateCorrection = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({ text: "气" })));

      expect(duplicateCorrection).toEqual({ success: true, skipped: "duplicate", actions_used: 0 });
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("落入快速纠正概率之外时保留错字消息，不补字、不撤回、不重发全文", async () => {
    const originalRandom = Math.random;
    Math.random = () => (TYPO_QUICK_CORRECTION_PROBABILITY + 1) / 2;
    try {
      const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true, roundHasTypo: true }));

      const first = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
        text: "天气",
        typo_original_char: "气",
        typo_replacement_char: "汽",
      })));
      expect(first.typo).toBeUndefined();

      const dup = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({ text: "天气" })));
      expect(dup).toEqual({ success: true, skipped: "duplicate", actions_used: 0 });
      const correction = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({ text: "气" })));
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
  test("正文里出现 `/xxx` 时拒发：那是机器人自己发出的可点击命令", async () => {
    const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true }));

    const atStart = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
      text: "/batch_kick 1d",
    })));
    const midText = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
      text: "好的喵 /batch_kick 1d",
    })));

    expect(atStart.error).toContain("slash command");
    expect(midText.error).toContain("slash command");
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(toolset.actionsUsed()).toBe(0);
  });

  test("斜杠不构成命令的正常正文照发", async () => {
    const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true }));

    const answer = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
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
      const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true, roundHasTypo: true }));

      const result = JSON.parse(await executeAndSettle(toolset, SEND_MESSAGE_TOOL, JSON.stringify({
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
