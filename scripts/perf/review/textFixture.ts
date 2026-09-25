/**
 * 文本清洗专项的固定夹具：场景矩阵、逐条输入与迭代次数。
 *
 * 正文语言比例固定为每十条六条中文、三条英文、一条 emoji 混排；长短混合场景的
 * 短正文为 16 码元规范单行。输入经 JSON 往返展平，避免 repeat/slice 的绳索字符串
 * 在首次访问时展开并混入计时。
 */
import type { AiRecordContext, AiReplyReference } from "../../../packages/types/aiChat/protocol";

/** `sanitize` 直接测清洗函数；`message` 测完整缓存条目构造。 */
export type TextReviewKind = "sanitize" | "message";
/** 正文语言；`mixed` 按 6:3:1 轮换中文、英文与 emoji 混排。 */
export type TextReviewAlphabet = "latin" | "cjk" | "mixed";
/**
 * 长正文的空白排版：`canonical` 为规范单行；`head`/`middle`/`tail` 在对应位置放一个
 * 换行；`dense` 每 40 码元一个换行、每 17 码元一个制表符；`varied` 按每十条轮换前五种。
 */
export type TextReviewLayout = "canonical" | "head" | "middle" | "tail" | "dense" | "varied";

/** 一个专项场景。 */
export interface TextReviewScenario {
  readonly name: string;
  readonly kind: TextReviewKind;
  readonly alphabet: TextReviewAlphabet;
  /** 长正文的 UTF-16 码元数。 */
  readonly length: number;
  readonly layout: TextReviewLayout;
  /** 长正文占全部输入的百分比；null 表示全部为长正文。 */
  readonly longPercent: number | null;
  /** 是否附带与正文同长同排版的回复原文及 128 码元以内的 quote。 */
  readonly reply: boolean;
}

/** 一条构造输入。 */
export interface TextReviewInput {
  readonly text: string;
  readonly source: AiRecordContext;
}

function scenario(
  name: string,
  fields: Omit<TextReviewScenario, "name">
): TextReviewScenario {
  return { name, ...fields };
}

function buildScenarios(): readonly TextReviewScenario[] {
  const result: TextReviewScenario[] = [];
  for (const [alphabet, length, layout] of [
    ["latin", 8, "canonical"], ["latin", 16, "canonical"],
    ["cjk", 1_024, "canonical"], ["latin", 1_024, "dense"],
  ] as const) {
    result.push(scenario(`sanitize-${alphabet}-${length}-${layout}`, {
      kind: "sanitize", alphabet, length, layout, longPercent: null, reply: false,
    }));
  }
  for (const length of [16, 32, 64, 128, 256, 512, 1_024, 4_096]) {
    result.push(scenario(`message-${length}`, {
      kind: "message", alphabet: "mixed", length, layout: "canonical", longPercent: null, reply: false,
    }));
  }
  for (const length of [1_024, 4_096]) {
    result.push(scenario(`reply-${length}`, {
      kind: "message", alphabet: "mixed", length, layout: "canonical", longPercent: null, reply: true,
    }));
  }
  for (const length of [1_024, 4_096]) {
    for (const longPercent of [1, 2, 5, 25, 50, 75]) {
      result.push(scenario(`mix-${length}-${longPercent}`, {
        kind: "message", alphabet: "mixed", length, layout: "canonical", longPercent, reply: false,
      }));
    }
  }
  for (const layout of ["head", "middle", "tail", "dense"] as const) {
    result.push(scenario(`message-1024-${layout}`, {
      kind: "message", alphabet: "mixed", length: 1_024, layout, longPercent: null, reply: false,
    }));
  }
  for (const length of [1_024, 4_096]) {
    for (const longPercent of [25, 50, 75]) {
      result.push(scenario(`varied-${length}-${longPercent}`, {
        kind: "message", alphabet: "mixed", length, layout: "varied", longPercent, reply: false,
      }));
    }
  }
  return result;
}

/** 全部专项场景；名称唯一，顺序即运行顺序。 */
export const TEXT_REVIEW_SCENARIOS: readonly TextReviewScenario[] = buildScenarios();

/** 按名称取场景；未知名称抛错。 */
export function findTextReviewScenario(name: string | undefined): TextReviewScenario {
  const found: TextReviewScenario | undefined = TEXT_REVIEW_SCENARIOS.find(
    (candidate: TextReviewScenario): boolean => candidate.name === name
  );
  if (found === undefined) throw new Error(`Unknown text review scenario: ${name ?? "(missing)"}`);
  return found;
}

const VARIED_LAYOUTS: readonly TextReviewLayout[] = ["canonical", "head", "middle", "tail", "dense"];
const CJK_PATTERNS: readonly string[] = [
  "今天讨论消息处理性能与功能验证，先看看实际结果。",
  "这段内容包含中文消息以及常见标点，需要保持原意。",
  "测试群聊上下文和文本清洗，确保各个字段处理一致。",
];
const LATIN_PATTERNS: readonly string[] = [
  "We are checking message processing and runtime costs. ",
  "The group discussion includes examples and useful context. ",
  "Check https://example.com/topic?id=123 for sample details. ",
];
const EMOJI_PATTERNS: readonly string[] = [
  "讨论进展🙂 与结果✨ hello world ",
  "今天测试🚀 and messages🙂 中文内容 ",
  "群聊消息👨‍👩‍👧‍👦 mixed text 确认结果 ",
];

function patternsFor(alphabet: TextReviewAlphabet, index: number): readonly string[] {
  if (alphabet === "cjk") return CJK_PATTERNS;
  if (alphabet === "latin") return LATIN_PATTERNS;
  const slot: number = index % 10;
  return slot < 6 ? CJK_PATTERNS : slot < 9 ? LATIN_PATTERNS : EMOJI_PATTERNS;
}

interface TextOfOptions {
  readonly length: number;
  readonly alphabet: TextReviewAlphabet;
  readonly layout: TextReviewLayout;
  readonly index: number;
}

function textOf({ length, alphabet, layout, index }: TextOfOptions): string {
  const resolved: TextReviewLayout = layout === "varied"
    ? VARIED_LAYOUTS[Math.floor(index / 10) % VARIED_LAYOUTS.length]!
    : layout;
  const patterns: readonly string[] = patternsFor(alphabet, index);
  const pattern: string = `${patterns[index % patterns.length]!}${index.toString(36)} `;
  let text: string = pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
  if (text.endsWith(" ")) text = `${text.slice(0, -1)}x`;
  if (resolved === "dense") {
    const parts: string[] = [];
    for (let offset: number = 0; offset < text.length; offset++) {
      parts.push(offset % 40 === 0 ? "\n" : offset % 17 === 0 ? "\t" : text[offset]!);
    }
    text = parts.join("");
  } else if (resolved !== "canonical") {
    const at: number = resolved === "head" ? 1 : resolved === "middle" ? Math.floor(length / 2) : length - 2;
    text = `${text.slice(0, at)}\n${text.slice(at + 1)}`;
  }
  return JSON.parse(JSON.stringify(text)) as string;
}

/** 场景的全部输入：全长正文场景 100 条，长短混合场景 1,000 条。 */
export function textReviewInputs(scenario: TextReviewScenario): readonly TextReviewInput[] {
  const result: TextReviewInput[] = [];
  const count: number = scenario.longPercent === null ? 100 : 1_000;
  for (let index: number = 0; index < count; index++) {
    // 以十条为一组决定长短，各比例下长短两个子集保持同一语言比例。
    const group: number = Math.floor(index / 10);
    const isLong: boolean = scenario.longPercent === null || (group * 37) % 100 < scenario.longPercent;
    const length: number = isLong ? scenario.length : 16;
    const replyTo: AiReplyReference | undefined = scenario.reply
      ? {
        id: 20_000 + index,
        firstName: "引用用户",
        lastName: "",
        username: index % 2 === 0 ? "reply_user" : undefined,
        messageId: 30_000 + index,
        text: textOf({ length, alphabet: scenario.alphabet, layout: scenario.layout, index: index + 101 }),
        quote: textOf({ length: Math.min(length, 128), alphabet: scenario.alphabet, layout: "canonical", index: index + 201 }),
        forwardedFrom: undefined,
        botImage: undefined,
      }
      : undefined;
    const source: AiRecordContext = {
      chatId: -1001,
      senderId: 10_000 + index,
      firstName: index % 2 === 0 ? "群聊成员" : "Alice",
      lastName: index % 3 === 0 ? "Chen" : "",
      username: index % 2 === 0 ? "alice_007" : undefined,
      messageId: 40_000 + index,
      replyTo,
      forwardedFrom: index % 10 === 0 ? "转发来源" : undefined,
      persistImmediately: false,
    };
    const layout: TextReviewLayout = isLong ? scenario.layout : "canonical";
    result.push({ text: textOf({ length, alphabet: scenario.alphabet, layout, index }), source });
  }
  return result;
}

/**
 * 单个计时样本的迭代次数：按平均正文长度把单样本耗时压在同一量级；长短混合场景
 * 取输入条数的整数倍，保证每个样本覆盖完整的输入序列。
 */
export function textReviewIterations(
  scenario: TextReviewScenario,
  inputs: readonly TextReviewInput[]
): number {
  let totalLength: number = 0;
  for (const input of inputs) totalLength += input.text.length;
  const averageLength: number = totalLength / inputs.length;
  const perItemCost: number = (scenario.kind === "message" ? 400 : 12) + averageLength * (scenario.reply ? 4 : 2.5);
  const estimated: number = Math.max(4_000, Math.min(800_000, Math.floor(40_000_000 / perItemCost)));
  if (scenario.longPercent === null) return estimated;
  return Math.max(inputs.length * 4, Math.floor(estimated / inputs.length) * inputs.length);
}
