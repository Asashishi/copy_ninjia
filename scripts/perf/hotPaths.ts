import { heapStats } from "bun:jsc";
import type { Message } from "@grammyjs/types";
import {
  aiReplyActivityByChat,
  aiReplyActivitySweepState,
} from "../../packages/cache/main/auto";
import {
  senderUsernameCache,
  userCache,
} from "../../packages/cache/main/senderIdentity";
import { sentMessages } from "../../packages/cache/perThread/selfSentTracker";
import {
  clearAiReplyActivity,
  observeGroupMessageForAiReply,
} from "../../packages/auto/message/aiReplyActivity";
import { isSelfSent } from "../../packages/infra/selfSentTracker";
import { BoundedDeque } from "../../packages/libs/boundedDeque";
import { LinkedQueue } from "../../packages/libs/linkedQueue";
import { trimSlidingWindow } from "../../packages/libs/slidingWindowRateLimit";
import { cacheSender } from "../../packages/users/senderIdentity";
import {
  appendLinkUrls,
  boundSampleContext,
  claimSampleContextParts,
} from "../../packages/workers/antiRaid/adDetect/bundle";
import type { AdCandidateMessage, AdSampleContext } from "../../packages/types/antiRaid";
import type { AdCandidateEntry } from "../../packages/types/antiRaid/adDetect";

type ScenarioName =
  | "sender-no-username"
  | "sender-stable-username"
  | "ai-activity-window"
  | "ai-activity-lru-miss"
  | "ad-empty-metadata"
  | "ad-wire-clone"
  | "array-timestamp-window"
  | "float64-timestamp-window"
  | "array-timestamp-cold"
  | "float64-timestamp-cold"
  | "linked-timestamp-window"
  | "linked-rolling-buffer"
  | "bounded-rolling-buffer"
  | "self-sent-empty";

interface Scenario {
  iterations: number;
  run: (iterations: number) => number;
  reset?: () => void;
}

interface HeapSnapshot {
  heapSize: number;
  extraMemorySize: number;
  objectCount: number;
}

interface BenchmarkResult {
  scenario: ScenarioName;
  bunVersion: string;
  bunRevision: string;
  iterations: number;
  warmupIterations: number;
  samplesNsPerOp: number[];
  medianNsPerOp: number;
  heapDeltaBeforeGc: number;
  extraMemoryDeltaBeforeGc: number;
  objectDeltaBeforeGc: number;
  retainedHeapDelta: number;
  retainedExtraMemoryDelta: number;
  retainedObjectDelta: number;
  checksum: number;
}

/** 单场景计时采样数；中位数用于抵抗偶发调度和 GC 抖动。 */
const SAMPLE_COUNT: number = 7;
/** 正式采样前的预热占比，确保热点有机会进入 JSC 高层级编译。 */
const WARMUP_DIVISOR: number = 5;
/** 基准群聊 id；仅用于进程内 Map，不产生任何 Telegram 或磁盘副作用。 */
const BENCHMARK_CHAT_ID: number = -100_000_000_000_001;
/** 广告无元数据路径的只读空输入，避免基准自身制造额外容器。 */
const EMPTY_LINK_URLS: readonly string[] = Object.freeze([]);
/** 广告无上下文路径的只读既有条目。 */
const EMPTY_AD_ENTRIES: readonly AdCandidateEntry[] = Object.freeze([]);

interface TimestampWindow {
  readonly size: number;
  push(value: number): void;
  trim(windowMs: number, now: number): void;
}

interface RollingBuffer {
  readonly size: number;
  push(value: number): void;
  shift(): number | undefined;
  last(n: number): number[];
  clear(): void;
}

class ArrayTimestampWindow implements TimestampWindow {
  private values: number[];
  private head: number = 0;
  private count: number = 0;

  constructor() {
    this.values = new Array<number>(4);
  }

  get size(): number {
    return this.count;
  }

  push(value: number): void {
    if (this.count === this.values.length) this.grow();
    const index: number = (this.head + this.count) % this.values.length;
    this.values[index] = value;
    this.count += 1;
  }

  trim(windowMs: number, now: number): void {
    while (this.count > 0) {
      const tailIndex: number =
        (this.head + this.count - 1) % this.values.length;
      if ((this.values[tailIndex] ?? now) <= now) break;
      this.count -= 1;
    }
    const cutoff: number = now - windowMs;
    while (
      this.count > 0 &&
      (this.values[this.head] ?? Number.POSITIVE_INFINITY) <= cutoff
    ) {
      this.head = (this.head + 1) % this.values.length;
      this.count -= 1;
    }
    if (this.count === 0) this.head = 0;
  }

  private grow(): void {
    const previous: number[] = this.values;
    const replacement: number[] = new Array<number>(previous.length * 2);
    for (let index: number = 0; index < this.count; index += 1) {
      replacement[index] =
        previous[(this.head + index) % previous.length] ?? 0;
    }
    this.values = replacement;
    this.head = 0;
  }
}

class Float64TimestampWindow implements TimestampWindow {
  private values: Float64Array;
  private head: number = 0;
  private count: number = 0;

  constructor() {
    this.values = new Float64Array(4);
  }

  get size(): number {
    return this.count;
  }

  push(value: number): void {
    if (this.count === this.values.length) this.grow();
    const index: number = (this.head + this.count) % this.values.length;
    this.values[index] = value;
    this.count += 1;
  }

  trim(windowMs: number, now: number): void {
    while (this.count > 0) {
      const tailIndex: number =
        (this.head + this.count - 1) % this.values.length;
      if ((this.values[tailIndex] ?? now) <= now) break;
      this.count -= 1;
    }
    const cutoff: number = now - windowMs;
    while (
      this.count > 0 &&
      (this.values[this.head] ?? Number.POSITIVE_INFINITY) <= cutoff
    ) {
      this.head = (this.head + 1) % this.values.length;
      this.count -= 1;
    }
    if (this.count === 0) this.head = 0;
  }

  private grow(): void {
    const previous: Float64Array = this.values;
    const replacement: Float64Array = new Float64Array(previous.length * 2);
    for (let index: number = 0; index < this.count; index += 1) {
      replacement[index] =
        previous[(this.head + index) % previous.length] ?? 0;
    }
    this.values = replacement;
    this.head = 0;
  }
}

function messageFixture(username?: string): Message {
  return {
    message_id: 1,
    date: 1,
    chat: {
      id: BENCHMARK_CHAT_ID,
      type: "supergroup",
      title: "Performance fixture",
    },
    from: {
      id: 42,
      is_bot: false,
      first_name: "Stable",
      last_name: "Sender",
      username,
    },
  };
}

function senderScenario(username?: string): Scenario {
  const message: Message = messageFixture(username);
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        checksum += cacheSender(message) ?? 0;
      }
      return checksum;
    },
    reset: (): void => {
      userCache.clear();
      senderUsernameCache.clear();
    },
  };
}

function aiActivityScenario(): Scenario {
  let now: number = 1_000_000;
  return {
    iterations: 500_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        checksum += observeGroupMessageForAiReply(BENCHMARK_CHAT_ID, now);
      }
      return checksum;
    },
    reset: (): void => {
      clearAiReplyActivity();
      now = 1_000_000;
    },
  };
}

function aiActivityLruMissScenario(): Scenario {
  let now: number = 1_000_000;
  let chatId: number = BENCHMARK_CHAT_ID;
  return {
    iterations: 20_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        chatId -= 1;
        checksum += observeGroupMessageForAiReply(chatId, now);
      }
      return checksum;
    },
    reset: (): void => {
      clearAiReplyActivity();
      now = 1_000_000;
      chatId = BENCHMARK_CHAT_ID;
    },
  };
}

function linkedTimestampWindowScenario(): Scenario {
  const timestamps: LinkedQueue<number> = new LinkedQueue();
  let now: number = 1_000_000;
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        trimSlidingWindow({ timestamps, windowMs: 165, now });
        timestamps.push(now);
      }
      return timestamps.size;
    },
    reset: (): void => {
      timestamps.clear();
      now = 1_000_000;
    },
  };
}

function timestampWindowScenario(
  createWindow: () => TimestampWindow
): Scenario {
  const timestamps: TimestampWindow = createWindow();
  let now: number = 1_000_000;
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        timestamps.trim(165, now);
        timestamps.push(now);
      }
      return timestamps.size;
    },
  };
}

function coldTimestampWindowScenario(
  createWindow: () => TimestampWindow
): Scenario {
  const timestamps: TimestampWindow[] = [];
  return {
    iterations: 15_000,
    run: (iterations: number): number => {
      timestamps.length = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const window: TimestampWindow = createWindow();
        window.push(index);
        timestamps.push(window);
      }
      return timestamps.length;
    },
    reset: (): void => {
      timestamps.length = 0;
    },
  };
}

function rollingBufferScenario(
  createBuffer: () => RollingBuffer
): Scenario {
  const buffer: RollingBuffer = createBuffer();
  return {
    iterations: 500_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        buffer.push(index);
        if (buffer.size === 150) {
          for (let removed: number = 0; removed < 75; removed += 1) {
            checksum += buffer.shift() ?? 0;
          }
          checksum += buffer.last(75)[0] ?? 0;
        } else if (buffer.size === 75) {
          checksum += buffer.last(75)[0] ?? 0;
        }
      }
      return checksum;
    },
    reset: (): void => {
      buffer.clear();
    },
  };
}

function adEmptyMetadataScenario(): Scenario {
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const linkedText: string = appendLinkUrls("ordinary message", EMPTY_LINK_URLS);
        const context: AdSampleContext | undefined = boundSampleContext(undefined);
        const text: string = context === undefined
          ? linkedText
          : claimSampleContextParts(linkedText, context, EMPTY_AD_ENTRIES);
        checksum += text.length;
      }
      return checksum;
    },
  };
}

function adWireCloneScenario(): Scenario {
  const message: AdCandidateMessage = {
    type: "adCandidate",
    chatId: BENCHMARK_CHAT_ID,
    senderId: 42,
    messageId: 1,
    text: "ordinary message",
    label: "@stable_user",
    isChannel: false,
    blocked: false,
    justJoined: false,
  };
  return {
    iterations: 200_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const cloned: AdCandidateMessage = structuredClone(message);
        checksum += cloned.text.length;
      }
      return checksum;
    },
  };
}

function selfSentEmptyScenario(): Scenario {
  return {
    iterations: 2_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        if (isSelfSent(BENCHMARK_CHAT_ID, index)) checksum += 1;
      }
      return checksum;
    },
    reset: (): void => {
      for (const timer of sentMessages.values()) clearTimeout(timer);
      sentMessages.clear();
    },
  };
}

function createScenario(name: ScenarioName): Scenario {
  switch (name) {
    case "sender-no-username":
      return senderScenario();
    case "sender-stable-username":
      return senderScenario("Stable_User");
    case "ai-activity-window":
      return aiActivityScenario();
    case "ai-activity-lru-miss":
      return aiActivityLruMissScenario();
    case "ad-empty-metadata":
      return adEmptyMetadataScenario();
    case "ad-wire-clone":
      return adWireCloneScenario();
    case "array-timestamp-window":
      return timestampWindowScenario(
        (): TimestampWindow => new ArrayTimestampWindow()
      );
    case "float64-timestamp-window":
      return timestampWindowScenario(
        (): TimestampWindow => new Float64TimestampWindow()
      );
    case "array-timestamp-cold":
      return coldTimestampWindowScenario(
        (): TimestampWindow => new ArrayTimestampWindow()
      );
    case "float64-timestamp-cold":
      return coldTimestampWindowScenario(
        (): TimestampWindow => new Float64TimestampWindow()
      );
    case "linked-timestamp-window":
      return linkedTimestampWindowScenario();
    case "linked-rolling-buffer":
      return rollingBufferScenario(
        (): RollingBuffer => new LinkedQueue<number>()
      );
    case "bounded-rolling-buffer":
      return rollingBufferScenario(
        (): RollingBuffer => new BoundedDeque<number>(150)
      );
    case "self-sent-empty":
      return selfSentEmptyScenario();
  }
}

function snapshotHeap(): HeapSnapshot {
  const stats: ReturnType<typeof heapStats> = heapStats();
  return {
    heapSize: stats.heapSize,
    extraMemorySize: stats.extraMemorySize,
    objectCount: stats.objectCount,
  };
}

function median(values: readonly number[]): number {
  const sorted: number[] = [...values].sort((left: number, right: number): number => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function parseScenarioName(value: string | undefined): ScenarioName {
  switch (value) {
    case "sender-no-username":
    case "sender-stable-username":
    case "ai-activity-window":
    case "ai-activity-lru-miss":
    case "ad-empty-metadata":
    case "ad-wire-clone":
    case "array-timestamp-window":
    case "float64-timestamp-window":
    case "array-timestamp-cold":
    case "float64-timestamp-cold":
    case "linked-timestamp-window":
    case "linked-rolling-buffer":
    case "bounded-rolling-buffer":
    case "self-sent-empty":
      return value;
    default:
      throw new Error(
        "Usage: bun run perf:hot-paths -- " +
        "<sender-no-username|sender-stable-username|ai-activity-window|ad-empty-metadata|" +
        "ai-activity-lru-miss|" +
        "ad-wire-clone|array-timestamp-window|float64-timestamp-window|" +
        "array-timestamp-cold|float64-timestamp-cold|" +
        "linked-timestamp-window|linked-rolling-buffer|" +
        "bounded-rolling-buffer|self-sent-empty>"
      );
  }
}

function runBenchmark(name: ScenarioName): BenchmarkResult {
  const scenario: Scenario = createScenario(name);
  const warmupIterations: number = Math.max(
    10_000,
    Math.floor(scenario.iterations / WARMUP_DIVISOR)
  );
  scenario.reset?.();
  let checksum: number = scenario.run(warmupIterations);
  Bun.gc(true);
  const before: HeapSnapshot = snapshotHeap();
  const samplesNsPerOp: number[] = [];
  for (let sample: number = 0; sample < SAMPLE_COUNT; sample += 1) {
    const startedAt: number = Bun.nanoseconds();
    checksum += scenario.run(scenario.iterations);
    samplesNsPerOp.push(
      (Bun.nanoseconds() - startedAt) / scenario.iterations
    );
  }
  const beforeGc: HeapSnapshot = snapshotHeap();
  Bun.gc(true);
  const retained: HeapSnapshot = snapshotHeap();
  scenario.reset?.();

  return {
    scenario: name,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    iterations: scenario.iterations,
    warmupIterations,
    samplesNsPerOp,
    medianNsPerOp: median(samplesNsPerOp),
    heapDeltaBeforeGc: beforeGc.heapSize - before.heapSize,
    extraMemoryDeltaBeforeGc:
      beforeGc.extraMemorySize - before.extraMemorySize,
    objectDeltaBeforeGc: beforeGc.objectCount - before.objectCount,
    retainedHeapDelta: retained.heapSize - before.heapSize,
    retainedExtraMemoryDelta:
      retained.extraMemorySize - before.extraMemorySize,
    retainedObjectDelta: retained.objectCount - before.objectCount,
    checksum,
  };
}

const scenarioName: ScenarioName = parseScenarioName(process.argv[2]);
const result: BenchmarkResult = runBenchmark(scenarioName);
process.stdout.write(`${JSON.stringify(result)}\n`);

if (aiReplyActivitySweepState.timer !== null || aiReplyActivityByChat.size > 0) {
  clearAiReplyActivity();
}
