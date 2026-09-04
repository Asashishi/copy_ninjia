/**
 * AI 回复预算与停顿常量之间的数值关系。
 *
 * 这些关系原本只写在 consts 的 JSDoc 里靠人守：改一个数、注释仍然自洽、
 * 全套门禁照样绿，直到线上出现「预算耗尽后模型没有轮次收尾」或
 * 「硬顶低于提示词承诺的上限」这类没人能从代码读出来的行为。
 * 每条断言都对应 consts 里一句成文的约束，注释指到出处。
 */

import { describe, expect, test } from "bun:test";
import {
  AI_MAX_ACTIONS_PER_REPLY,
  HARD_MAX_ACTIONS_PER_REPLY,
  IMAGE_SEPARATE_CAPTION_MIN_REMAINING_ACTIONS,
  MAX_CUSTOM_TOOL_CALLS_PER_REPLY,
  MAX_REACTIONS_PER_REPLY,
  MAX_TOOL_ROUNDS,
  MAX_WEB_SEARCH_CALLS_PER_REPLY,
  TYPING_DELAY_BASE_MS,
  TYPING_DELAY_MAX_MS,
  TYPO_MIN_REMAINING_ACTIONS,
  TYPO_QUICK_CORRECTION_MAX_MS,
  TYPO_QUICK_CORRECTION_MIN_MS,
  TYPO_QUICK_CORRECTION_PROBABILITY,
  AI_TEXT_TYPO_PROBABILITY,
} from "../../../packages/consts/aiChat/tools";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../../packages/consts/aiChat/media";
import { VOICE_MAX_DOWNLOAD_BYTES } from "../../../packages/consts/aiChat/voice";
import {
  KICKED_REJOIN_GRACE_MS,
  LOCKDOWN_KICK_DEDUPE_MS,
} from "../../../packages/consts/antiRaid/verification";

/** 预算类常量必须是正安全整数，否则下面的比较关系本身没有意义。 */
const POSITIVE_INTEGER_BUDGETS: readonly (readonly [string, number])[] = [
  ["AI_MAX_ACTIONS_PER_REPLY", AI_MAX_ACTIONS_PER_REPLY],
  ["HARD_MAX_ACTIONS_PER_REPLY", HARD_MAX_ACTIONS_PER_REPLY],
  ["MAX_REACTIONS_PER_REPLY", MAX_REACTIONS_PER_REPLY],
  ["MAX_TOOL_ROUNDS", MAX_TOOL_ROUNDS],
  ["MAX_CUSTOM_TOOL_CALLS_PER_REPLY", MAX_CUSTOM_TOOL_CALLS_PER_REPLY],
  ["MAX_WEB_SEARCH_CALLS_PER_REPLY", MAX_WEB_SEARCH_CALLS_PER_REPLY],
  ["TYPO_MIN_REMAINING_ACTIONS", TYPO_MIN_REMAINING_ACTIONS],
  ["IMAGE_SEPARATE_CAPTION_MIN_REMAINING_ACTIONS", IMAGE_SEPARATE_CAPTION_MIN_REMAINING_ACTIONS],
];

describe("AI 回复动作预算", () => {
  test("每一项都是正安全整数", () => {
    // 断言整张表而不是逐项 expect：失败时错误信息直接指出是哪个常量坏了。
    const offenders: string[] = POSITIVE_INTEGER_BUDGETS
      .filter(([, value]: readonly [string, number]): boolean =>
        !Number.isSafeInteger(value) || value <= 0)
      .map(([name, value]: readonly [string, number]): string => `${name}=${value}`);
    expect(offenders).toEqual([]);
  });

  /** consts/aiChat/tools.ts：硬顶「必须**大于** AI_MAX_ACTIONS_PER_REPLY」，
   *  为模型偏离提示留余量。相等就等于没有余量，因此是严格大于。 */
  test("执行侧硬顶严格大于写进提示词的动作上限", () => {
    expect(HARD_MAX_ACTIONS_PER_REPLY).toBeGreaterThan(AI_MAX_ACTIONS_PER_REPLY);
  });

  /** 表情反应也从同一份动作预算里扣（见 replyToolset/orchestrator.ts 的
   *  ACTION_TOOL_NAMES），单轮上限不能反过来超过整轮硬顶。 */
  test("单轮反应上限不超过整轮动作硬顶", () => {
    expect(MAX_REACTIONS_PER_REPLY).toBeLessThanOrEqual(HARD_MAX_ACTIONS_PER_REPLY);
  });

  /**
   * 两个「最少剩余动作」阈值是执行器自己在一次调用里落地第二个动作前的自检
   * （手滑补字、超长图注独立补发）。它们必须能在硬顶之内被满足，否则那条分支
   * 永远进不去，功能静默失效。
   */
  test("两处最少剩余动作阈值都能在硬顶内被满足", () => {
    expect(TYPO_MIN_REMAINING_ACTIONS).toBeLessThanOrEqual(HARD_MAX_ACTIONS_PER_REPLY);
    expect(IMAGE_SEPARATE_CAPTION_MIN_REMAINING_ACTIONS)
      .toBeLessThanOrEqual(HARD_MAX_ACTIONS_PER_REPLY);
  });
});

describe("AI 回复工具轮预算", () => {
  /**
   * 整轮函数调用预算耗尽后，replyModel.ts 对每次多余调用回
   * TOOL_BUDGET_EXHAUSTED_RESULT 而**不摘工具声明**，靠模型自己收尾；
   * 真正的止损是 MAX_TOOL_ROUNDS。因此预算必须严格小于轮数上限——
   * 否则预算用完的那一刻轮数也到顶，模型再没有任何一轮可以把话说完，
   * 整轮以零动作告终（见 consts/tools.ts 的 TOOL_BUDGET_EXHAUSTED_RESULT）。
   */
  test("函数调用预算严格小于工具轮硬顶，留出收尾轮次", () => {
    expect(MAX_CUSTOM_TOOL_CALLS_PER_REPLY).toBeLessThan(MAX_TOOL_ROUNDS);
  });

  /**
   * 动作硬顶只封「可见动作」，其余预算留给只读查询与被拒调用。整轮预算若不
   * 大于动作硬顶，模型就没有任何余量做查询，工具集里的只读工具形同虚设。
   */
  test("整轮函数调用预算大于可见动作硬顶，留出只读查询余量", () => {
    expect(MAX_CUSTOM_TOOL_CALLS_PER_REPLY).toBeGreaterThan(HARD_MAX_ACTIONS_PER_REPLY);
  });

  /** 服务端检索额度是软限制、只记账不摘工具，但它仍应落在工具轮硬顶之内，
   *  否则这个数在一轮里根本不可能被触达，写进提示词只是误导模型。 */
  test("服务端检索软额度落在工具轮硬顶之内", () => {
    expect(MAX_WEB_SEARCH_CALLS_PER_REPLY).toBeLessThan(MAX_TOOL_ROUNDS);
  });
});

describe("模拟输入停顿与手滑", () => {
  test("基础停顿不超过单条硬上限", () => {
    expect(TYPING_DELAY_BASE_MS).toBeLessThanOrEqual(TYPING_DELAY_MAX_MS);
  });

  test("补字停顿区间非空", () => {
    expect(TYPO_QUICK_CORRECTION_MIN_MS).toBeLessThanOrEqual(TYPO_QUICK_CORRECTION_MAX_MS);
  });

  test("两个概率都是 0~1 的真概率", () => {
    for (const probability of [AI_TEXT_TYPO_PROBABILITY, TYPO_QUICK_CORRECTION_PROBABILITY]) {
      expect(probability).toBeGreaterThan(0);
      expect(probability).toBeLessThanOrEqual(1);
    }
  });
});

describe("跨领域的字节与时间窗口关系", () => {
  /** consts/aiChat/voice.ts：语音内联上限「明显小于 MEDIA_MAX_DOWNLOAD_BYTES」，
   *  因为 base64 编码后要涨 4/3 而供应商有单次内联总大小上限。 */
  test("语音内联上限严格小于通用媒体下载上限", () => {
    expect(VOICE_MAX_DOWNLOAD_BYTES).toBeLessThan(MEDIA_MAX_DOWNLOAD_BYTES);
  });

  /** consts/antiRaid/verification.ts：重进宽限「远小于 LOCKDOWN_KICK_DEDUPE_MS」，
   *  前者只区分同一次入群的两条投递腿，后者是占位整体存活时长。 */
  test("重进宽限严格小于秒踢占位去重窗口", () => {
    expect(KICKED_REJOIN_GRACE_MS).toBeLessThan(LOCKDOWN_KICK_DEDUPE_MS);
  });
});
