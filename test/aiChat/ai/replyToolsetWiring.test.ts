/**
 * 按次回复工具集的装配与分派：联网检索与函数工具同时挂载、反应动作的预占与完成计数、
 * 动作数的提示上限与执行硬顶、回复目标与论坛话题落点、工具声明在各种触发下逐字节恒定、
 * 群问答工具接线，以及贴纸工具共享本轮菜单与状态的分派；另核对行动总则与发送、语音
 * 工具提示的关键约束，以及三者按 `agent.tts.bot_language` 取同一份台词语言文案、send_voice 说明
 * 在接管 prompt/voice_tool.md 后改用其正文。
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
import type { AgentDeploymentConfig, TtsBotLanguage } from "../../../packages/types/config";
import type { AiMeteredSpeechRequest, AiWebSearchResult } from "../../../packages/types/aiChat/provider";
import type { SpeechSynthesisAttempt } from "../../../packages/types/aiChat/voiceMessage";
import type { ReplyToolset } from "../../../packages/types/aiChat/replies";
import type * as AiProviderModule from "../../../packages/aiChat/provider";

const {
  ADD_REACTION_TOOL,
  GROUP_QA_ANSWER_TOOL,
  GROUP_QA_QUERY_TOOL,
  SEND_MESSAGE_TOOL,
  SEND_STICKER_TOOL,
  SEND_VOICE_TOOL,
  VIEW_STICKER_PACK_TOOL,
  WEB_SEARCH_TOOL,
} = await import("../../../packages/consts/tools");
const { adoptAgentDeploymentConfig, getAgentDeploymentConfig } = await import("../../../packages/config/agent");
const { voiceToolPromptCache } = await import("../../../packages/cache/perThread/config");
const { resetAiProviderFacades } = await import("../../../packages/cache/workers/aiChat/providerScheduler");
const {
  AI_MAX_ACTIONS_PER_REPLY,
  HARD_MAX_ACTIONS_PER_REPLY,
} = await import("../../../packages/consts/aiChat/tools");
const {
  TOOL_STATUS_BLOCK_LABEL,
  VOICE_LANGUAGE_PROMPTS,
  groupQaToolStatus,
  webSearchToolStatus,
} = await import("../../../packages/consts/aiChat/prompts/tools");
const { TTS_BOT_LANGUAGES, TTS_DEFAULT_BOT_LANGUAGE } = await import("../../../packages/consts/aiChat/voiceMessage");
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

test("语音说过的意思不得再用文字重发：每种台词语言的三处提示都按语义而非字面约束", () => {
  for (const language of TTS_BOT_LANGUAGES) {
    const { sendMessageInstruction, sendVoiceInstruction, replyActionInstruction } = VOICE_LANGUAGE_PROMPTS[language];
    expect(sendMessageInstruction).toContain("send_voice 念过的台词");
    expect(sendMessageInstruction).toContain("（发送了一条语音：…）");
    expect(sendMessageInstruction).toContain("按意思判断");
    expect(sendVoiceInstruction).toContain("语音里已经说过的意思不要再用 send_message 发一遍");
    expect(sendVoiceInstruction).toContain("按意思判断");
    expect(sendVoiceInstruction).toContain("文字只发语音之外的内容");
    expect(replyActionInstruction).toContain("正文、图片 caption 与语音台词共用这条规则");
    expect(replyActionInstruction).toContain("把语音里说过的话再发成文字，同样算重复");
  }
  expect(VOICE_LANGUAGE_PROMPTS.ja.sendMessageInstruction).toContain("翻成中文、换个说法或加上注释再发出来都算重复");
  expect(VOICE_LANGUAGE_PROMPTS.ja.replyActionInstruction).toContain("用中文或其它语言把语音里说过的话再发成文字，同样算重复");
});

test("台词语言闭集与文案注册表的键一一对应", () => {
  expect(Object.keys(VOICE_LANGUAGE_PROMPTS).toSorted()).toEqual(TTS_BOT_LANGUAGES.toSorted());
});

test("每种台词语言的 send_voice 说明与参数说明都写明各自的语言，其余语言的名字不作台词语言出现", () => {
  const names: Readonly<Record<TtsBotLanguage, string>> = { en: "英语", zh: "中文", ja: "日语" };
  for (const language of TTS_BOT_LANGUAGES) {
    const prompts = VOICE_LANGUAGE_PROMPTS[language];
    const name: string = names[language];
    expect(prompts.sendVoiceInstruction).toContain(`发一条${name}语音`);
    expect(prompts.sendVoiceInstruction).toContain(`text 只写要念出来的${name}台词`);
    expect(prompts.voiceTextDescription).toContain(`${name}台词原文`);
    expect(prompts.voiceToneDescription).toContain(`用${name}简短描述`);
    expect(prompts.sendMessageInstruction).toContain(`台词是${name}`);
    expect(prompts.replyActionInstruction).toContain(`语音台词是${name}`);
    for (const other of TTS_BOT_LANGUAGES) {
      if (other === language) continue;
      expect(prompts.sendVoiceInstruction).not.toContain(`发一条${names[other]}语音`);
      expect(prompts.voiceTextDescription).not.toContain(`${names[other]}台词`);
    }
  }
});

test("回复提示把独立文字限死在 send_message，媒体配文走对应 caption，最终响应不得夹带正文", () => {
  for (const language of TTS_BOT_LANGUAGES) {
    const { sendMessageInstruction, replyActionInstruction } = VOICE_LANGUAGE_PROMPTS[language];
    expect(sendMessageInstruction).toContain("主回复、贴纸说明、动作之后的补充文字都必须显式调用");
    expect(replyActionInstruction).toContain("独立文字只用 send_message");
    expect(sendMessageInstruction).toContain("写进 generate_image 的 caption");
    expect(replyActionInstruction).toContain("随附文字写进 generate_image 的 caption，不要再复述");
    expect(replyActionInstruction).toContain("最终响应保持空白");
  }
});

test("模型提示按 AI_MAX_ACTIONS_PER_REPLY 限制动作数，执行侧留余量到 HARD_MAX_ACTIONS_PER_REPLY 才触发硬顶", async () => {
  expect(HARD_MAX_ACTIONS_PER_REPLY).toBeGreaterThan(AI_MAX_ACTIONS_PER_REPLY);
  for (const language of TTS_BOT_LANGUAGES) {
    expect(VOICE_LANGUAGE_PROMPTS[language].replyActionInstruction).toContain(`最多 ${AI_MAX_ACTIONS_PER_REPLY} 个`);
    expect(VOICE_LANGUAGE_PROMPTS[language].replyActionInstruction).not.toContain(`最多 ${HARD_MAX_ACTIONS_PER_REPLY} 个`);
  }

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
    for (const language of TTS_BOT_LANGUAGES) {
      const { replyActionInstruction } = VOICE_LANGUAGE_PROMPTS[language];
      expect(replyActionInstruction).toContain(TOOL_STATUS_BLOCK_LABEL);
      expect(replyActionInstruction).toContain("标为不可用、冷却中或已用完的工具本轮不要调用");
      expect(replyActionInstruction).toContain("工具返回 error 表示这个动作没有发生");
      expect(replyActionInstruction).toContain("对失败本身不单独作反应");
    }
  });

  /** 本轮工具集里某个工具声明的说明。 */
  function description(toolset: ReplyToolset, name: string): string | undefined {
    return toolset.functions.find((definition) => definition.name === name)?.description;
  }

  /** send_voice 声明里 text 与 tone 两个参数的说明。 */
  function parameterDescriptions(toolset: ReplyToolset): unknown {
    const schema = toolset.functions.find((definition) => definition.name === SEND_VOICE_TOOL)!.parametersJsonSchema;
    const properties = (schema as { properties: Record<string, { description: string }> }).properties;
    return [properties.text!.description, properties.tone!.description];
  }

  test("send_message、send_voice 的声明与行动段按本轮 bot_language 取同一份文案；tts 缺省时按默认语言", async () => {
    const configured: AgentDeploymentConfig = getAgentDeploymentConfig();
    const tts = configured.tts!;
    try {
      const shapes: Set<string> = new Set<string>();
      for (const language of TTS_BOT_LANGUAGES) {
        adoptAgentDeploymentConfig({ ...configured, tts: { ...tts, botLanguage: language } });
        resetAiProviderFacades();
        const toolset: ReplyToolset = await createReplyToolset(replyToolContextFixture());
        const prompts = VOICE_LANGUAGE_PROMPTS[language];
        expect(description(toolset, SEND_MESSAGE_TOOL)).toBe(prompts.sendMessageInstruction);
        expect(description(toolset, SEND_VOICE_TOOL)).toBe(prompts.sendVoiceInstruction);
        expect(parameterDescriptions(toolset)).toEqual([prompts.voiceTextDescription, prompts.voiceToneDescription]);
        expect(toolset.replyActionInstruction).toBe(prompts.replyActionInstruction);
        shapes.add(JSON.stringify(toolset.functions));
      }
      expect(shapes.size).toBe(TTS_BOT_LANGUAGES.length);

      adoptAgentDeploymentConfig({ ...configured, tts: undefined });
      resetAiProviderFacades();
      const withoutTts: ReplyToolset = await createReplyToolset(replyToolContextFixture());
      const fallback = VOICE_LANGUAGE_PROMPTS[TTS_DEFAULT_BOT_LANGUAGE];
      expect(withoutTts.has(SEND_VOICE_TOOL)).toBe(false);
      expect(description(withoutTts, SEND_MESSAGE_TOOL)).toBe(fallback.sendMessageInstruction);
      expect(withoutTts.replyActionInstruction).toBe(fallback.replyActionInstruction);
    } finally {
      adoptAgentDeploymentConfig(configured);
      resetAiProviderFacades();
    }
  });

  test("接管了 voice_tool.md 时 send_voice 说明在每种 bot_language 下都取其正文，参数说明与其余文案仍按语言选取", async () => {
    const configured: AgentDeploymentConfig = getAgentDeploymentConfig();
    const tts = configured.tts!;
    const preloadedPrompt: string | null = voiceToolPromptCache.current;
    const customPrompt: string = "部署方自定义的语音工具说明";
    voiceToolPromptCache.current = customPrompt;
    try {
      for (const language of TTS_BOT_LANGUAGES) {
        adoptAgentDeploymentConfig({ ...configured, tts: { ...tts, botLanguage: language } });
        resetAiProviderFacades();
        const toolset: ReplyToolset = await createReplyToolset(replyToolContextFixture());
        const prompts = VOICE_LANGUAGE_PROMPTS[language];
        expect(description(toolset, SEND_VOICE_TOOL)).toBe(customPrompt);
        expect(parameterDescriptions(toolset)).toEqual([prompts.voiceTextDescription, prompts.voiceToneDescription]);
        expect(description(toolset, SEND_MESSAGE_TOOL)).toBe(prompts.sendMessageInstruction);
        expect(toolset.replyActionInstruction).toBe(prompts.replyActionInstruction);
      }
    } finally {
      voiceToolPromptCache.current = preloadedPrompt;
      adoptAgentDeploymentConfig(configured);
      resetAiProviderFacades();
    }
  });

  test("send_voice 的合成请求按本轮 bot_language 带上该语言的朗读语言要求", async () => {
    const configured: AgentDeploymentConfig = getAgentDeploymentConfig();
    const tts = configured.tts!;
    const synthesizeSpeech: Mock<(request: AiMeteredSpeechRequest) => Promise<SpeechSynthesisAttempt>> =
      mock(async (): Promise<SpeechSynthesisAttempt> => ({ ok: false, reason: "synthesis failed" }));
    const providerMock: Mock<typeof providerModule.ttsAiProvider> = spyOn(providerModule, "ttsAiProvider")
      .mockReturnValue({ name: tts.provider, synthesizeSpeech });
    try {
      for (const language of TTS_BOT_LANGUAGES) {
        adoptAgentDeploymentConfig({ ...configured, tts: { ...tts, botLanguage: language } });
        const toolset: ReplyToolset = await createReplyToolset(replyToolContextFixture());
        await executeAndSettle(toolset, SEND_VOICE_TOOL, JSON.stringify({ text: "line" }));
        expect(synthesizeSpeech.mock.calls.at(-1)![0].languageStyle)
          .toBe(VOICE_LANGUAGE_PROMPTS[language].speechLanguageStyle);
      }
      expect(synthesizeSpeech).toHaveBeenCalledTimes(TTS_BOT_LANGUAGES.length);
      const styles: Set<string> = new Set<string>();
      for (const language of TTS_BOT_LANGUAGES) styles.add(VOICE_LANGUAGE_PROMPTS[language].speechLanguageStyle);
      expect(styles.size).toBe(TTS_BOT_LANGUAGES.length);
    } finally {
      providerMock.mockRestore();
      adoptAgentDeploymentConfig(configured);
      resetAiProviderFacades();
    }
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
