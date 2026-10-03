import { timeZoneState } from "../cache/perThread/time";
import { BOT_CONFIG_PATH } from "../consts/paths";
import { invalidInput } from "../libs/inputValidation";
import type { TimeZoneState } from "../types/time";

/**
 * 接管主线程已严格校验的启动时区；格式器在当前 isolate 构造一次并复用。UTC 偏移区段以空区段
 * 起步，由 libs/time.ts 的首次日历运算填充；换时区时连同区段整体替换。
 */
export function adoptTimeZone(timeZone: string): void {
  if (timeZoneState.current?.timeZone === timeZone) return;
  timeZoneState.current = {
    timeZone,
    fullTimeFormatter: new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      dateStyle: "full",
      timeStyle: "medium",
    }),
    offsetStartMs: 1,
    offsetEndMs: 0,
    offsetMs: 0,
  };
}

/** 当前线程的启动时区快照；初始化完成前拒绝格式化或按日判定。 */
export function getTimeZoneState(): TimeZoneState {
  if (timeZoneState.current === null) {
    return invalidInput(BOT_CONFIG_PATH, "$.time_zone", "initialized before calendar operations");
  }
  return timeZoneState.current;
}

/** 默认 IANA 时区；主线程及 Worker 均只读取本线程已接管的快照。 */
export function getTimeZone(): string {
  return getTimeZoneState().timeZone;
}
