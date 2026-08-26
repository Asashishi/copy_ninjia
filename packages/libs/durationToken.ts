import {
  DURATION_TOKEN_PATTERN,
  DURATION_UNIT_MS,
} from "../consts/commands";

/**
 * `/mute` 与 `/batch_kick` 共用的「数字 + m/h/d」时长 token 解析与中文渲染。
 *
 * 本模块只做**形态**解析，不带区间判定：`/mute` 把越界值收敛到边界，
 * `/batch_kick` 直接拒绝，区间语义留在各自调用点。
 */

/**
 * 把时长 token 解析成毫秒；形态不合法（缺单位、带小数、前导零、非正数）返回
 * undefined。不判区间，也不判安全整数——超大数值乘出来只会更大，由调用方的
 * 上限收敛或拒绝兜住。
 */
export function parseDurationTokenMs(token: string): number | undefined {
  const match: RegExpExecArray | null = DURATION_TOKEN_PATTERN.exec(token);
  if (match === null) return undefined;
  const value: number = Number(match[1]!);
  const unit: "m" | "h" | "d" = match[2]!.toLowerCase() as "m" | "h" | "d";
  return value * DURATION_UNIT_MS[unit];
}

/**
 * 把整分钟毫秒念成中文战报用语，取能整除的最大单位。
 * 用户写 90m 就念 90 分钟，不替他换算成一个半小时。
 */
export function formatDurationCn(durationMs: number): string {
  if (durationMs % DURATION_UNIT_MS.d === 0) {
    return `${durationMs / DURATION_UNIT_MS.d} 天`;
  }
  if (durationMs % DURATION_UNIT_MS.h === 0) {
    return `${durationMs / DURATION_UNIT_MS.h} 小时`;
  }
  return `${Math.round(durationMs / DURATION_UNIT_MS.m)} 分钟`;
}
