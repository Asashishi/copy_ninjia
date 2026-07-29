import { describe, expect, mock, test } from "bun:test";
import { parseIndexField } from "../../packages/ai/utils/toolArgs";

/**
 * infra/telegram 的 sendSticker 替换为测试可控的假实现——本文件
 * 不关心真实 Telegram API 调用是否成功（那部分已用真实 API 手动验证过），
 * 只关心 stickers.ts 自己的解析/组装/两层选择与每轮限额逻辑。
 */
const realTelegram = await import("../../packages/infra/telegram");
const sendStickerMock = mock(async (_params: {
  chatId: number;
  fileId: string;
  signal?: AbortSignal;
}): Promise<number | undefined> => 12345);
mock.module("../../packages/infra/telegram", () => ({ ...realTelegram, sendSticker: sendStickerMock }));
// view_sticker_pack 会为模拟真人翻贴纸面板停顿 1.5~5 秒，单测里直接跳过；
// 但要保留「已 abort 就以 abort 原因 reject」这一半，那正是作废路径的入口。
mock.module("../../packages/libs/sleep", () => ({
  sleep: async (_ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted === true) throw signal.reason;
  },
}));

const {
  buildSendStickerToolDefinition,
  buildViewStickerPackToolDefinition,
  createStickerRoundState,
  parseStickerIntent,
  sendStickerTool,
  viewStickerPackTool,
} = await import("../../packages/ai/tools/stickers");
const { REPLY_INVALIDATED_TOOL_ERROR, SEND_STICKER_TOOL, VIEW_STICKER_PACK_TOOL } = await import("../../packages/consts/tools");
const { MAX_STICKER_PACK_VIEWS_PER_REPLY, STICKER_INTENT_MAX_CHARS } = await import("../../packages/consts/aiChat/stickers");
const { createStickerSendLock } = await import("../../packages/ai/stickers/sendLock");

function candidate(fileId: string, emoji: string, description: string): any {
  return { sticker: { file_id: fileId, file_unique_id: `${fileId}-uid`, emoji }, emoji, description };
}

function pack({ name, title, summary, stickers }: {
  name: string;
  title: string;
  summary: string;
  stickers: any[];
}): any {
  return { pack: name, title, summary, stickers };
}

const MENU: any[] = [
  pack({ name: "pack_a", title: "猫猫包", summary: "一包搞笑猫猫", stickers: [candidate("a1", "😂", "一只猫大笑"), candidate("a2", "😭", "一只猫哭泣")] }),
  pack({ name: "pack_b", title: "狗狗包", summary: "一包卖萌狗狗", stickers: [candidate("b1", "🥰", "一只狗撒娇")] }),
];

/** 已看过 MENU 里所有包的限额状态，省得每个发送用例都先走一遍 view。 */
function viewedState(): any {
  const state = createStickerRoundState();
  state.viewedPackIntents.set(1, "用哭泣贴纸表达委屈，但不要显得真生气");
  state.viewedPackIntents.set(2, "用撒娇回应对方，但不要过分亲密");
  return state;
}

/** 聊天状态心跳挡位句柄的假实现（见 types/aiChatWorker.ts 的
 *  ChatActionControl），只记录 set 调用供断言，settle 立即落定。current 默认
 *  报告 choose_sticker（模拟 view 过包、选择状态未被打断的正常链路），传
 *  "idle" 可模拟挡位已被中途的消息打断。 */
function chatActionMock(phase: string = "choose_sticker"): any {
  return { current: (): string => phase, set: mock((_phase: string): void => {}), settle: mock(async (): Promise<void> => {}) };
}

/** 每个用例独享的发贴纸锁句柄：真实实现 + 独立 Map（不碰 Worker 全局的
 *  stickerSendLocks），单轮场景下恒能抢到，等价于加锁前的行为。 */
function freshLock(chatId: number = 123): any {
  return createStickerSendLock(chatId, new Map());
}

function sendStickerForTest({
  argumentsJson,
  chatAction = chatActionMock(),
  stickerLock = freshLock(),
  chatId = 123,
  menu = MENU,
  state = viewedState(),
  onSent = (): void => {},
}: {
  argumentsJson: string;
  chatAction?: any;
  stickerLock?: any;
  chatId?: number;
  menu?: any[];
  state?: any;
  onSent?: (stickerDescription: string, messageId: number) => void;
}): Promise<string> {
  return sendStickerTool({ chatAction, stickerLock, chatId, menu, argumentsJson, state, onSent });
}

describe("ai/stickers parseIndexField", () => {
  test("合法 JSON 参数原样解析", () => {
    expect(parseIndexField('{"pack_index": 2}', "pack_index", 5)).toBe(2);
    expect(parseIndexField('{"sticker_index": 1}', "sticker_index", 1)).toBe(1);
  });

  test("JSON 解析失败返回 null", () => {
    expect(parseIndexField("not json", "pack_index", 5)).toBeNull();
    expect(parseIndexField("", "pack_index", 5)).toBeNull();
  });

  test("字段缺失/类型不对/不是整数，返回 null", () => {
    expect(parseIndexField("{}", "pack_index", 5)).toBeNull();
    expect(parseIndexField('{"pack_index": "3"}', "pack_index", 5)).toBeNull();
    expect(parseIndexField('{"pack_index": 2.5}', "pack_index", 5)).toBeNull();
    expect(parseIndexField('{"pack_index": null}', "pack_index", 5)).toBeNull();
  });

  test("越界编号（0、负数、超出上限）返回 null", () => {
    expect(parseIndexField('{"pack_index": 0}', "pack_index", 5)).toBeNull();
    expect(parseIndexField('{"pack_index": -1}', "pack_index", 5)).toBeNull();
    expect(parseIndexField('{"pack_index": 6}', "pack_index", 5)).toBeNull();
  });
});

describe("ai/stickers parseStickerIntent", () => {
  test("规范空白后返回非空意图", () => {
    expect(parseStickerIntent('{"intent":"  表达无语，  但不要显得生气\\n"}')).toBe("表达无语， 但不要显得生气");
  });

  test("缺失、类型错误、空文本或超长时返回 null", () => {
    expect(parseStickerIntent("{}")).toBeNull();
    expect(parseStickerIntent('{"intent":123}')).toBeNull();
    expect(parseStickerIntent('{"intent":"   "}')).toBeNull();
    expect(parseStickerIntent(JSON.stringify({ intent: "意".repeat(STICKER_INTENT_MAX_CHARS + 1) }))).toBeNull();
  });
});

describe("ai/stickers 工具定义组装", () => {
  test("菜单为空时两层工具都不提供（返回 null）", () => {
    expect(buildViewStickerPackToolDefinition([])).toBeNull();
    expect(buildSendStickerToolDefinition([])).toBeNull();
  });

  test("view_sticker_pack 的描述带整包简介的编号清单", () => {
    const def = buildViewStickerPackToolDefinition(MENU);
    expect(def?.name).toBe(VIEW_STICKER_PACK_TOOL);
    expect(def?.description).toContain("1. 「猫猫包」（2 枚）：一包搞笑猫猫");
    expect(def?.description).toContain("2. 「狗狗包」（1 枚）：一包卖萌狗狗");
    expect(def?.description).toContain(`最多查看 ${MAX_STICKER_PACK_VIEWS_PER_REPLY} 个不同贴纸包，每个包只能查看一次`);
    expect(def?.parameters.required).toEqual(["pack_index", "intent"]);
    expect((def?.parameters.properties.intent as { maxLength?: number }).maxLength).toBe(STICKER_INTENT_MAX_CHARS);
  });

  test("send_sticker 需要包编号 + 贴纸编号两个参数", () => {
    const def = buildSendStickerToolDefinition(MENU);
    expect(def?.name).toBe(SEND_STICKER_TOOL);
    expect(def?.parameters.required).toEqual(["pack_index", "sticker_index"]);
  });
});

describe("ai/stickers viewStickerPackTool", () => {
  test("合法调用返回意图和包内清单，按包记录意图，并把心跳切到「正在选择贴纸」挡", async () => {
    const chatAction = chatActionMock();
    const state = createStickerRoundState();
    const result = JSON.parse(await viewStickerPackTool({ chatAction, menu: MENU, argumentsJson: '{"pack_index": 1, "intent":"表达被逗笑，但不要显得在嘲讽对方"}', state }));
    expect(result.pack).toBe("猫猫包");
    expect(result.intent).toBe("表达被逗笑，但不要显得在嘲讽对方");
    expect(result.selection_instruction).toContain("严格按 intent");
    expect(result.stickers).toContain("1. 😂 一只猫大笑");
    expect(result.stickers).toContain("2. 😭 一只猫哭泣");
    expect(state.viewedPackIntents.get(1)).toBe("表达被逗笑，但不要显得在嘲讽对方");
    expect(chatAction.set).toHaveBeenCalledWith("choose_sticker");
  });

  test("停顿期间轮次被作废：返回工具错误，不让 reject 逃出 execute", async () => {
    // orchestrator 的 dispatch/execute 与 callGemini 的 await toolset.execute(...)
    // 都没有 try/catch：逃出去展开的是整个 functionCalls 循环——同一轮里模型发出
    // 的其余调用一个都不执行，contents 里还留下一个带未应答 functionCall 的
    // model 轮。同轮的 send_message / send_sticker 走的是同一个共用停顿。
    const chatAction = chatActionMock();
    const state = createStickerRoundState();
    const controller = new AbortController();
    controller.abort(new Error("chat teardown"));

    const result = await viewStickerPackTool({
      chatAction,
      menu: MENU,
      argumentsJson: '{"pack_index": 1, "intent":"表达被逗笑，但不要显得在嘲讽对方"}',
      state,
      signal: controller.signal,
    });

    expect(JSON.parse(result).error).toBe(REPLY_INVALIDATED_TOOL_ERROR);
    // 作废的这一轮不该把包记成「已看过」，否则重开一轮时它就被锁死了。
    expect(state.viewedPackIntents.size).toBe(0);
  });

  test("没有 emoji 的贴纸用占位文案，不留空", async () => {
    const state = createStickerRoundState();
    const menu = [pack({ name: "p", title: "包", summary: "简介", stickers: [candidate("x1", "", "一个没有 emoji 的贴纸")] })];
    const result = JSON.parse(await viewStickerPackTool({ chatAction: chatActionMock(), menu, argumentsJson: '{"pack_index": 1, "intent":"表达疑惑，但不要带攻击性"}', state }));
    expect(result.stickers).toContain("1. （无 emoji） 一个没有 emoji 的贴纸");
  });

  test("编号非法返回错误，不标记任何包、不切换聊天状态挡位", async () => {
    const chatAction = chatActionMock();
    const state = createStickerRoundState();
    expect(await viewStickerPackTool({ chatAction, menu: MENU, argumentsJson: '{"pack_index": 99, "intent":"表达疑惑，但不要带攻击性"}', state })).toBe(JSON.stringify({ error: "Invalid pack_index" }));
    expect(state.viewedPackIntents.size).toBe(0);
    expect(chatAction.set).not.toHaveBeenCalled();
  });

  test("意图缺失或无效时拒绝查看，不标记包、不切换聊天状态挡位", async () => {
    const chatAction = chatActionMock();
    const state = createStickerRoundState();
    expect(JSON.parse(await viewStickerPackTool({ chatAction, menu: MENU, argumentsJson: '{"pack_index": 1}', state })).error).toContain("Invalid intent");
    expect(state.viewedPackIntents.size).toBe(0);
    expect(chatAction.set).not.toHaveBeenCalled();
  });

  test("同一个包每轮只能查看一次，重复查看保留首次意图且不再切换状态", async () => {
    const chatAction = chatActionMock();
    const state = createStickerRoundState();
    await viewStickerPackTool({ chatAction, menu: MENU, argumentsJson: '{"pack_index": 1, "intent":"表达惊讶，但不要显得害怕"}', state });
    chatAction.set.mockClear();

    const repeated = JSON.parse(await viewStickerPackTool({ chatAction, menu: MENU, argumentsJson: '{"pack_index": 1, "intent":"改为表达好笑，但不要嘲讽对方"}', state }));
    expect(repeated.error).toContain("already viewed");
    expect(state.viewedPackIntents.get(1)).toBe("表达惊讶，但不要显得害怕");
    expect(chatAction.set).not.toHaveBeenCalled();
  });

  test("每轮最多查看五个不同贴纸包，第六个包被拒绝且不切换状态", async () => {
    const menu = Array.from(
      { length: MAX_STICKER_PACK_VIEWS_PER_REPLY + 1 },
      (_, index) => pack({ name: `pack_${index}`, title: `包 ${index}`, summary: `简介 ${index}`, stickers: [candidate(`s${index}`, "🙂", `贴纸 ${index}`)] })
    );
    const state = createStickerRoundState();
    for (let packIndex = 1; packIndex <= MAX_STICKER_PACK_VIEWS_PER_REPLY; packIndex++) {
      await viewStickerPackTool({ chatAction: chatActionMock(), menu, argumentsJson: JSON.stringify({ pack_index: packIndex, intent: `查看第 ${packIndex} 个包` }), state });
    }

    const chatAction = chatActionMock();
    const rejected = JSON.parse(await viewStickerPackTool({
      chatAction,
      menu,
      argumentsJson: JSON.stringify({ pack_index: MAX_STICKER_PACK_VIEWS_PER_REPLY + 1, intent: "尝试查看第六个包" }),
      state,
    }));
    expect(rejected.error).toContain(`at most ${MAX_STICKER_PACK_VIEWS_PER_REPLY} different packs`);
    expect(state.viewedPackIntents.size).toBe(MAX_STICKER_PACK_VIEWS_PER_REPLY);
    expect(chatAction.set).not.toHaveBeenCalled();
  });
});

describe("ai/stickers sendStickerTool", () => {
  test("编号非法时不调用 sendSticker，返回错误结果，不切换挡位", async () => {
    sendStickerMock.mockClear();
    const chatAction = chatActionMock();
    const result = await sendStickerForTest({
      argumentsJson: '{"pack_index": 1, "sticker_index": 99}',
      chatAction,
    });
    expect(result).toBe(JSON.stringify({ error: "Invalid sticker_index" }));
    expect(sendStickerMock).not.toHaveBeenCalled();
    expect(chatAction.set).not.toHaveBeenCalled();
  });

  test("没先 view 过对应的包时拒绝发送", async () => {
    sendStickerMock.mockClear();
    const state = createStickerRoundState();
    state.viewedPackIntents.set(2, "表达撒娇，但不要过分亲密"); // 只看过 2 号包
    const result = JSON.parse(await sendStickerForTest({
      argumentsJson: '{"pack_index": 1, "sticker_index": 1}',
      state,
    }));
    expect(result.error).toContain("not viewed");
    expect(sendStickerMock).not.toHaveBeenCalled();
  });

  test("编号合法且看过包时先切 idle 并 settle 再发送、回调 onSent、返回成功结果", async () => {
    sendStickerMock.mockClear();
    sendStickerMock.mockImplementationOnce(async () => 999);
    const chatAction = chatActionMock();
    let recorded: [string, number] | null = null;

    const result = await sendStickerForTest({
      argumentsJson: '{"pack_index": 1, "sticker_index": 2}',
      chatAction,
      onSent: (desc: string, messageId: number) => {
        recorded = [desc, messageId];
      },
    });

    expect(sendStickerMock).toHaveBeenCalledWith({
      chatId: 123,
      fileId: "a2",
      signal: undefined,
    });
    expect(result).toBe(JSON.stringify({ success: true }));
    // 选择状态自 view 起一直维持着（current 报告 choose_sticker），发送前
    // 不需要重新拉起，只切 idle 等在途请求落定。
    expect(chatAction.set).not.toHaveBeenCalledWith("choose_sticker");
    expect(chatAction.set).toHaveBeenCalledWith("idle");
    expect(chatAction.settle).toHaveBeenCalled();
    expect(recorded).not.toBeNull();
    expect(recorded![1]).toBe(999);
    expect(recorded![0]).toContain("一只猫哭泣");
  });

  test("选择状态被中途的消息打断（current 非 choose_sticker）时，发送前重新拉起再切 idle", async () => {
    sendStickerMock.mockClear();
    sendStickerMock.mockImplementationOnce(async () => 999);
    const chatAction = chatActionMock("idle");

    const result = await sendStickerForTest({
      argumentsJson: '{"pack_index": 1, "sticker_index": 2}',
      chatAction,
    });

    expect(result).toBe(JSON.stringify({ success: true }));
    expect(chatAction.set.mock.calls.map((call: unknown[]) => call[0])).toEqual(["choose_sticker", "idle"]);
    expect(chatAction.settle).toHaveBeenCalled();
    expect(sendStickerMock).toHaveBeenCalledWith({
      chatId: 123,
      fileId: "a2",
      signal: undefined,
    });
  });

  test("同一轮最多发 1 枚，第二枚被限额拒绝（跨包同样计数）", async () => {
    sendStickerMock.mockClear();
    const state = viewedState();
    const lock = freshLock();
    expect(JSON.parse(await sendStickerForTest({
      argumentsJson: '{"pack_index": 1, "sticker_index": 1}',
      stickerLock: lock,
      state,
    })).success).toBe(true);

    const result = JSON.parse(await sendStickerForTest({
      argumentsJson: '{"pack_index": 2, "sticker_index": 1}',
      stickerLock: lock,
      state,
    }));
    expect(result.error).toContain("Sticker limit reached");
    expect(sendStickerMock).toHaveBeenCalledTimes(1);
  });

  test("Telegram 发送失败（sendSticker 返回 undefined）时不回调 onSent、不计入限额、挡位停在 idle 不续回", async () => {
    sendStickerMock.mockClear();
    sendStickerMock.mockImplementationOnce(async () => undefined);
    const chatAction = chatActionMock();
    let called = false;
    const state = viewedState();

    const result = await sendStickerForTest({
      argumentsJson: '{"pack_index": 1, "sticker_index": 1}',
      chatAction,
      state,
      onSent: () => {
        called = true;
      },
    });

    expect(result).toBe(JSON.stringify({ error: "Failed to send sticker" }));
    expect(called).toBe(false);
    expect(state.sentStickerUids.size).toBe(0);
    // 失败不把挡位续回选择贴纸：模型重试时发送路径会自己重新拉起，就此
    // 放弃时也不留下等不来贴纸的状态。
    expect(chatAction.set).toHaveBeenLastCalledWith("idle");
  });
});

describe("ai/stickers 同群并发轮的发贴纸锁", () => {
  test("并发轮已持锁时拒绝发送：不调 sendSticker，收回本轮的选择挡位", async () => {
    sendStickerMock.mockClear();
    const locks = new Map<number, object>();
    expect(createStickerSendLock(123, locks).tryAcquire()).toBe(true); // 并发轮先抢到
    const chatAction = chatActionMock();

    const result = JSON.parse(await sendStickerForTest({
      argumentsJson: '{"pack_index": 1, "sticker_index": 1}',
      chatAction,
      stickerLock: createStickerSendLock(123, locks),
    }));

    expect(result.error).toContain("Sticker throttled");
    expect(sendStickerMock).not.toHaveBeenCalled();
    // 锁被抢是本轮终局的拒绝，「正在选择贴纸…」等不来贴纸，立即收回。
    expect(chatAction.set).toHaveBeenCalledWith("idle");
  });

  test("持锁轮释放后，后续轮能重新抢到并正常发送", async () => {
    sendStickerMock.mockClear();
    const locks = new Map<number, object>();
    const holder = createStickerSendLock(123, locks);
    expect(holder.tryAcquire()).toBe(true);
    holder.release();

    const result = JSON.parse(await sendStickerForTest({
      argumentsJson: '{"pack_index": 1, "sticker_index": 1}',
      stickerLock: createStickerSendLock(123, locks),
    }));
    expect(result.success).toBe(true);
    expect(sendStickerMock).toHaveBeenCalledTimes(1);
  });

  test("发送失败后同一轮换一枚重试：锁已持有直接通过，不被自己挡住", async () => {
    sendStickerMock.mockClear();
    sendStickerMock.mockImplementationOnce(async () => undefined);
    const lock = freshLock();
    const state = viewedState();

    expect(JSON.parse(await sendStickerForTest({
      argumentsJson: '{"pack_index": 1, "sticker_index": 1}',
      stickerLock: lock,
      state,
    })).error).toBe("Failed to send sticker");
    expect(JSON.parse(await sendStickerForTest({
      argumentsJson: '{"pack_index": 1, "sticker_index": 2}',
      stickerLock: lock,
      state,
    })).success).toBe(true);
    expect(sendStickerMock).toHaveBeenCalledTimes(2);
  });

  test("锁按群隔离：别的群持锁不影响本群发送", async () => {
    sendStickerMock.mockClear();
    const locks = new Map<number, object>();
    expect(createStickerSendLock(456, locks).tryAcquire()).toBe(true);

    const result = JSON.parse(await sendStickerForTest({
      argumentsJson: '{"pack_index": 1, "sticker_index": 1}',
      stickerLock: createStickerSendLock(123, locks),
    }));
    expect(result.success).toBe(true);
  });
});
