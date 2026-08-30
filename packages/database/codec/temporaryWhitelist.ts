import {
  TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD,
  TEMPORARY_WHITELIST_REQUIRED_DAYS,
} from "../../consts/temporaryWhitelist";
import { invalidInput } from "../../libs/inputValidation";
import { getTokyoDayIndex } from "../../libs/time";
import type { TemporaryWhitelistActivity } from "../../types/temporaryWhitelist";

function assertTimestamp(value: number, source: string, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    return invalidInput(source, path, "a non-negative safe integer epoch-millisecond timestamp");
  }
}

/** 严格校验临时白名单关系列；存在但不一致的计数或时间一律拒绝。 */
export function assertTemporaryWhitelistActivity(
  value: Readonly<TemporaryWhitelistActivity>,
  source: string
): void {
  if (typeof value.tempWhite !== "boolean") {
    return invalidInput(source, "$.temp_white", "a boolean");
  }
  if (
    !Number.isSafeInteger(value.tempWhiteCount) ||
    value.tempWhiteCount < 0 ||
    value.tempWhiteCount > TEMPORARY_WHITELIST_REQUIRED_DAYS
  ) {
    return invalidInput(source, "$.temp_white_count", "an integer from 0 through 7");
  }
  if (!Number.isSafeInteger(value.sendCount) || value.sendCount < 1) {
    return invalidInput(source, "$.send_count", "a positive safe integer");
  }
  assertTimestamp(value.countedAt, source, "$.counted_at");
  if (value.tempWhiteAt !== null) {
    assertTimestamp(value.tempWhiteAt, source, "$.temp_white_at");
  }
  if (value.qualifiedAt !== null) {
    assertTimestamp(value.qualifiedAt, source, "$.qualified_at");
  }
  if (
    value.tempWhite !== (value.tempWhiteAt !== null) ||
    (!value.tempWhite && value.tempWhiteCount !== 0)
  ) {
    return invalidInput(
      source,
      "$.temp_white",
      "true after the first qualified day and consistent with temp_white_at"
    );
  }
  if (value.tempWhiteAt !== null && value.tempWhiteAt > value.countedAt) {
    return invalidInput(source, "$.temp_white_at", "no later than counted_at");
  }
  if (
    value.qualifiedAt === null &&
    value.sendCount > TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD
  ) {
    return invalidInput(source, "$.qualified_at", "present after the daily threshold is exceeded");
  }
  if (
    value.qualifiedAt !== null &&
    (
      value.sendCount <= TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD ||
      value.tempWhiteCount < 1 ||
      value.qualifiedAt > value.countedAt ||
      getTokyoDayIndex(value.qualifiedAt) !==
        getTokyoDayIndex(value.countedAt)
    )
  ) {
    return invalidInput(
      source,
      "$.qualified_at",
      "in the counted_at Tokyo day after the daily threshold is exceeded"
    );
  }
  if (
    value.tempWhiteAt !== null &&
    value.qualifiedAt !== null &&
    value.tempWhiteAt > value.qualifiedAt
  ) {
    return invalidInput(source, "$.temp_white_at", "no later than qualified_at");
  }
}
