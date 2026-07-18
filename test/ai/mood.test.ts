import { describe, expect, test } from "bun:test";
import {
  classifyTimeBucket,
  classifyWeatherCodeBucket,
  computeAdjustedWeight,
  currentMoodInstruction,
  recordActivityAndMaybeRerollMood,
} from "../../src/ai/mood";
import { MOOD_IDLE_RESET_MAX_MS, MOOD_OPTIONS } from "../../src/consts/aiChat";
import type { MoodOption } from "../../src/types";

/**
 * ai/mood.ts 的纯逻辑单测：首次抽取、空窗重抽/维持、群间隔离。所有用例
 * 注入独立 Map，不碰 Worker 全局的 chatMoods/chatLastActivityTimes（同
 * test/ai/stickerSendLock.test.ts 的隔离方式）。抽中哪一档不硬编码具体
 * 心情名——只断言「roll=1 落在权重表第一档」「roll=100 落在最后一档」，
 * MOOD_OPTIONS 内容/顺序/条目数之后再调也不用跟着改这份测试。
 */

const FIRST_MOOD_NAME: string = MOOD_OPTIONS[0]!.name;
const LAST_MOOD_NAME: string = MOOD_OPTIONS[MOOD_OPTIONS.length - 1]!.name;

describe("ai/mood recordActivityAndMaybeRerollMood", () => {
  test("本群第一次有动静时直接抽一次心情", () => {
    const moods = new Map<number, MoodOption>();
    const lastActivityTimes = new Map<number, number>();
    const originalNow = Date.now;
    const originalRandom = Math.random;
    try {
      Date.now = () => 1_000_000;
      Math.random = () => 0; // roll = 1，落在权重表第一档
      recordActivityAndMaybeRerollMood(1, moods, lastActivityTimes);

      expect(moods.get(1)?.name).toBe(FIRST_MOOD_NAME);
      expect(lastActivityTimes.get(1)).toBe(1_000_000);
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });

  test("空窗时长不到阈值下限时维持原心情；超过阈值上限时必然重抽", () => {
    const moods = new Map<number, MoodOption>();
    const lastActivityTimes = new Map<number, number>();
    const originalNow = Date.now;
    const originalRandom = Math.random;
    try {
      Date.now = () => 1_000_000;
      Math.random = () => 0; // roll = 1，落在权重表第一档
      recordActivityAndMaybeRerollMood(1, moods, lastActivityTimes);
      expect(moods.get(1)?.name).toBe(FIRST_MOOD_NAME);

      // 空窗只有 1 分钟，远小于阈值下限（2 小时），不该重抽——即使这次
      // Math.random 换成会抽到另一档心情的值，也不该生效。
      Date.now = () => 1_000_000 + 60_000;
      Math.random = () => 0.99;
      recordActivityAndMaybeRerollMood(1, moods, lastActivityTimes);
      expect(moods.get(1)?.name).toBe(FIRST_MOOD_NAME);
      expect(lastActivityTimes.get(1)).toBe(1_000_000 + 60_000);

      // 空窗拉到超过阈值上限一毫秒：无论阈值本身随机浮动到多少，都必然
      // 落在空窗之内，一定会重抽。Math.random 固定为同一个值，阈值浮动
      // 和重抽后的心情共用它。roll = 100，落在权重表最后一档。
      Date.now = () => 1_000_000 + 60_000 + MOOD_IDLE_RESET_MAX_MS + 1;
      Math.random = () => 0.99;
      recordActivityAndMaybeRerollMood(1, moods, lastActivityTimes);
      expect(moods.get(1)?.name).toBe(LAST_MOOD_NAME);
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });

  test("不同群的心情与活跃时间互不影响", () => {
    const moods = new Map<number, MoodOption>();
    const lastActivityTimes = new Map<number, number>();
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      recordActivityAndMaybeRerollMood(1, moods, lastActivityTimes);
      recordActivityAndMaybeRerollMood(2, moods, lastActivityTimes);
      expect(moods.size).toBe(2);
      expect(lastActivityTimes.size).toBe(2);
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe("ai/mood currentMoodInstruction", () => {
  test("没有心情记录时返回空串", () => {
    expect(currentMoodInstruction(1, new Map())).toBe("");
  });

  test("有心情记录时拼出带心情名的指令句", () => {
    const moods = new Map<number, MoodOption>([[1, { name: "摆烂", weight: 20, instruction: "随便啦。" }]]);
    expect(currentMoodInstruction(1, moods)).toBe("【今天的心情：摆烂】随便啦。");
  });
});

describe("ai/mood classifyWeatherCodeBucket", () => {
  test("按 WMO 代码归类到粗粒度天气桶", () => {
    expect(classifyWeatherCodeBucket(0)).toBe("clear");
    expect(classifyWeatherCodeBucket(1)).toBe("clear");
    expect(classifyWeatherCodeBucket(2)).toBe("cloudy");
    expect(classifyWeatherCodeBucket(3)).toBe("cloudy");
    expect(classifyWeatherCodeBucket(45)).toBe("fog");
    expect(classifyWeatherCodeBucket(48)).toBe("fog");
    expect(classifyWeatherCodeBucket(61)).toBe("rain");
    expect(classifyWeatherCodeBucket(82)).toBe("rain");
    expect(classifyWeatherCodeBucket(71)).toBe("snow");
    expect(classifyWeatherCodeBucket(86)).toBe("snow");
    expect(classifyWeatherCodeBucket(95)).toBe("storm");
    expect(classifyWeatherCodeBucket(99)).toBe("storm");
  });
});

describe("ai/mood classifyTimeBucket", () => {
  test("按东京时区小时数归类到粗粒度时段桶（边界值）", () => {
    expect(classifyTimeBucket(0)).toBe("lateNight");
    expect(classifyTimeBucket(4)).toBe("lateNight");
    expect(classifyTimeBucket(5)).toBe("morning");
    expect(classifyTimeBucket(8)).toBe("morning");
    expect(classifyTimeBucket(9)).toBe("daytime");
    expect(classifyTimeBucket(17)).toBe("daytime");
    expect(classifyTimeBucket(18)).toBe("evening");
    expect(classifyTimeBucket(21)).toBe("evening");
    expect(classifyTimeBucket(22)).toBe("night");
    expect(classifyTimeBucket(23)).toBe("night");
  });
});

describe("ai/mood computeAdjustedWeight", () => {
  const mood: MoodOption = {
    name: "测试心情",
    weight: 10,
    instruction: "",
    weatherMultipliers: { rain: 2, clear: 0.5 },
    timeMultipliers: { night: 1.5 },
  };

  test("天气/时段倍率相乘作用在 base weight 上", () => {
    expect(computeAdjustedWeight(mood, "rain", "night")).toBeCloseTo(10 * 2 * 1.5);
  });

  test("桶不在倍率表里按 ×1 处理", () => {
    expect(computeAdjustedWeight(mood, "snow", "daytime")).toBe(10);
  });

  test("天气未知（缓存还没暖起来）时天气维度按 ×1，只应用时段倍率", () => {
    expect(computeAdjustedWeight(mood, null, "night")).toBe(10 * 1.5);
  });

  test("没有配置任何倍率表的心情始终是 base weight", () => {
    const plain: MoodOption = { name: "无倍率心情", weight: 7, instruction: "" };
    expect(computeAdjustedWeight(plain, "rain", "lateNight")).toBe(7);
  });
});
