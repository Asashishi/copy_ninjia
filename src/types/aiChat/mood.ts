/** AI 心情系统的领域类型。 */

export type WeatherBucket = "clear" | "cloudy" | "rain" | "snow" | "storm" | "fog";
export type TimeBucket = "lateNight" | "morning" | "daytime" | "evening" | "night";

export interface MoodOption {
  name: string;
  weight: number;
  instruction: string;
  weatherMultipliers?: Partial<Record<WeatherBucket, number>>;
  timeMultipliers?: Partial<Record<TimeBucket, number>>;
}
