/**
 * 广告待检表两层索引（群 id → 发送者 id）与改造前单层 `chatId:senderId` 字符串键索引的对拍。
 *
 * 旧模型逐字保留改造前的语义：已有发送者再来消息时重复 set 并刷新饱和边沿，停管按 bundle.chatId
 * 逐键删、免检按 bundle.senderId 逐键删，容量按表大小判。新实现直接调用 queueState.ts 的访问函数。
 * 同一随机操作序列逐步喂给两边，每步比较条数、群层数、每个键取到的对象、容量拒绝结论与饱和标志，以及
 * 每个群内的发送者顺序。跨群的遍历次序不在对拍范围内：两层表按群分组遍历，只影响 sweep 兜底
 * 补排进队的先后（见 sweepAdDetect 的 JSDoc）。
 */

import { beforeEach, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import type { AdMessageBundle } from "../../../packages/types/antiRaid/adDetect";

/** 调小的待检容量，让两万步里反复撞满与恢复。 */
const TEST_PENDING_CAPACITY: number = 9;
const realAdDetectConsts = await import("../../../packages/consts/antiRaid/adDetect");
mock.module("../../../packages/consts/antiRaid/adDetect", () => ({
  ...realAdDetectConsts,
  AD_DETECT_MAX_PENDING_SENDERS: TEST_PENDING_CAPACITY,
}));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub() }));

const {
  clearPendingAdBundles,
  deletePendingAdBundle,
  deletePendingAdBundlesInChat,
  deletePendingAdBundlesOfSender,
  pendingAdBundle,
  pendingAdBundleForKey,
  refreshAdDetectCapacitySaturation,
  rejectNewAdBundleAtCapacity,
  storeBundle,
} = await import("../../../packages/workers/antiRaid/adDetect/queueState");
const { isNewAdBundleAtCapacity } = await import("../../../packages/states/adDetectAdmission");
const { adDetectCapacitySaturated, pendingAdBundleCount, pendingAdMessages } =
  await import("../../../packages/cache/workers/antiRaid/adDetect");
const { verificationKey } = await import("../../../packages/libs/verificationKey");

const CHAT_IDS: readonly number[] = [-1001, -1002, -1003, -1004];
const SENDER_IDS: readonly number[] = [1, 2, 3, 4, 5, 6];
const STEPS: number = 20_000;

/** 改造前的待检表：单层 Map，键为 verificationKey。 */
class LegacyPendingIndex {
  readonly bundles: Map<string, AdMessageBundle> = new Map<string, AdMessageBundle>();
  saturated: boolean = false;

  get(chatId: number, senderId: number): AdMessageBundle | undefined {
    return this.bundles.get(verificationKey(chatId, senderId));
  }

  store(bundle: AdMessageBundle): void {
    this.bundles.set(verificationKey(bundle.chatId, bundle.senderId), bundle);
    this.refresh();
  }

  delete(chatId: number, senderId: number): void {
    this.bundles.delete(verificationKey(chatId, senderId));
  }

  deleteChat(chatId: number): void {
    for (const [key, bundle] of this.bundles) {
      if (bundle.chatId === chatId) this.bundles.delete(key);
    }
  }

  deleteSender(senderId: number): void {
    for (const [key, bundle] of this.bundles) {
      if (bundle.senderId === senderId) this.bundles.delete(key);
    }
  }

  rejectAtCapacity(): boolean {
    if (!isNewAdBundleAtCapacity(this.bundles.size)) return false;
    this.saturated = true;
    return true;
  }

  refresh(): void {
    this.saturated = isNewAdBundleAtCapacity(this.bundles.size);
  }
}

/** 确定性伪随机数（mulberry32），同一种子每次得到同一操作序列。 */
function seededRandom(seed: number): () => number {
  let state: number = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed: number = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 对拍只关心索引身份，其余字段不参与比较。 */
function bundleOf(chatId: number, senderId: number): AdMessageBundle {
  return { key: verificationKey(chatId, senderId), chatId, senderId } as unknown as AdMessageBundle;
}

/** 两边的第一处差异；一致时为 undefined。逐步只做比较，差异汇总成一次断言。 */
function indexDifference(legacy: LegacyPendingIndex): string | undefined {
  if (pendingAdBundleCount.current !== legacy.bundles.size) {
    return `count ${pendingAdBundleCount.current} vs ${legacy.bundles.size}`;
  }
  if (adDetectCapacitySaturated.current !== legacy.saturated) {
    return `saturated ${adDetectCapacitySaturated.current} vs ${legacy.saturated}`;
  }
  const legacyChats: Set<number> = new Set<number>();
  for (const bundle of legacy.bundles.values()) legacyChats.add(bundle.chatId);
  if (pendingAdMessages.size !== legacyChats.size) return `chat layers ${pendingAdMessages.size} vs ${legacyChats.size}`;
  for (const chatId of CHAT_IDS) {
    for (const senderId of SENDER_IDS) {
      const expected: AdMessageBundle | undefined = legacy.get(chatId, senderId);
      if (pendingAdBundle(chatId, senderId) !== expected) return `bundle ${chatId}/${senderId}`;
      if (expected !== undefined && pendingAdBundleForKey(expected.key) !== expected) return `key ${expected.key}`;
    }
    const legacyOrder: number[] = [];
    for (const bundle of legacy.bundles.values()) {
      if (bundle.chatId === chatId) legacyOrder.push(bundle.senderId);
    }
    const order: string = [...(pendingAdMessages.get(chatId)?.keys() ?? [])].join(",");
    if (order !== legacyOrder.join(",")) return `order in ${chatId}: ${order} vs ${legacyOrder.join(",")}`;
  }
  return undefined;
}

beforeEach(() => {
  clearPendingAdBundles();
  adDetectCapacitySaturated.current = false;
});

test("两层索引与旧单层索引在同一随机操作序列下逐步一致", () => {
  const legacy: LegacyPendingIndex = new LegacyPendingIndex();
  const random: () => number = seededRandom(0x5eed_ad01);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  let rejected: number = 0;
  let saturatedSteps: number = 0;
  let mismatch: string | undefined;

  for (let step: number = 0; step < STEPS; step++) {
    const chatId: number = pick(CHAT_IDS);
    const senderId: number = pick(SENDER_IDS);
    const roll: number = random();
    if (roll < 0.55) {
      // 一条新候选：已有发送者原地并入（旧实现重复 set），新发送者先过容量闸再入表。
      const existing: AdMessageBundle | undefined = legacy.get(chatId, senderId);
      if (existing !== undefined) {
        legacy.store(existing);
      } else {
        const legacyRejected: boolean = legacy.rejectAtCapacity();
        if (rejectNewAdBundleAtCapacity() !== legacyRejected) mismatch = `rejection ${!legacyRejected} vs ${legacyRejected}`;
        if (legacyRejected) {
          rejected++;
        } else {
          const bundle: AdMessageBundle = bundleOf(chatId, senderId);
          legacy.store(bundle);
          storeBundle(bundle);
        }
      }
    } else if (roll < 0.8) {
      // 判定处置或整串判完：删掉这一串，调用方随后刷新容量状态。
      legacy.delete(chatId, senderId);
      legacy.refresh();
      deletePendingAdBundle(chatId, senderId);
      refreshAdDetectCapacitySaturation();
    } else if (roll < 0.9) {
      // 停管或关开关。
      legacy.deleteChat(chatId);
      legacy.refresh();
      deletePendingAdBundlesInChat(chatId);
      refreshAdDetectCapacitySaturation();
    } else if (roll < 0.99) {
      // 取得临时免检的身份。
      legacy.deleteSender(senderId);
      legacy.refresh();
      deletePendingAdBundlesOfSender(senderId);
      refreshAdDetectCapacitySaturation();
    } else {
      // Worker 停止：整表清空，饱和标志归零（同 stopAdDetectQueue）。
      legacy.bundles.clear();
      legacy.saturated = false;
      clearPendingAdBundles();
      adDetectCapacitySaturated.current = false;
    }
    if (legacy.saturated) saturatedSteps++;
    mismatch ??= indexDifference(legacy);
    if (mismatch !== undefined) {
      mismatch = `step ${step}: ${mismatch}`;
      break;
    }
  }

  expect(mismatch).toBeUndefined();

  // 序列确实覆盖了容量拒绝与饱和区间，不是在空表上空转。
  expect(rejected).toBeGreaterThan(0);
  expect(saturatedSteps).toBeGreaterThan(0);
});
