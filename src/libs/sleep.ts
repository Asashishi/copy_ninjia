/** 睡眠 ms 毫秒的 Promise，配合 await 用于节流/限速重试等场景。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
