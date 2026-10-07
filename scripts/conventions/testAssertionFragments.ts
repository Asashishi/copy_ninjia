import { relative } from "node:path";
import ts from "typescript";
import { fixtureLiterals, isMatcherCall, isStringLiteralNode } from "./testAssertions";
import type { TestAssertionRuleParams } from "./testAssertions";

/**
 * 测试断言的文案口径（AGENTS.md「测试」）的子串规则：匹配器实参里的字符串字面量或模板静态片段，
 * 含至少 CONSTANT_TEXT_FRAGMENT_MIN_CJK 个汉字或假名、又是 packages/consts 某段文案的子串时，
 * 视为把常量文案的一部分抄进了测试；期望值从常量（或模板常量渲染出的固定片段，见
 * test/helpers/templateText.ts）取得。
 *
 * 同一字面量在本文件匹配器实参之外出现过（测试自造的夹具输入）时不算。断言对象就是提示词常量
 * 必须写明哪些话的「提示词契约」用例，按文件与用例名列在 CONSTANT_TEXT_CONTRACT_EXEMPTIONS；
 * 豁免表里没被任何命中用到的条目同样报错。
 */

/** 参与比对的最少汉字与假名个数；更短的片段不参与比对。 */
const CONSTANT_TEXT_FRAGMENT_MIN_CJK: number = 6;

/** 计数用的字符范围：平假名、片假名与 CJK 统一汉字（含扩展 A）。 */
const CJK_CHARACTER_PATTERN: RegExp = /[\u3040-\u30ff\u3400-\u9fff]/g;

/** 语料里分隔各片段的字符；子串查找不会跨越它。 */
const FRAGMENT_SEPARATOR: string = "\u0000";

/** 一条提示词契约豁免：该文件里这些用例名下的命中不计。 */
interface ConstantTextContractExemption {
  readonly path: string;
  readonly tests: readonly string[];
  /** 为什么这些断言必须写出常量措辞。 */
  readonly reason: string;
}

/**
 * 提示词契约测试：验证「提示词常量必须写明这些要求」，措辞本身就是被测行为。
 * 新增条目须写明用例名，不得整文件豁免普通回执断言。
 */
export const CONSTANT_TEXT_CONTRACT_EXEMPTIONS: readonly Readonly<ConstantTextContractExemption>[] = [
  {
    path: "test/aiChat/ai/replyToolsetWiring.test.ts",
    tests: [
      "语音说过的意思不得再用文字重发：每种台词语言的三处提示都按语义而非字面约束",
      "每种台词语言的 send_voice 说明与参数说明都写明各自的语言，其余语言的名字不作台词语言出现",
      "回复提示把独立文字限死在 send_message，媒体配文走对应 caption，最终响应不得夹带正文",
      "行动总则规定按本轮工具状态行事、失败后不单独作反应",
    ],
    reason: "每种台词语言的回复与语音工具说明必须写明的行为约束",
  },
  {
    path: "test/aiChat/ai/chatTranscript.test.ts",
    tests: [
      "摘要提示按标注层级区分当前转发与被回复原消息的转发",
      "总提示只保留两层记忆仲裁：逐字转录定当前状态，冷记忆只作长期背景",
      "分层记忆只对内可见：禁止对群友复述分块名、机制细节，也不许被套话确认",
    ],
    reason: "摘要、记忆仲裁与记忆机制保密提示必须写明的规则",
  },
  {
    path: "test/workers/antiRaid/adDetectClassifier.test.ts",
    tests: [
      "按本领域的模型与采样参数发一次判定，部署示例进系统提示词",
      "入群验证窗口这条系统事实独立于正文交给传输，两侧都显式声明",
      "E 条声明系统事实在待判定数据之外，正文里的同名字样不算系统事实",
    ],
    reason: "广告判定提示词的反例、姓名规则与系统事实声明",
  },
  {
    path: "test/consts/aiChat/searchPrompts.test.ts",
    tests: [
      "区分需查事实与只依赖转录的内容，并约束证据不足时不补造",
      "text 内建搜索按固定软预算说明；独立函数从本轮工具状态读取配置上限",
    ],
    reason: "联网检索决策与预算提示必须写明的规则",
  },
  {
    path: "test/workers/aiChat/replyModel.test.ts",
    tests: ["agent 身份权限边界与上下文协议由代码注入，不混入内置人设"],
    reason: "agent 身份权限边界与互动规则提示必须写明的约束",
  },
  {
    path: "test/aiChat/ai/webDigest.test.ts",
    tests: ["配了 web_search 时用它检索；组稿拿到去重后的来源列表，交回可被 Telegram 解析的 MarkdownV2"],
    reason: "检索段与组稿段提示词必须写明的取材、日期与链接规则",
  },
  {
    path: "test/aiChat/ai/voiceMessageTool.test.ts",
    tests: ["工具声明按台词语言取注册文案、同一语言逐字恒定，说明按情绪与余量使用、允许不发"],
    reason: "send_voice 工具说明必须写明的使用时机",
  },
  {
    path: "test/aiChat/ai/imageGenerationTool.test.ts",
    tests: [
      "本轮工具状态的生图行：可用时带参考素材说明，冷却中给剩余秒数，superAdmin 不受冷却",
      "工具说明告诉模型图注与图同属一条消息、超长会被拆开",
    ],
    reason: "生图工具说明与本轮工具状态行必须写明的素材与图注规则",
  },
  {
    path: "test/app/commandMenu.test.ts",
    tests: ["/permission 的菜单描述写明 help 与 query 人人可用、修改仅限超级管理员"],
    reason: "命令菜单的 /permission 描述必须说清谁能用哪些子命令",
  },
];

/** packages/consts 一个文件里全部字符串字面量与模板静态片段，追加进调用方的片段表。 */
export function collectConstantTextFragments(source: ts.SourceFile, fragments: string[]): void {
  const visit = (node: ts.Node): void => {
    if (isStringLiteralNode(node)) fragments.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      fragments.push(node.head.text);
      for (const span of node.templateSpans) fragments.push(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/** 把片段表连成一段语料，供子串查找。 */
export function constantTextCorpus(fragments: readonly string[]): string {
  return fragments.join(FRAGMENT_SEPARATOR);
}

/** 子串规则的入参：逐文件入参外加常量文案语料与豁免命中记录。 */
export interface ConstantTextFragmentRuleParams extends TestAssertionRuleParams {
  readonly corpus: string;
  /** 本次检查用到的豁免键（`路径::用例名`），供 collectUnusedConstantTextExemptionProblems 核对。 */
  readonly usedExemptions: Set<string>;
}

function cjkCount(text: string): number {
  return text.match(CJK_CHARACTER_PATTERN)?.length ?? 0;
}

/** 节点所在的最内层 `test(...)`/`it(...)`（含 `test.each(...)(...)`）用例名；不在用例里为 undefined。 */
function enclosingTestTitle(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (!ts.isCallExpression(current)) continue;
    const title: ts.Expression | undefined = current.arguments[0];
    if (title === undefined || !isStringLiteralNode(title)) continue;
    let callee: ts.Expression = current.expression;
    if (ts.isCallExpression(callee)) callee = callee.expression;
    while (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
    if (ts.isIdentifier(callee) && (callee.text === "test" || callee.text === "it")) return title.text;
  }
  return undefined;
}

/** 字面量节点里参与比对的静态片段。 */
function literalChunks(node: ts.Node): readonly string[] {
  if (isStringLiteralNode(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span: ts.TemplateSpan): string => span.literal.text)];
  }
  return [];
}

/** 找出匹配器实参里抄写了常量文案片段、又不是本文件夹具也不在豁免用例里的字面量。 */
export function collectConstantTextFragmentAssertionProblems({
  projectRoot,
  path,
  source,
  corpus,
  usedExemptions,
}: ConstantTextFragmentRuleParams): readonly string[] {
  const relativePath: string = relative(projectRoot, path);
  const exemptTests: ReadonlySet<string> = new Set(
    CONSTANT_TEXT_CONTRACT_EXEMPTIONS
      .filter((exemption: Readonly<ConstantTextContractExemption>): boolean => exemption.path === relativePath)
      .flatMap((exemption: Readonly<ConstantTextContractExemption>): readonly string[] => exemption.tests)
  );
  const fixtures: ReadonlySet<string> = fixtureLiterals(source);
  const problems: string[] = [];
  const inspectArgument = (node: ts.Node): void => {
    for (const chunk of literalChunks(node)) {
      if (cjkCount(chunk) < CONSTANT_TEXT_FRAGMENT_MIN_CJK || fixtures.has(chunk) || !corpus.includes(chunk)) continue;
      const title: string | undefined = enclosingTestTitle(node);
      if (title !== undefined && exemptTests.has(title)) {
        usedExemptions.add(`${relativePath}::${title}`);
        continue;
      }
      const line: number = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      problems.push(
        `${relativePath}:${line} asserts text copied from packages/consts (${JSON.stringify(chunk.slice(0, 24))}); ` +
        "read the constant or its template parts instead"
      );
    }
    ts.forEachChild(node, inspectArgument);
  };
  const visit = (node: ts.Node): void => {
    if (isMatcherCall(node)) {
      for (const argument of node.arguments) inspectArgument(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

/** 豁免表里没有被任何命中用到的用例：测试已改名、删除或已改成读常量，豁免须同步删掉。 */
export function collectUnusedConstantTextExemptionProblems(usedExemptions: ReadonlySet<string>): readonly string[] {
  const problems: string[] = [];
  for (const exemption of CONSTANT_TEXT_CONTRACT_EXEMPTIONS) {
    for (const title of exemption.tests) {
      if (!usedExemptions.has(`${exemption.path}::${title}`)) {
        problems.push(`CONSTANT_TEXT_CONTRACT_EXEMPTIONS retains an unused exemption: ${exemption.path} :: ${title}`);
      }
    }
  }
  return problems;
}
