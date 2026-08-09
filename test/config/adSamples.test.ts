import { describe, expect, test } from "bun:test";
import { getAdSampleConfig, loadAdSampleConfig, parseAdSampleConfig } from "../../packages/config/adSamples";
import { AD_SAMPLE_MAX_CHARS, MAX_CONFIGURED_AD_SAMPLES } from "../../packages/consts/antiRaid/adDetect";

describe("ad samples config", () => {
  test("顶层就是字符串数组，空白折叠成单行后原样保留", () => {
    // 示例按行拼进提示词；带换行的一条会被撕成看起来彼此无关的几条。
    expect(parseAdSampleConfig([" 加  微信\n拉群 ", "USDT 承兑"])).toEqual([
      "加 微信 拉群",
      "USDT 承兑",
    ]);
    expect(loadAdSampleConfig().length).toBeGreaterThan(0);
  });

  test("拒绝非数组、非字符串、空白与重复条目", () => {
    expect(() => parseAdSampleConfig({ samples: [] })).toThrow("string array");
    expect(() => parseAdSampleConfig([42])).toThrow("a non-empty string");
    expect(() => parseAdSampleConfig(["   "])).toThrow("a non-empty string");
    // 折叠空白之后才判重：同一条广告多写两个空格不该被当成两条不同口径。
    expect(() => parseAdSampleConfig(["加 微信", "加  微信"])).toThrow("unique after whitespace normalization");
  });

  test("条数与单条长度都有上界", () => {
    const maximum: string[] = Array.from({ length: MAX_CONFIGURED_AD_SAMPLES }, (_, index) => `sample_${index}`);
    expect(parseAdSampleConfig(maximum)).toHaveLength(MAX_CONFIGURED_AD_SAMPLES);
    expect(() => parseAdSampleConfig([...maximum, "overflow"])).toThrow(
      `at most ${MAX_CONFIGURED_AD_SAMPLES} entries`
    );
    expect(() => parseAdSampleConfig(["x".repeat(AD_SAMPLE_MAX_CHARS + 1)])).toThrow(
      `no longer than ${AD_SAMPLE_MAX_CHARS} characters`
    );
  });

  test("解析结果只读，调用方改不动共享单例", () => {
    // 保护由类型承担而非运行期 Object.freeze（见 AGENTS.md 的「常量」一节）。
    // `@ts-expect-error` 只压制类型报错、底下那行照样执行，因此只能拿这份用完
    // 即弃的解析结果来试，绝不能拿 getAdSampleConfig() 的共享单例。
    const probe: readonly string[] = parseAdSampleConfig(["加微信"]);
    expect(probe).toEqual(["加微信"]);
    // @ts-expect-error 示例表不允许就地追加
    probe.push("x");
    // @ts-expect-error 示例表不允许按下标改写
    probe[0] = "x";
  });

  test("默认配置按进程惰性加载一次，之后复用同一份", () => {
    // 提示词每次判定都要拼一遍；每次重读部署文件既慢又会让口径中途漂移。
    expect(getAdSampleConfig()).toBe(getAdSampleConfig());
    expect(getAdSampleConfig()).toEqual(loadAdSampleConfig());
  });
});
