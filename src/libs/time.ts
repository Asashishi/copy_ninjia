/**
 * 把毫秒数格式化成中文时长文案，如 90_000 -> "1分30秒"，30_000 -> "30秒"。
 * 秒数向上取整：调用方多是「还要等多久」的倒计时/时限文案，宁可报多一点，
 * 也不要在还剩几百毫秒时报出「0秒」。整千毫秒的常量不受影响。
 */
export function formatMinSec(ms: number): string {
  const totalSeconds: number = Math.ceil(ms / 1000);
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  if (minutes === 0) return `${seconds}秒`;
  if (seconds === 0) return `${minutes}分钟`;
  return `${minutes}分${seconds}秒`;
}
