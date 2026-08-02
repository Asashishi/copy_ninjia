/** AI 心情系统的领域类型。 */

export type WeatherBucket = "clear" | "cloudy" | "rain" | "snow" | "storm" | "fog";
export type TimeBucket = "lateNight" | "morning" | "daytime" | "evening" | "night";

/**
 * 一档心情。字段全部 `readonly`：这是从 config/mood.json 解析出来、此后只被读取
 * 的配置快照，不可变性由类型承担而不是运行期 `Object.freeze`（理由见 AGENTS.md
 * 的「常量」一节——冻结容器在 JSC 上没有读取快路径）。
 */
export interface MoodOption {
  readonly name: string;
  readonly weight: number;
  readonly instruction: string;
  readonly weatherMultipliers?: Readonly<Partial<Record<WeatherBucket, number>>>;
  readonly timeMultipliers?: Readonly<Partial<Record<TimeBucket, number>>>;
}
