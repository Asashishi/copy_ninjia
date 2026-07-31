/** 交给 Gemini 天气工具的东京天气快照。 */
export interface TokyoWeatherResult {
  currentTemperatureC: number;
  currentCondition: string;
  todayMaxC: number;
  todayMinC: number;
  todayCondition: string;
}
