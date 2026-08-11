import { describe, expect, test } from "bun:test";
import { formatAdBundleText, selectAdBundleEntries } from "../../../packages/workers/antiRaid/adDetect/bundle";
import { AD_DETECT_BUNDLE_MAX_CHARS } from "../../../packages/consts/antiRaid/adDetect";
import type { AdBundleSelection, AdCandidateEntry, AdMessageBundle } from "../../../packages/types/antiRaid/adDetect";

function entry(seq: number, text: string): AdCandidateEntry {
  return {
    messageId: seq,
    seq,
    text,
    directText: text,
    receivedAt: 1_000 + seq,
    withinReferencedWarning: false,
  };
}

function bundle(entries: AdCandidateEntry[], checkedSeq: number): AdMessageBundle {
  return {
    chatId: -1001,
    senderId: 42,
    label: "@someone",
    meta: { firstName: "Someone", lastName: "", username: "someone" },
    isChannel: false,
    justJoined: false,
    entries,
    pendingDeleteIds: [],
    nextSeq: entries.length + 1,
    checkedSeq,
  };
}

/**
 * 送检选取是一个纯函数，却决定了「判定读到什么」与「水位推进到哪」，因此单独
 * 成文件覆盖，不挤进那份重 mock 的 adDetectQueue 集成测试。
 */
describe("广告送检条目选取", () => {
  test("未判条目按序装入，水位推进到最后一条装下的序号", () => {
    const selection: AdBundleSelection = selectAdBundleEntries(bundle([entry(1, "a"), entry(2, "b"), entry(3, "c")], 0));
    expect(selection.entries.map((item: AdCandidateEntry): number => item.seq)).toEqual([1, 2, 3]);
    expect(selection.checkedToSeq).toBe(3);
  });

  test("预算有剩余时从紧挨着的已判上下文往回补，且上下文在前、待判在后", () => {
    // 1、2 已判过（checkedSeq=2），3 是唯一未判的。补回来的上下文不推进水位。
    const selection: AdBundleSelection = selectAdBundleEntries(
      bundle([entry(1, "ctx1"), entry(2, "ctx2"), entry(3, "new")], 2)
    );
    // 顺序是这条用例的重点：拼串按序号逐行编号，顺序错了模型读到的上下文就错位。
    expect(selection.entries.map((item: AdCandidateEntry): number => item.seq)).toEqual([1, 2, 3]);
    expect(selection.checkedToSeq).toBe(3);
  });

  test("全部已判过时不选出任何新内容，水位原地不动（选出来的只是上下文）", () => {
    // 这种 bundle 在真实路径上到不了这里——派发前 admitAdRequeue 的
    // hasUncheckedContent 闸就把它挡住了。这里钉的是水位不变量本身：没有比
    // checkedSeq 更大的条目被选中，checkedToSeq 也绝不能前进，否则一次空转
    // 就会把还没判过的内容记成判过。
    const selection: AdBundleSelection = selectAdBundleEntries(bundle([entry(1, "a"), entry(2, "b")], 2));
    expect(selection.checkedToSeq).toBe(2);
    expect(selection.entries.every((item: AdCandidateEntry): boolean => item.seq <= 2)).toBe(true);
  });

  test("第一条未判内容即使超预算也无条件装下，否则这个键会卡在判不动又推不进水位", () => {
    const huge: string = "x".repeat(AD_DETECT_BUNDLE_MAX_CHARS + 100);
    const selection: AdBundleSelection = selectAdBundleEntries(bundle([entry(1, huge), entry(2, "next")], 0));
    expect(selection.entries.map((item: AdCandidateEntry): number => item.seq)).toEqual([1]);
    expect(selection.checkedToSeq).toBe(1);
  });

  test("预算耗尽时后续未判内容留到下一轮，水位只推进到真正装下的那条", () => {
    const half: string = "y".repeat(Math.floor(AD_DETECT_BUNDLE_MAX_CHARS * 0.6));
    const selection: AdBundleSelection = selectAdBundleEntries(
      bundle([entry(1, half), entry(2, half), entry(3, "tail")], 0)
    );
    expect(selection.entries.map((item: AdCandidateEntry): number => item.seq)).toEqual([1]);
    expect(selection.checkedToSeq).toBe(1);
  });

  test("返回的清单是独立数组，调用方改它不会污染原 bundle", () => {
    // 选取内部复用了自己那个局部上下文数组来承载最终清单；它必须仍与
    // bundle.entries 无别名，否则调用方（disposal 侧要留一份送检快照）一改就
    // 把原串也改了。
    const source: AdCandidateEntry[] = [entry(1, "a"), entry(2, "b")];
    const original: AdMessageBundle = bundle(source, 0);
    const selection: AdBundleSelection = selectAdBundleEntries(original);
    selection.entries.push(entry(99, "injected"));
    expect(original.entries.map((item: AdCandidateEntry): number => item.seq)).toEqual([1, 2]);
    expect(source).toHaveLength(2);
  });

  test("拼串按选取结果逐行编号，空清单给出空串", () => {
    expect(formatAdBundleText([entry(1, "第一条"), entry(2, "第二条")])).toBe("1. 第一条\n2. 第二条");
    expect(formatAdBundleText([])).toBe("");
  });
});
