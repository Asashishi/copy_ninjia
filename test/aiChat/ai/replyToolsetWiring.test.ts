/**
 * 按次回复工具集的装配与分派：联网检索与函数工具同时挂载、反应动作的预占与完成计数、
 * 动作数的提示上限与执行硬顶、回复目标与论坛话题落点、工具声明在各种触发下逐字节恒定、
 * 群问答工具接线，以及贴纸工具共享本轮菜单与状态的分派；另核对行动总则与发送、语音
 * 工具提示的关键约束。
 *
 * Telegram 出站与停顿替身见 test/helpers/replyToolsetMocks.ts；send_message 的手滑、去重与
 * 命令守卫见 replyToolsetSendMessage.test.ts。
 */
import {
  resetReplyToolsetMocks,
  sendMessageMock,
  sendStickerMock,
  setMessageReactionMock,
} from "../../helpers/replyToolsetMocks";
import { executeAndSettle } from "../../helpers/replyToolExecution";
import { replyToolContextFixture } from "../../helpers/replyToolContext";
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { cartesianProduct } from "../../../packages/libs/cartesianProduct";
import type { TelegramSendResult } from "../../../packages/types/telegram";
import type { AgentDeploymentConfig } from "../../../packages/types/config";
import type { AiWebSearchResult } from "../../../packages/types/aiChat/provider";
import type { ReplyToolset } from "../../../packages/types/aiChat/replies";
import type * as AiProviderModule from "../../../packages/aiChat/provider";

const {
  ADD_REACTION_TOOL,
  GROUP_QA_ANSWER_TOOL,
  GROUP_QA_QUERY_TOOL,
  SEND_MESSAGE_TOOL,
  SEND_STICKER_TOOL,
  VIEW_STICKER_PACK_TOOL,
  WEB_SEARCH_TOOL,
} = await import("../../../packages/consts/tools");
const { adoptAgentDeploymentConfig, getAgentDeploymentConfig } = await import("../../../packages/config/agent");
const { resetAiProviderFacades } = await import("../../../packages/cache/workers/aiChat/providerScheduler");
const {
  AI_MAX_ACTIONS_PER_REPLY,
  HARD_MAX_ACTIONS_PER_REPLY,
} = await import("../../../packages/consts/aiChat/tools");
const {
  REPLY_ACTION_INSTRUCTION,
  SEND_MESSAGE_TOOL_INSTRUCTION,
  SEND_VOICE_TOOL_INSTRUCTION,
  TOOL_STATUS_BLOCK_LABEL,
  groupQaToolStatus,
  webSearchToolStatus,
} = await import("../../../packages/consts/aiChat/prompts/tools");
const { createReplyToolset } = await import("../../../packages/aiChat/ai/tools/replyToolset/orchestrator");
const providerModule: typeof AiProviderModule = await import("../../../packages/aiChat/provider");
const { stickerMenuCache, stickerMenuRevision } =
  await import("../../../packages/cache/workers/aiChat/stickers/menu");

beforeEach(resetReplyToolsetMocks);

test("配置了 web_search 时挂本地检索函数工具、不挂内建检索；去掉后反之，两种都同时提供函数行动工具", async () => {
  const configured: AgentDeploymentConfig = getAgentDeploymentConfig();
  expect(configured.webSearch).toBeDefined();
  const local = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true }));
  expect(local.webSearch).toBe(false);
  expect(local.searchWeb).not.toBeNull();
  expect(local.toolStatus).toContain(webSearchToolStatus(configured.webSearch!.maxCallsPerUse));
  expect(local.functions.map((definition) => definition.name)).toContain(WEB_SEARCH_TOOL);
  // 异步分派只走回复循环，不进同步的 has / execute 名单。
  expect(local.has(WEB_SEARCH_TOOL)).toBe(false);
  expect(local.has(SEND_MESSAGE_TOOL)).toBe(true);

  adoptAgentDeploymentConfig({ ...configured, webSearch: undefined });
  resetAiProviderFacades();
  try {
    const builtIn = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true }));
    expect(builtIn.webSearch).toBe(true);
    expect(builtIn.searchWeb).toBeNull();
    expect(builtIn.toolStatus).not.toContain(webSearchToolStatus(configured.webSearch!.maxCallsPerUse));
    expect(builtIn.functions.map((definition) => definition.name)).not.toContain(WEB_SEARCH_TOOL);
    expect(builtIn.has("delete_own_message")).toBe(false);
  } finally {
    adoptAgentDeploymentConfig(configured);
    resetAiProviderFacades();
  }
});

test("独立 web_search 按本轮配置快照允许七次调用；改配置后新轮取新上限，声明保持相同", async () => {
  const configured: AgentDeploymentConfig = getAgentDeploymentConfig();
  const maxCallsPerUse: number = 7;
  const searchWeb: Mock<() => Promise<AiWebSearchResult>> = mock(async (): Promise<AiWebSearchResult> => ({ ok: true, text: "资料", sources: [], searchCalls: 1 }));
  const providerMock: Mock<typeof providerModule.webSearchAiProvider> = spyOn(providerModule, "webSearchAiProvider")
    .mockReturnValue({ name: configured.webSearch!.provider, searchWeb });
  try {
    adoptAgentDeploymentConfig({ ...configured, webSearch: { ...configured.webSearch!, maxCallsPerUse } });
    const first: ReplyToolset = await createReplyToolset(replyToolContextFixture());
    expect(first.toolStatus).toContain(webSearchToolStatus(maxCallsPerUse));
    adoptAgentDeploymentConfig({ ...configured, webSearch: { ...configured.webSearch!, maxCallsPerUse: 1 } });
    const second: ReplyToolset = await createReplyToolset(replyToolContextFixture());
    expect(second.toolStatus).toContain(webSearchToolStatus(1));
    expect(second.functions).toEqual(first.functions);
    for (let index: number = 0; index < maxCallsPerUse; index++) {
      expect((await first.searchWeb!(JSON.stringify({ query: `q${index}` }))).searchCalls).toBe(1);
    }
    expect((await first.searchWeb!(JSON.stringify({ query: "over" }))).searchCalls).toBe(0);
    expect((await second.searchWeb!(JSON.stringify({ query: "q" }))).searchCalls).toBe(1);
    expect((await second.searchWeb!(JSON.stringify({ query: "over" }))).searchCalls).toBe(0);
    expect(searchWeb).toHaveBeenCalledTimes(maxCallsPerUse + 1);
    await first.settle();
    await second.settle();
  } finally {
    providerMock.mockRestore();
    adoptAgentDeploymentConfig(configured);
    resetAiProviderFacades();
  }
});

describe("add_reaction 成功动作计数", () => {
  test("反应接纳时占动作，真实完成后计入已完成动作", async () => {
    const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true }));

    const result = JSON.parse(await executeAndSettle(toolset, ADD_REACTION_TOOL, JSON.stringify({ emoji: "👍" })));

    expect(result).toEqual({ success: true, queued: true, actions_used: 1 });
    expect(setMessageReactionMock).toHaveBeenCalledWith({ chatId: -100800, messageId: 10, emoji: "👍" });
    expect(toolset.actionsUsed()).toBe(1);
  });

  test("反应发送失败不再让模型重投，预占限额保持有效", async () => {
    setMessageReactionMock.mockImplementationOnce(async (): Promise<boolean> => false);
    const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested: true }));
    const accepted = JSON.parse(await executeAndSettle(toolset, ADD_REACTION_TOOL, JSON.stringify({ emoji: "👍" })));
    expect(accepted.queued).toBe(true);
    expect(toolset.actionsUsed()).toBe(1);
    expect(toolset.actionsCompleted()).toBe(0);
    const retried = JSON.parse(await executeAndSettle(toolset, ADD_REACTION_TOOL, JSON.stringify({ emoji: "👍" })));
    expect(retried.error).toContain("Reaction limit reached");
    expect(setMessageReactionMock).toHaveBeenCalledTimes(1);
  });
});

test("语音说过的意思不得再用文字重发：三处提示都按语义而非字面约束", () => {
  expect(SEND_MESSAGE_TOOL_INSTRUCTION).toContain("send_voice 念过的台词");
  expect(SEND_MESSAGE_TOOL_INSTRUCTION).toContain("（发送了一条语音：…）");
  expect(SEND_MESSAGE_TOOL_INSTRUCTION).toContain("翻成中文、换个说法或加上注释再发出来都算重复");
  expect(SEND_VOICE_TOOL_INSTRUCTION).toContain("语音里已经说过的意思不要再用 send_message 发一遍");
  expect(SEND_VOICE_TOOL_INSTRUCTION).toContain("文字只发语音之外的内容");
  expect(REPLY_ACTION_INSTRUCTION).toContain("正文、图片 caption 与语音台词共用这条规则");
  expect(REPLY_ACTION_INSTRUCTION).toContain("用中文或其它语言把语音里说过的话再发成文字，同样算重复");
});

test("回复提示把独立文字限死在 send_message，媒体配文走对应 caption，最终响应不得夹带正文", () => {
  expect(SEND_MESSAGE_TOOL_INSTRUCTION).toContain("主回复、贴纸说明、动作之后的补充文字都必须显式调用");
  expect(REPLY_ACTION_INSTRUCTION).toContain("独立文字只用 send_message");
  expect(SEND_MESSAGE_TOOL_INSTRUCTION).toContain("写进 generate_image 的 caption");
  expect(REPLY_ACTION_INSTRUCTION).toContain("随附文字写进 generate_image 的 caption，不要再复述");
  expect(REPLY_ACTION_INSTRUCTION).toContain("最终响应保持空白");
});

test("模型提示按 AI_MAX_ACTIONS_PER_REPLY 限制动作数，执行侧留余量到 HARD_MAX_ACTIONS_PER_REPLY 才触发硬顶", async () => {
  expect(HARD_MAX_ACTIONS_PER_REPLY).toBeGreaterThan(AI_MAX_ACTIONS_PER_REPLY);
  expect(REPLY_ACTION_INSTRUCTION).toContain(`最多 ${AI_MAX_ACTIONS_PER_REPLY} 个`);
  expect(REPLY_ACTION_INSTRUCTION).not.toContain(`最多 ${HARD_MAX_ACTIONS_PER_REPLY} 个`);

  const toolset = await createReplyToolset(replyToolContextFixture());

  for (let action: number = 1; action <= HARD_MAX_ACTIONS_PER_REPLY; action++) {
    const result = JSON.parse(await executeAndSettle(toolset,
      SEND_MESSAGE_TOOL,
      JSON.stringify({ text: `第 ${action} 个动作` })
    ));
    expect(result.success).toBe(true);
  }
  const overflow = JSON.parse(await executeAndSettle(toolset,
    SEND_MESSAGE_TOOL,
    JSON.stringify({ text: "第 12 个动作" })
  ));

  expect(toolset.actionsUsed()).toBe(HARD_MAX_ACTIONS_PER_REPLY);
  expect(overflow.error).toContain(`at most ${HARD_MAX_ACTIONS_PER_REPLY} actions`);
  expect(sendMessageMock).toHaveBeenCalledTimes(HARD_MAX_ACTIONS_PER_REPLY);
});

test("reply_to_trigger 请求退化为普通发送时，自录回调不伪造回复关系", async () => {
  sendMessageMock.mockImplementationOnce(async (): Promise<TelegramSendResult> => ({ messageId: 100, repliedToMessageId: undefined }));
  const onMessageSent = mock((..._args: unknown[]): void => {});
  const toolset = await createReplyToolset(replyToolContextFixture({ onMessageSent }));

  const result = JSON.parse(await executeAndSettle(toolset,
    SEND_MESSAGE_TOOL,
    JSON.stringify({ text: "目标已删除也照常发", reply_to_trigger: true })
  ));

  expect(result.success).toBe(true);
  expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -100800, text: "目标已删除也照常发", replyToMessageId: 10 });
  expect(onMessageSent).toHaveBeenCalledWith("目标已删除也照常发", 100, undefined);
});

test("话题群：reply_to_trigger=false 的正文照样带上本轮话题，不掉进 General", async () => {
  // reply_to_trigger=false 时不挂回复，因此没有 reply_parameters 带路，
  // 话题落点只能靠 messageThreadId。
  sendMessageMock.mockImplementationOnce(async (): Promise<TelegramSendResult> => ({ messageId: 101, repliedToMessageId: undefined }));
  const toolset = await createReplyToolset(replyToolContextFixture({ messageThreadId: 77 }));

  const result = JSON.parse(await executeAndSettle(toolset,
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

describe("工具清单恒定", () => {
  test("触发类型、本群问答与手滑抽签都不改变工具声明的任何一个字节", async () => {
    const shapes: string[] = [];
    for (const { mediaToolsRequested, roundHasTypo, chatQa } of cartesianProduct({
      mediaToolsRequested: [false, true],
      roundHasTypo: [false, true],
      chatQa: [undefined, new Map([["怎么入群？", "点置顶那条链接"]])],
    })) {
      const toolset = await createReplyToolset(replyToolContextFixture({ mediaToolsRequested, roundHasTypo, chatQa }));
      shapes.push(JSON.stringify(toolset.functions));
      expect(toolset.toolStatus).toStartWith(TOOL_STATUS_BLOCK_LABEL);
    }
    expect(new Set(shapes).size).toBe(1);
    const sendMessage = JSON.parse(shapes[0]!).find((definition: { name: string }) => definition.name === SEND_MESSAGE_TOOL);
    expect(sendMessage.parametersJsonSchema.required).toEqual(["text"]);
    expect(Object.keys(sendMessage.parametersJsonSchema.properties)).toContain("typo_original_char");
  });

  test("行动总则规定按本轮工具状态行事、失败后不单独作反应", () => {
    expect(REPLY_ACTION_INSTRUCTION).toContain(TOOL_STATUS_BLOCK_LABEL);
    expect(REPLY_ACTION_INSTRUCTION).toContain("标为不可用、冷却中或已用完的工具本轮不要调用");
    expect(REPLY_ACTION_INSTRUCTION).toContain("工具返回 error 表示这个动作没有发生");
    expect(REPLY_ACTION_INSTRUCTION).toContain("对失败本身不单独作反应");
  });
});

describe("群问答工具在按次工具集里的接线", () => {
  test("本群没有问答时两个工具照样挂着，查询如实返回空清单，工具状态写明没有登记", async () => {
    const toolset = await createReplyToolset(replyToolContextFixture());

    expect(toolset.has(GROUP_QA_QUERY_TOOL)).toBe(true);
    expect(toolset.has(GROUP_QA_ANSWER_TOOL)).toBe(true);
    expect(JSON.parse(await executeAndSettle(toolset, GROUP_QA_QUERY_TOOL, "{}"))).toEqual({ questions: [] });
    expect(toolset.toolStatus).toContain(groupQaToolStatus(0));
  });

  test("本群有问答时两个工具都挂上，且 dispatch 真的走到执行器", async () => {
    const toolset = await createReplyToolset(replyToolContextFixture({ chatQa: new Map([["怎么入群？", "点置顶那条链接"]]) }));

    expect(toolset.has(GROUP_QA_QUERY_TOOL)).toBe(true);
    expect(toolset.has(GROUP_QA_ANSWER_TOOL)).toBe(true);
    expect(toolset.toolStatus).toContain(groupQaToolStatus(1));

    // 直接断言 ReplyToolContext.chatQa 被交给执行器，而不只依赖类型保证。
    const listed: { questions: string[] } = JSON.parse(
      await executeAndSettle(toolset, GROUP_QA_QUERY_TOOL, "{}")
    );
    expect(listed.questions).toEqual(["怎么入群？"]);

    const answered: { found: boolean; answer?: string } = JSON.parse(
      await executeAndSettle(toolset, GROUP_QA_ANSWER_TOOL, JSON.stringify({ question: "怎么入群？" }))
    );
    expect(answered.found).toBe(true);
    expect(answered.answer).toBe("点置顶那条链接");
  });

  test("问答工具不消耗整轮可见动作预算", async () => {
    const toolset = await createReplyToolset(replyToolContextFixture({ chatQa: new Map([["a", "1"]]) }));

    // 先把动作预算打到硬顶之上，验证查询工具此时仍不受预算限制。
    for (let index: number = 0; index < HARD_MAX_ACTIONS_PER_REPLY + 1; index++) {
      await executeAndSettle(toolset, GROUP_QA_QUERY_TOOL, "{}");
    }
    const listed: { questions: string[] } = JSON.parse(
      await executeAndSettle(toolset, GROUP_QA_QUERY_TOOL, "{}")
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

  test("两个贴纸工具都从分派表接到本轮共享的菜单与状态", async () => {
    // 看包与发贴纸必须落在同一份菜单和同一份轮内状态上：分派时各建一份的话，
    // 模型按 view 返回的编号去发，发出去的会是另一份菜单里的同号贴纸。
    seedStickerMenu();
    const context = replyToolContextFixture();
    const toolset = await createReplyToolset(context);

    const viewed = JSON.parse(await executeAndSettle(toolset,
      VIEW_STICKER_PACK_TOOL,
      JSON.stringify({ pack_index: 1, intent: "想表达好笑" })
    ));
    expect(viewed.pack).toBe("甲包");
    expect(viewed.stickers).toContain("😂");

    const sent = JSON.parse(await executeAndSettle(toolset,
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
    const toolset = await createReplyToolset(replyToolContextFixture());

    const sent = JSON.parse(await executeAndSettle(toolset,
      SEND_STICKER_TOOL,
      JSON.stringify({ pack_index: 1, sticker_index: 1 })
    ));

    expect(sent.error).toBeDefined();
    expect(sendStickerMock).not.toHaveBeenCalled();
  });

  test("未知工具名走统一错误，不消耗动作预算", async () => {
    seedStickerMenu();
    const toolset = await createReplyToolset(replyToolContextFixture());

    const result = JSON.parse(await executeAndSettle(toolset, "no_such_tool", "{}"));

    expect(result.error).toBeDefined();
    expect(toolset.actionsUsed()).toBe(0);
  });
});
