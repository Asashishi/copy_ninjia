import { describe, expect, test } from "bun:test";
import {
  classifyTimeBucket,
  classifyWeatherCodeBucket,
  computeAdjustedWeight,
  currentMood,
  currentMoodInstruction,
  switchMood,
} from "../../../packages/aiChat/ai/mood";
import { getMoodConfig } from "../../../packages/config/mood";
import { MOOD_REROLL_MAX_MS, MOOD_REROLL_MIN_MS } from "../../../packages/consts/aiChat";
import type { MoodOption } from "../../../packages/types";

/**
 * aiChat/ai/mood.ts 的纯逻辑单测：首次抽取、寿命内维持/到期重抽、群间隔离。所有
 * 用例注入独立 Map，不碰 Worker 全局的 chatMoods/chatMoodExpiresAts（同
 * test/aiChat/ai/stickers/sendLock.test.ts 的隔离方式）。抽中哪一档不硬编码具体
 * 心情名——只断言「roll=0 落在权重表第一档」「roll 顶到上限落在最后一档」，
 * config/mood.json 内容/顺序/条目数之后再调也不用跟着改这份测试。
 */

const MOOD_OPTIONS: readonly MoodOption[] = getMoodConfig().moods;
const FIRST_MOOD_NAME: string = MOOD_OPTIONS[0]!.name;
const LAST_MOOD_NAME: string = MOOD_OPTIONS[MOOD_OPTIONS.length - 1]!.name;

describe("aiChat/ai/mood currentMoodInstruction", () => {
  test("查询未到期心情时返回同一缓存档位且不强制重抽", () => {
    const cachedMood: MoodOption = { name: "平静", weight: 20, instruction: "慢慢来。" };
    const moods = new Map<number, MoodOption>([[1, cachedMood]]);
    const expiresAts = new Map<number, number>([[1, Date.now() + 60_000]]);

    expect(currentMood(1, moods, expiresAts)).toBe(cachedMood);
    expect(moods.get(1)).toBe(cachedMood);
  });

  test("本群第一次用到时直接抽一次心情并按随机寿命记下到期时刻", () => {
    const moods = new Map<number, MoodOption>();
    const expiresAts = new Map<number, number>();
    const originalNow = Date.now;
    const originalRandom = Math.random;
    try {
      Date.now = () => 1_000_000;
      Math.random = () => 0; // roll = 0，落在权重表第一档；寿命取区间下限
      const instruction: string = currentMoodInstruction(1, moods, expiresAts);

      expect(moods.get(1)?.name).toBe(FIRST_MOOD_NAME);
      expect(instruction).toBe(`【今天的心情：${FIRST_MOOD_NAME}】${MOOD_OPTIONS[0]!.instruction}`);
      expect(expiresAts.get(1)).toBe(1_000_000 + MOOD_REROLL_MIN_MS);
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });

  test("寿命没到期时维持原心情；过了寿命上限后必然重抽", () => {
    const moods = new Map<number, MoodOption>();
    const expiresAts = new Map<number, number>();
    const originalNow = Date.now;
    const originalRandom = Math.random;
    try {
      Date.now = () => 1_000_000;
      Math.random = () => 0; // roll = 0，落在权重表第一档
      currentMoodInstruction(1, moods, expiresAts);
      expect(moods.get(1)?.name).toBe(FIRST_MOOD_NAME);

      // 才过 1 分钟，远小于寿命下限（2 小时），不该重抽——即使这次
      // Math.random 换成会抽到另一档心情的值，也不该生效。
      Date.now = () => 1_000_000 + 60_000;
      Math.random = () => 0.99;
      currentMoodInstruction(1, moods, expiresAts);
      expect(moods.get(1)?.name).toBe(FIRST_MOOD_NAME);

      // 过了寿命上限一毫秒：无论寿命本身随机浮动到多少都已到期，一定会
      // 重抽。Math.random 固定为同一个值，重抽后的心情和新寿命共用它。
      // roll 顶到上限附近，落在权重表最后一档。
      Date.now = () => 1_000_000 + MOOD_REROLL_MAX_MS + 1;
      Math.random = () => 0.99;
      currentMoodInstruction(1, moods, expiresAts);
      expect(moods.get(1)?.name).toBe(LAST_MOOD_NAME);
      expect(expiresAts.get(1)).toBe(1_000_000 + MOOD_REROLL_MAX_MS + 1 + MOOD_REROLL_MIN_MS + 0.99 * (MOOD_REROLL_MAX_MS - MOOD_REROLL_MIN_MS));
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });

  test("不同群的心情与到期时刻互不影响", () => {
    const moods = new Map<number, MoodOption>();
    const expiresAts = new Map<number, number>();
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      currentMoodInstruction(1, moods, expiresAts);
      currentMoodInstruction(2, moods, expiresAts);
      expect(moods.size).toBe(2);
      expect(expiresAts.size).toBe(2);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("已有心情且没到期时用缓存的心情拼指令句", () => {
    const moods = new Map<number, MoodOption>([[1, { name: "摆烂", weight: 20, instruction: "随便啦。" }]]);
    const expiresAts = new Map<number, number>([[1, Date.now() + 60_000]]);
    expect(currentMoodInstruction(1, moods, expiresAts)).toBe("【今天的心情：摆烂】随便啦。");
  });
});

describe("aiChat/ai/mood switchMood", () => {
  test("未到期也强制重抽，写回新心情并重掷随机寿命", () => {
    const moods = new Map<number, MoodOption>([[1, { name: "旧心情", weight: 1, instruction: "旧指令" }]]);
    const expiresAts = new Map<number, number>([[1, 9_999_999]]);
    const originalNow = Date.now;
    const originalRandom = Math.random;
    try {
      Date.now = () => 1_000_000;
      Math.random = () => 0; // roll = 0，落在权重表第一档；寿命取区间下限
      const mood: MoodOption = switchMood(1, moods, expiresAts);

      expect(mood.name).toBe(FIRST_MOOD_NAME);
      expect(moods.get(1)?.name).toBe(FIRST_MOOD_NAME);
      expect(expiresAts.get(1)).toBe(1_000_000 + MOOD_REROLL_MIN_MS);
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });

  test("切换后 currentMoodInstruction 直接使用新抽的心情", () => {
    const moods = new Map<number, MoodOption>();
    const expiresAts = new Map<number, number>();
    const originalRandom = Math.random;
    try {
      Math.random = () => 0.99; // roll 顶到上限，落在权重表最后一档
      switchMood(1, moods, expiresAts);
      expect(currentMoodInstruction(1, moods, expiresAts)).toBe(
        `【今天的心情：${LAST_MOOD_NAME}】${MOOD_OPTIONS[MOOD_OPTIONS.length - 1]!.instruction}`
      );
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe("aiChat/ai/mood classifyWeatherCodeBucket", () => {
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

describe("aiChat/ai/mood classifyTimeBucket", () => {
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

describe("aiChat/ai/mood computeAdjustedWeight", () => {
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
