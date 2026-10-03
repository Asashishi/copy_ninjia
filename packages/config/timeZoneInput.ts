import { invalidInput } from "../libs/inputValidation";
import { TIME_ZONE_VALIDATION_CRON } from "../consts/time";

/**
 * 严格解析 IANA 时区名，去掉首尾空白，并核对日历与 Bun cron 均支持该时区。
 * 返回 Temporal 规范化后的 timeZoneId（大小写折叠，如 asia/tokyo → Asia/Tokyo）；别名
 * （如 Japan、Asia/Calcutta）不折叠，按原名返回。
 */
export function parseTimeZone(value: unknown, source: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidInput(source, field, "an IANA time zone name");
  }
  let timeZone: string;
  try {
    timeZone = Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value.trim()).timeZoneId;
    new Intl.DateTimeFormat("en", { timeZone });
    Bun.cron.parse(TIME_ZONE_VALIDATION_CRON, Date.now(), { tz: timeZone });
  } catch (_error: unknown) {
    return invalidInput(source, field, "an IANA time zone name");
  }
  return timeZone;
}
