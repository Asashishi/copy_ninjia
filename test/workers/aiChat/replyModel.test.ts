import { adoptPersona, getPersona } from "../../../packages/config/persona";
import { personaCache } from "../../../packages/cache/perThread/config";
import { DEFAULT_AI_PERSONA } from "../../../packages/consts/aiChat/prompts/persona";
/**
 * 回复循环的供应商中立行为：提示词分段、上下文区块顺序、整轮函数调用预算、
 * 联网检索软额度记账、工具轮往返与收尾。
 *
 * 贯穿全文件的一条不变量：**一轮回复里 functions 与 webSearchEnabled 逐字恒定**，
 * 任何预算都不得改变工具形态（唯一例外是 toolCallLimitHit 的一次降级重试）。
 *
 * 这里把供应商整个 mock 掉——循环只该认 AiReplySession 契约。各供应商实现包分别
 * 把中立请求映射成自家请求体的部分，由 test/aiChat/gemini/replySession.test.ts
 * 与 test/aiChat/openai/replySession.test.ts 分别覆盖。
 */

import { beforeEach, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { AI_CHAT_AGENT_ROLE_INSTRUCTION } from "../../../packages/consts/aiChat/prompts/agent";
import {
  CHAT_INTERACTION_INSTRUCTION,
  CHAT_MEMORY_PRIORITY_INSTRUCTION,
  DIRECT_INVOCATION_READING_INSTRUCTION,
  MEMORY_MECHANISM_SILENCE_INSTRUCTION,
  REPLY_CONTEXT_STRUCTURE_INSTRUCTION,
  TRANSCRIPT_FORMAT_INSTRUCTION,
} from "../../../packages/consts/aiChat/prompts/memory";
import { MOOD_STATE_PRECEDENCE_INSTRUCTION } from "../../../packages/consts/aiChat/prompts/mood";
import {
  HARD_MAX_ACTIONS_PER_REPLY,
  MAX_CUSTOM_TOOL_CALLS_PER_REPLY,
  MAX_WEB_SEARCH_CALLS_PER_REPLY,
  MAX_TOOL_ROUNDS,
} from "../../../packages/consts/aiChat/tools";
import {
  WEB_SEARCH_DECISION_INSTRUCTION,
  WEB_SEARCH_FUNCTION_INSTRUCTION,
  WEB_SEARCH_INSTRUCTION,
} from "../../../packages/consts/aiChat/prompts/search";
import {
  COLD_MEMORY_BLOCK_NAME,
  FORWARD_ROSTER_BLOCK_NAME,
  HOT_MEMORY_BLOCK_NAME,
  SPEAKER_ROSTER_BLOCK_NAME,
} from "../../../packages/consts/aiChat/prompts/transcript";
import { VOICE_LANGUAGE_PROMPTS } from "../../../packages/consts/aiChat/prompts/tools";
import {
  ADD_REACTION_TOOL,
  GENERATE_IMAGE_TOOL,
  SEND_MESSAGE_TOOL,
  SEND_STICKER_TOOL,
  VIEW_STICKER_PACK_TOOL,
  WEB_SEARCH_TOOL,
} from "../../../packages/consts/tools";
import type { ReplyPromptSections, ReplyToolset, WebSearchToolOutcome } from "../../../packages/types/aiChat/replies";
import type {
  AiFunctionCall,
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiToolDefinition,
  AiToolOutput,
} from "../../../packages/types/aiChat/provider";

const turns: AiReplyTurn[] = [];
const requests: AiReplyTurnRequest[] = [];
const appendedOutputs: AiToolOutput[][] = [];
let sessionParams: AiReplySessionParams | undefined;
let appendSucceeds: boolean = true;

const REQUEST_FAILURE: AiReplyTurn = {
  ok: false,
  text: null,
  functionCalls: [],
  webSearchCalls: 0,
  toolCallLimitHit: false,
};

const requestMock = mock(async (request: AiReplyTurnRequest): Promise<AiReplyTurn> => {
  requests.push(request);
  return turns.shift() ?? REQUEST_FAILURE;
});

const session: AiReplySession = {
  request: requestMock,
  appendToolOutputs: (outputs: readonly AiToolOutput[]): boolean => {
    appendedOutputs.push([...outputs]);
    return appendSucceeds;
  },
};

const callToolMock = mock(async (..._args: unknown[]): Promise<string> => JSON.stringify({ success: true }));
const loggerErrorMock = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/aiChat/provider", () => ({
  textAiProvider: () => ({
    name: "google",
    createReplySession: (params: AiReplySessionParams): AiReplySession => {
      sessionParams = params;
      return session;
    },
  }),
}));
mock.module("../../../packages/aiChat/ai/mood", () => ({ currentMoodInstruction: (): string => "当前心情测试" }));
mock.module("../../../packages/aiChat/ai/tools", () => ({ callTool: callToolMock }));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerErrorMock }) }));
mock.module("../../../packages/aiChat/ai/timeSentence", () => ({ currentTimeSentence: (): string => "当前实际时间：测试。" }));

const { generateReply } = await import("../../../packages/workers/aiChat/replyModel");

/** 一次正常收尾的模型轮次。 */
function okTurn(options: {
  text?: string;
  calls?: readonly AiFunctionCall[];
  webSearchCalls?: number;
}): AiReplyTurn {
  return {
    ok: true,
    text: options.text ?? null,
    functionCalls: options.calls ?? [],
    webSearchCalls: options.webSearchCalls ?? 0,
    toolCallLimitHit: false,
  };
}

/** 一次不可用的模型轮次。 */
function failTurn(options: {
  finishReason?: string;
  finishDetails?: string;
  toolCallLimitHit?: boolean;
  webSearchCalls?: number;
}): AiReplyTurn {
  return {
    ok: false,
    text: null,
    functionCalls: [],
    webSearchCalls: options.webSearchCalls ?? 0,
    finishReason: options.finishReason,
    finishDetails: options.finishDetails,
    toolCallLimitHit: options.toolCallLimitHit ?? false,
  };
}

function call(name: string, args: Record<string, unknown> = {}): AiFunctionCall {
  return { id: `call-${name}`, name, argumentsJson: JSON.stringify(args) };
}

function declaration(name: string): AiToolDefinition {
  return { name, description: `${name} 工具`, parametersJsonSchema: { type: "object", properties: {} } };
}

function toolset(overrides: Partial<ReplyToolset> = {}): ReplyToolset {
  return {
    functions: [],
    toolStatus: "",
    webSearch: false,
    searchWeb: null,
    replyActionInstruction: VOICE_LANGUAGE_PROMPTS.en.replyActionInstruction,
    has: (): boolean => false,
    beforeModelRequest: (): void => {},
    afterModel: (): void => {},
    execute: (): string => JSON.stringify({ success: true }),
    actionsUsed: (): number => 0,
    settle: async (): Promise<void> => {},
    actionsCompleted: (): number => 0,
    isActive: (): boolean => true,
    ...overrides,
  };
}

function promptSections(label: string): ReplyPromptSections {
  return {
    referenceMemory: `${label}：参考记忆`,
    currentConversation: `${label}：当前会话`,
    currentConversationSettledOffsets: [4],
    replyTask: `${label}：回复任务`,
  };
}

/** init 接管的本进程人设；改写它的用例结束后还原。 */
const PRELOADED_PERSONA: string | null = personaCache.current;

beforeEach(() => {
  personaCache.current = PRELOADED_PERSONA;
  turns.length = 0;
  requests.length = 0;
  appendedOutputs.length = 0;
  sessionParams = undefined;
  appendSucceeds = true;
  requestMock.mockClear();
  callToolMock.mockClear();
  loggerErrorMock.mockClear();
});

test("直接触发按序传四个上下文区块，工具结果回喂后续跑", async () => {
  turns.push(
    okTurn({ calls: [call(SEND_MESSAGE_TOOL, { text: "已核实回复" })] }),
    okTurn({ text: "行动完成" })
  );
  const execute = mock((..._args: unknown[]): string => JSON.stringify({ success: true }));
  const sections: ReplyPromptSections = promptSections("聊天上下文");

  await expect(generateReply(-1001, sections, toolset({
    functions: [declaration(SEND_MESSAGE_TOOL)],
    webSearch: true,
    has: (name: string): boolean => name === SEND_MESSAGE_TOOL,
    execute,
    actionsUsed: (): number => 1,
  }))).resolves.toBe("行动完成");

  expect(requestMock).toHaveBeenCalledTimes(2);
  // 稳定区块只有参考记忆，跨轮不变。
  expect(sessionParams?.stableBlocks).toEqual([sections.referenceMemory]);
  // 易变区块按转录 → 运行时状态 → 回复任务排列，运行时状态夹在中间。
  expect(sessionParams?.volatileBlocks).toHaveLength(3);
  expect(sessionParams?.volatileBlocks?.[0]).toBe(sections.currentConversation);
  expect(sessionParams?.volatileBlocks?.[1]).toContain("[BEGIN CURRENT_RUNTIME_STATE]");
  expect(sessionParams?.volatileBlocks?.[1]).toContain(MOOD_STATE_PRECEDENCE_INSTRUCTION);
  expect(sessionParams?.volatileBlocks?.[1]).toContain("当前实际时间：");
  expect(sessionParams?.volatileBlocks?.[2]).toBe(sections.replyTask);
  // 转录已定切点随当前会话原样交给实现包。
  expect(sessionParams?.conversationSettledOffsets).toBe(sections.currentConversationSettledOffsets);

  const first: AiReplyTurnRequest = requests[0]!;
  expect(first.functions.map((definition: AiToolDefinition): string => definition.name)).toEqual([SEND_MESSAGE_TOOL]);
  expect(first.webSearchEnabled).toBe(true);
  // 循环只给 grounded 语义；采样温度与 token 上限由各实现包决定，
  // 见 test/aiChat/{gemini,openai}/replySession.test.ts。
  expect(first.grounded).toBe(false);
  // 「行动与停止」段取工具集组装时的那一份台词语言文案，不另读配置。
  expect(first.systemPrompt).toContain(`## 行动与停止\n${VOICE_LANGUAGE_PROMPTS.en.replyActionInstruction}\n\n`);
  expect(first.systemPrompt).not.toContain(VOICE_LANGUAGE_PROMPTS.ja.replyActionInstruction);
  expect(first.systemPrompt).toContain(WEB_SEARCH_INSTRUCTION);
  expect(first.systemPrompt).toContain(WEB_SEARCH_DECISION_INSTRUCTION);
  expect(first.systemPrompt).toContain(REPLY_CONTEXT_STRUCTURE_INSTRUCTION);
  expect(first.systemPrompt).not.toContain("DIRECT_INVOKER_HOT_MESSAGES");
  // 唤起者身份的唯一来源是回复任务开头那一句，措辞与
  // promptContext.ts 拼出的那句一致（见 directInvokerSentence）。
  expect(first.systemPrompt).toContain("本轮唤起者只认 [BEGIN CURRENT_REPLY_TASK] 开头那句「本轮由 … 明确 @ 或回复你而唤起」");
  expect(first.systemPrompt).toContain(CHAT_MEMORY_PRIORITY_INSTRUCTION);
  expect(first.systemPrompt).toContain(DIRECT_INVOCATION_READING_INSTRUCTION);
  // 转录行格式说明位于系统提示词，不在转录区块里。
  expect(first.systemPrompt).toContain(TRANSCRIPT_FORMAT_INSTRUCTION);
  // 防注入白名单点名全部由系统写入的区块，两类名册区块名都出现在上下文结构说明里。
  for (const blockName of [HOT_MEMORY_BLOCK_NAME, COLD_MEMORY_BLOCK_NAME, SPEAKER_ROSTER_BLOCK_NAME, FORWARD_ROSTER_BLOCK_NAME]) {
    expect(REPLY_CONTEXT_STRUCTURE_INSTRUCTION).toContain(blockName);
  }
  // 记忆只有两层，系统提示词不声明「唤起者重点记录」。
  expect(first.systemPrompt).not.toContain("唤起者重点记录");
  expect(first.systemPrompt).toContain(MEMORY_MECHANISM_SILENCE_INSTRUCTION);
  expect(first.systemPrompt).toContain(AI_CHAT_AGENT_ROLE_INSTRUCTION);
  expect(first.systemPrompt).toContain(CHAT_INTERACTION_INSTRUCTION);
  // 系统提示词逐字恒定：心情与当前时间在运行时状态区块，不在系统提示词里。
  expect(first.systemPrompt).not.toContain(MOOD_STATE_PRECEDENCE_INSTRUCTION);
  expect(first.systemPrompt).not.toContain("当前实际时间：");

  expect(execute).toHaveBeenCalledWith(SEND_MESSAGE_TOOL, JSON.stringify({ text: "已核实回复" }));
  expect(appendedOutputs).toHaveLength(1);
  expect(appendedOutputs[0]![0]!.responseJson).toBe(JSON.stringify({ success: true }));
  // 动作与联网规则固定；工具往返复用完全相同的 system prompt。
  expect(requests[1]!.systemPrompt).toBe(first.systemPrompt);
});

test("每次请求模型前先调 beforeModelRequest，再发请求", async () => {
  turns.push(
    okTurn({ calls: [call(SEND_MESSAGE_TOOL, { text: "第一句" })] }),
    okTurn({ text: "行动完成" })
  );
  // 记下每个时点已经发出的请求数，得出调用先后。
  const order: string[] = [];
  await generateReply(-1001, promptSections("聊天上下文"), toolset({
    functions: [declaration(SEND_MESSAGE_TOOL)],
    has: (name: string): boolean => name === SEND_MESSAGE_TOOL,
    beforeModelRequest: (): void => { order.push(`before request ${requests.length + 1}`); },
    afterModel: (): void => {},
    execute: (): string => {
      order.push(`execute after request ${requests.length}`);
      return JSON.stringify({ success: true });
    },
    actionsUsed: (): number => 1,
  }));
  expect(order).toEqual(["before request 1", "execute after request 1", "before request 2"]);
  expect(requestMock).toHaveBeenCalledTimes(2);
});

test("非直接触发同样只传四个区块，区块数与触发类型无关", async () => {
  turns.push(okTurn({ text: "随机插话" }));
  const sections: ReplyPromptSections = {
    referenceMemory: "参考记忆",
    currentConversation: "当前会话",
    currentConversationSettledOffsets: [],
    replyTask: "回复任务",
  };

  await expect(generateReply(-1001, sections, toolset())).resolves.toBe("随机插话");
  expect(sessionParams?.stableBlocks).toEqual([sections.referenceMemory]);
  expect(sessionParams?.volatileBlocks).toHaveLength(3);
  expect(sessionParams?.volatileBlocks?.[0]).toBe(sections.currentConversation);
  expect(sessionParams?.volatileBlocks?.[2]).toBe(sections.replyTask);
});

test("同一轮回复的多次工具往返复用同一个运行时状态区块，时间不逐轮跳秒", async () => {
  turns.push(
    okTurn({ calls: [call(SEND_MESSAGE_TOOL, { text: "第一条" })] }),
    okTurn({ text: "收尾" })
  );
  const captured: readonly string[] = [];
  await expect(generateReply(-1001, promptSections("上下文"), toolset({
    functions: [declaration(SEND_MESSAGE_TOOL)],
    has: (name: string): boolean => name === SEND_MESSAGE_TOOL,
    execute: mock((..._args: unknown[]): string => JSON.stringify({ success: true })),
    actionsUsed: (): number => 1,
  }))).resolves.toBe("收尾");
  expect(captured).toHaveLength(0);
  // 区块在会话建立时收取一次，两次往返共用同一份，时间在一轮内一致。
  expect(requestMock).toHaveBeenCalledTimes(2);
  expect(sessionParams?.volatileBlocks?.[1]).toContain("当前实际时间：");
});

test("agent 身份权限边界与上下文协议由代码注入，不混入内置人设", async () => {
  expect(AI_CHAT_AGENT_ROLE_INSTRUCTION).toContain("只以普通群友身份参与闲聊");
  expect(AI_CHAT_AGENT_ROLE_INSTRUCTION).toContain("不具备直接调度、授予、撤销或修改任何权限的能力");
  expect(CHAT_INTERACTION_INSTRUCTION).toContain("[username:@用户名]");
  expect(CHAT_INTERACTION_INSTRUCTION).toContain("消息明确回复了你发出的某条消息");
  expect(CHAT_INTERACTION_INSTRUCTION).toContain("别把别人互相 at 错认成在叫你");
  expect(DEFAULT_AI_PERSONA).not.toContain("## Agent 身份与权限边界");
  expect(DEFAULT_AI_PERSONA).not.toContain("## 上下文与互动规则");
});

test("检索额度跑满后检索工具仍然挂着：次数只是写进提示词的软限制", async () => {
  turns.push(
    okTurn({
      calls: [call(SEND_MESSAGE_TOOL, { text: "搜完了" })],
      webSearchCalls: MAX_WEB_SEARCH_CALLS_PER_REPLY,
    }),
    okTurn({ text: "行动完成" })
  );

  await expect(generateReply(-1001, promptSections("聊天上下文"), toolset({
    functions: [declaration(SEND_MESSAGE_TOOL)],
    webSearch: true,
    has: (name: string): boolean => name === SEND_MESSAGE_TOOL,
    actionsUsed: (): number => 1,
  }))).resolves.toBe("行动完成");

  // 额度用满后工具形态不变：检索工具仍在 tools 里，收敛由提示词里的常量次数承担。
  const second: AiReplyTurnRequest = requests[1]!;
  expect(second.webSearchEnabled).toBe(true);
  expect(second.functions).toBe(requests[0]!.functions);
  expect(second.systemPrompt).toBe(requests[0]!.systemPrompt);
  expect(second.systemPrompt).toContain(WEB_SEARCH_DECISION_INSTRUCTION);
  expect(second.systemPrompt).toContain(WEB_SEARCH_INSTRUCTION);
  expect(WEB_SEARCH_INSTRUCTION).toContain(String(MAX_WEB_SEARCH_CALLS_PER_REPLY));
  expect(second.grounded).toBe(true);
});

test("搜过且仍有额度时保持固定联网规则并标记 grounded", async () => {
  turns.push(
    okTurn({ calls: [call(SEND_MESSAGE_TOOL, { text: "搜完了" })], webSearchCalls: 1 }),
    okTurn({ text: "行动完成" })
  );

  await expect(generateReply(-1001, promptSections("聊天上下文"), toolset({
    functions: [declaration(SEND_MESSAGE_TOOL)],
    webSearch: true,
    has: (name: string): boolean => name === SEND_MESSAGE_TOOL,
    actionsUsed: (): number => 1,
  }))).resolves.toBe("行动完成");

  const second: AiReplyTurnRequest = requests[1]!;
  expect(second.webSearchEnabled).toBe(true);
  expect(second.systemPrompt).toBe(requests[0]!.systemPrompt);
  expect(second.systemPrompt).toContain(WEB_SEARCH_INSTRUCTION);
  expect(second.grounded).toBe(true);
});

test("供应商报服务端工具调用超限时，零动作轮关闭检索后只重试一次", async () => {
  turns.push(
    failTurn({ finishReason: "TOO_MANY_TOOL_CALLS", toolCallLimitHit: true }),
    okTurn({ text: "不再搜索，直接回答" })
  );

  await expect(generateReply(-1001, promptSections("聊天上下文"), toolset({
    functions: [declaration(SEND_MESSAGE_TOOL)],
    webSearch: true,
  }))).resolves.toBe("不再搜索，直接回答");

  expect(requestMock).toHaveBeenCalledTimes(2);
  expect(requests[1]!.webSearchEnabled).toBe(false);
  expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("retrying once with web search disabled"));
});

test("已经产生外部副作用后遇到工具调用超限不做降级重试", async () => {
  turns.push(failTurn({ finishReason: "TOO_MANY_TOOL_CALLS", toolCallLimitHit: true }));

  await expect(generateReply(-1001, promptSections("上下文"), toolset({
    functions: [declaration(SEND_MESSAGE_TOOL)],
    webSearch: true,
    actionsUsed: (): number => 1,
  }))).resolves.toBeNull();
  expect(requestMock).toHaveBeenCalledTimes(1);
});

test("配置了独立 web_search 时，服务端工具调用超限不会触发关闭内建搜索的降级重试", async () => {
  turns.push(failTurn({ finishReason: "TOO_MANY_TOOL_CALLS", toolCallLimitHit: true }));
  const searchWeb: Mock<(argumentsJson: string) => Promise<WebSearchToolOutcome>> = mock(async (_argumentsJson: string): Promise<WebSearchToolOutcome> =>
    ({ result: JSON.stringify({ result: "资料" }), searchCalls: 1 }));

  await expect(generateReply(-1001, promptSections("上下文"), toolset({
    functions: [declaration(WEB_SEARCH_TOOL)],
    webSearch: false,
    searchWeb,
  }))).resolves.toBeNull();

  expect(requestMock).toHaveBeenCalledTimes(1);
  expect(requests[0]!.webSearchEnabled).toBe(false);
  expect(requests[0]!.functions.map((definition: AiToolDefinition): string => definition.name)).toContain(WEB_SEARCH_TOOL);
  expect(searchWeb).not.toHaveBeenCalled();
  expect(loggerErrorMock).not.toHaveBeenCalledWith(expect.stringContaining("retrying once with web search disabled"));
});

test("同一模型响应中的多个行动工具严格按返回顺序逐个接纳", async () => {
  turns.push(
    okTurn({ calls: [call(GENERATE_IMAGE_TOOL, { prompt: "画一只猫" }), call(SEND_MESSAGE_TOOL, { text: "画好了" })] }),
    okTurn({})
  );

  const executionOrder: string[] = [];
  const execute = mock((name: string): string => {
    executionOrder.push(name);
    return JSON.stringify({ success: true });
  });

  await expect(generateReply(-1001, promptSections("聊天上下文"), toolset({
    functions: [declaration(GENERATE_IMAGE_TOOL), declaration(SEND_MESSAGE_TOOL)],
    webSearch: true,
    has: (): boolean => true,
    execute,
    actionsUsed: (): number => 2,
  }))).resolves.toBeNull();
  expect(executionOrder).toEqual([GENERATE_IMAGE_TOOL, SEND_MESSAGE_TOOL]);
});

test("模型轮次不可用时零执行、零最终文本并记录诊断", async () => {
  turns.push(failTurn({ finishReason: "PROHIBITED_CONTENT" }));
  const execute = mock((): string => JSON.stringify({ success: true }));

  await expect(generateReply(-1001, promptSections("上下文"), toolset({
    functions: [declaration(SEND_MESSAGE_TOOL)],
    has: (): boolean => true,
    execute,
  }))).resolves.toBeNull();
  expect(execute).not.toHaveBeenCalled();
  expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("finish_reason=PROHIBITED_CONTENT, side_effects="));
});

test("不可用轮次的收尾详情原样写进诊断", async () => {
  const finishDetails: string = JSON.stringify({ type: "refusal", category: "cyber", explanation: "declined" });
  turns.push(failTurn({ finishReason: "refusal", finishDetails }));

  await expect(generateReply(-1001, promptSections("上下文"), toolset({
    functions: [declaration(SEND_MESSAGE_TOOL)],
    has: (): boolean => true,
  }))).resolves.toBeNull();
  expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining(`finish_reason=refusal, details=${finishDetails}, side_effects=`));
});

test("请求在途时被禁用，响应回来后不再执行任何行动", async () => {
  let active: boolean = true;
  requestMock.mockImplementationOnce(async (request: AiReplyTurnRequest): Promise<AiReplyTurn> => {
    requests.push(request);
    active = false;
    return okTurn({ text: "迟到的搜索资料" });
  });

  await expect(generateReply(-1001, promptSections("聊天上下文"), toolset({
    functions: [declaration(SEND_MESSAGE_TOOL)],
    webSearch: true,
    isActive: (): boolean => active,
  }))).resolves.toBeNull();
  expect(requestMock).toHaveBeenCalledTimes(1);
});

test("会话交不出可续接的模型轮次时，本轮就此收尾", async () => {
  appendSucceeds = false;
  turns.push(okTurn({ calls: [call(SEND_MESSAGE_TOOL, { text: "发一条" })] }), okTurn({ text: "不该跑到这里" }));
  const execute = mock((): string => JSON.stringify({ success: true }));

  await expect(generateReply(-1001, promptSections("上下文"), toolset({
    functions: [declaration(SEND_MESSAGE_TOOL)],
    has: (): boolean => true,
    execute,
  }))).resolves.toBeNull();
  // 工具已经执行过（副作用当场发生），但不再发下一次请求。
  expect(execute).toHaveBeenCalledTimes(1);
  expect(requestMock).toHaveBeenCalledTimes(1);
  // 回复轮对 null 结果不记零动作，原因只由模型侧这一行记录。
  expect(loggerErrorMock).toHaveBeenCalledWith(
    "AI reply session could not continue after tool outputs for chat -1001: round=0, custom_calls=1, side_effects=0."
  );
});

test("不存在通用单工具四次上限，无效调用只受整轮总预算约束", async () => {
  for (let index = 0; index < 5; index++) {
    turns.push(okTurn({ calls: [call(VIEW_STICKER_PACK_TOOL)] }));
  }
  turns.push(okTurn({ text: "不再重试" }));
  const execute = mock((): string => JSON.stringify({ error: "invalid arguments" }));

  await expect(generateReply(-1001, promptSections("错拼角色名"), toolset({
    functions: [declaration(VIEW_STICKER_PACK_TOOL)],
    has: (): boolean => true,
    execute,
  }))).resolves.toBe("不再重试");
  expect(execute).toHaveBeenCalledTimes(5);
  expect(requests[5]!.functions.map((definition: AiToolDefinition): string => definition.name))
    .toEqual([VIEW_STICKER_PACK_TOOL]);
});

test("四类可见动作共享十一动作硬顶：达到后工具声明一个字都不变", async () => {
  const actionSequence: string[] = [
    ...Array.from({ length: HARD_MAX_ACTIONS_PER_REPLY - 3 }, (): string => SEND_MESSAGE_TOOL),
    SEND_STICKER_TOOL,
    ADD_REACTION_TOOL,
    GENERATE_IMAGE_TOOL,
  ];
  for (const name of actionSequence) turns.push(okTurn({ calls: [call(name)] }));
  turns.push(okTurn({ text: "动作完成" }));

  let actionsUsed: number = 0;
  const execute = mock((): string => {
    actionsUsed++;
    return JSON.stringify({ success: true });
  });

  await expect(generateReply(-1001, promptSections("混合动作"), toolset({
    functions: [
      declaration(SEND_MESSAGE_TOOL),
      declaration(SEND_STICKER_TOOL),
      declaration(ADD_REACTION_TOOL),
      declaration(GENERATE_IMAGE_TOOL),
      declaration(VIEW_STICKER_PACK_TOOL),
    ],
    has: (): boolean => true,
    execute,
    actionsUsed: (): number => actionsUsed,
  }))).resolves.toBe("动作完成");

  expect(execute).toHaveBeenCalledTimes(HARD_MAX_ACTIONS_PER_REPLY);
  expect(actionsUsed).toBe(HARD_MAX_ACTIONS_PER_REPLY);
  // 硬顶只由 toolset.execute 兑现（见 replyToolset/orchestrator.ts）；请求里的声明从第一轮到最后一轮是同一份引用。
  for (const request of requests) expect(request.functions).toBe(requests[0]!.functions);
  expect(requests[HARD_MAX_ACTIONS_PER_REPLY]!.functions.map((definition: AiToolDefinition): string => definition.name))
    .toEqual([
      SEND_MESSAGE_TOOL,
      SEND_STICKER_TOOL,
      ADD_REACTION_TOOL,
      GENERATE_IMAGE_TOOL,
      VIEW_STICKER_PACK_TOOL,
    ]);
});

test("同一响应多调用计入总预算，超预算的调用不执行但声明保持不变", async () => {
  const names: string[] = Array.from({ length: MAX_CUSTOM_TOOL_CALLS_PER_REPLY + 2 }, (_, index: number): string => `tool_${index}`);
  turns.push(okTurn({ calls: names.map((name: string): AiFunctionCall => call(name)) }));
  turns.push(okTurn({ text: "预算收敛" }));
  const execute = mock((): string => JSON.stringify({ error: "failed" }));

  await expect(generateReply(-1001, promptSections("并行调用"), toolset({
    functions: names.map(declaration),
    has: (): boolean => true,
    execute,
  }))).resolves.toBe("预算收敛");
  expect(execute).toHaveBeenCalledTimes(MAX_CUSTOM_TOOL_CALLS_PER_REPLY);
  expect(requests[1]!.functions).toBe(requests[0]!.functions);
  // 超预算的调用拿到「停止调用工具」的工具结果，声明本身不清空。
  const overBudget: AiToolOutput[] = appendedOutputs[0]!.slice(MAX_CUSTOM_TOOL_CALLS_PER_REPLY);
  expect(overBudget).toHaveLength(2);
  for (const output of overBudget) {
    expect(JSON.parse(output.responseJson).unavailable).toContain("stop calling tools");
  }
});

test("供应商超支检索软预算时点名记录，但不关掉检索", async () => {
  // 超支的检索调用只记一条日志，不改变工具声明。
  turns.push(
    okTurn({
      calls: [call(SEND_MESSAGE_TOOL, { text: "搜太多了" })],
      webSearchCalls: MAX_WEB_SEARCH_CALLS_PER_REPLY + 3,
    }),
    okTurn({ text: "收尾" })
  );

  await expect(generateReply(-1001, promptSections("超支"), toolset({
    functions: [declaration(SEND_MESSAGE_TOOL)],
    webSearch: true,
    has: (): boolean => true,
    actionsUsed: (): number => 1,
  }))).resolves.toBe("收尾");

  expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("exceeded the soft web search budget"));
  expect(requests[1]!.webSearchEnabled).toBe(true);
  expect(requests[1]!.functions).toBe(requests[0]!.functions);
});

test("撞上工具轮上限时不再执行剩余调用，点名后收尾", async () => {
  // 每一轮都继续要工具，直到 round === MAX_TOOL_ROUNDS。
  for (let round: number = 0; round <= MAX_TOOL_ROUNDS; round++) {
    turns.push(okTurn({ calls: [call(VIEW_STICKER_PACK_TOOL)], text: "最后一轮正文" }));
  }
  const execute = mock((): string => JSON.stringify({ success: false }));

  await expect(generateReply(-1001, promptSections("死循环"), toolset({
    functions: [declaration(VIEW_STICKER_PACK_TOOL)],
    has: (): boolean => true,
    execute,
  }))).resolves.toBe("最后一轮正文");

  expect(requestMock).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
  // 两层预算叠加：整轮自定义调用总预算先于轮数上限耗尽，之后的
  // 调用只拿到「预算耗尽」的工具结果，不再执行。
  expect(execute).toHaveBeenCalledTimes(MAX_CUSTOM_TOOL_CALLS_PER_REPLY);
  expect(loggerErrorMock).toHaveBeenCalledWith(
    expect.stringContaining(`hit the tool-round limit (${MAX_TOOL_ROUNDS})`)
  );
});

test("最后一轮才遇到工具调用超限时，降级重试没有剩余轮次，本轮以无正文收尾", async () => {
  for (let round: number = 0; round < MAX_TOOL_ROUNDS; round++) {
    turns.push(okTurn({ calls: [call(VIEW_STICKER_PACK_TOOL)] }));
  }
  turns.push(failTurn({ finishReason: "TOO_MANY_TOOL_CALLS", toolCallLimitHit: true }));

  await expect(generateReply(-1001, promptSections("末轮超限"), toolset({
    functions: [declaration(VIEW_STICKER_PACK_TOOL)],
    webSearch: true,
    has: (): boolean => true,
  }))).resolves.toBeNull();

  expect(requestMock).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
  expect(requests[MAX_TOOL_ROUNDS]!.webSearchEnabled).toBe(true);
  expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("retrying once with web search disabled"));
});

test("所有群共用 init 接管的本进程人设，系统前缀逐群逐字相同", async () => {
  adoptPersona("部署方自定义人设");
  turns.push(okTurn({ text: "response" }));
  await generateReply(-1001, promptSections("context"), toolset());
  turns.push(okTurn({ text: "response" }));
  await generateReply(-1002, promptSections("context"), toolset());
  expect(requests[0]!.systemPrompt).toStartWith(`${getPersona()}\n\n## Agent 身份与权限边界`);
  expect(getPersona()).toBe("部署方自定义人设");
  expect(requests[1]!.systemPrompt).toBe(requests[0]!.systemPrompt);
});

test("工具往返复用本轮系统提示词，前缀恒定", async () => {
  turns.push(okTurn({ calls: [call(SEND_MESSAGE_TOOL)] }), okTurn({ text: "本轮完成" }));
  await expect(generateReply(-1001, promptSections("当前轮"), toolset({
    has: (): boolean => true,
    execute: (): string => "{}",
  }))).resolves.toBe("本轮完成");
  expect(requests).toHaveLength(2);
  expect(requests[0]!.systemPrompt).toStartWith(DEFAULT_AI_PERSONA);
  expect(requests[1]!.systemPrompt).toBe(requests[0]!.systemPrompt);
});

test("配置了 web_search：系统提示词换函数工具口径，调用由回复循环等结果后喂回，检索后的轮次按已查证处理", async () => {
  turns.push(
    okTurn({ calls: [call(WEB_SEARCH_TOOL, { query: "东京天气" }), call(SEND_MESSAGE_TOOL, { text: "稍等" })] }),
    okTurn({ text: "收尾" })
  );
  const searchWeb = mock(async (_argumentsJson: string): Promise<WebSearchToolOutcome> =>
    ({ result: JSON.stringify({ result: "晴" }), searchCalls: 1 }));
  const execute = mock((..._args: unknown[]): string => JSON.stringify({ success: true }));

  await expect(generateReply(-1001, promptSections("检索"), toolset({
    functions: [declaration(WEB_SEARCH_TOOL), declaration(SEND_MESSAGE_TOOL)],
    webSearch: false,
    searchWeb,
    has: (name: string): boolean => name === SEND_MESSAGE_TOOL,
    execute,
  }))).resolves.toBe("收尾");

  expect(requests[0]!.systemPrompt).toContain(WEB_SEARCH_FUNCTION_INSTRUCTION);
  expect(requests[0]!.webSearchEnabled).toBe(false);
  expect(searchWeb).toHaveBeenCalledWith(JSON.stringify({ query: "东京天气" }));
  // web_search 不经同步的 execute，也不落到静态查询工具。
  expect(execute).toHaveBeenCalledTimes(1);
  expect(callToolMock).not.toHaveBeenCalled();
  expect(appendedOutputs[0]!.map((output: AiToolOutput) => output.responseJson)).toEqual([
    JSON.stringify({ result: "晴" }),
    JSON.stringify({ success: true }),
  ]);
  expect(requests[0]!.grounded).toBe(false);
  expect(requests[1]!.grounded).toBe(true);
});

test("等检索结果期间本轮作废时不再喂回结果", async () => {
  let active: boolean = true;
  turns.push(okTurn({ calls: [call(WEB_SEARCH_TOOL, { query: "q" })] }));
  await expect(generateReply(-1001, promptSections("作废"), toolset({
    searchWeb: async (): Promise<WebSearchToolOutcome> => {
      active = false;
      return { result: "{}", searchCalls: 1 };
    },
    isActive: (): boolean => active,
  }))).resolves.toBeNull();
  expect(appendedOutputs).toHaveLength(0);
});
