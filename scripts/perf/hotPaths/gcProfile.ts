/** 固定 Bun 构建的 JSC GC 暂停日志解码；不从 JavaScript 函数名推断 GC 时间。 */
import {
  HOT_PATH_GC_WINDOW_END,
  HOT_PATH_GC_WINDOW_START,
} from "../../../packages/consts/performance";

export interface GcPauseProfile {
  readonly elapsedMs: number;
  readonly pauseCount: number;
  readonly pauseMs: number;
  readonly gcPercent: number;
}

/** 测量边界仅用于独立性能子进程，返回本窗口的单调计时起点。 */
export function beginGcProfileWindow(): number {
  console.error(HOT_PATH_GC_WINDOW_START);
  return performance.now();
}

/** 正式循环结束后立即输出耗时，预热和 retained 模式的强制 GC 均在窗口外。 */
export function endGcProfileWindow(startedAt: number): void {
  const elapsedMs: number = performance.now() - startedAt;
  console.error(`${HOT_PATH_GC_WINDOW_END} ${elapsedMs}`);
}

/**
 * 从唯一正式窗口提取 JSC 的 p= 暂停时长；starting 握手必须存在，未启用日志、
 * 窗口不完整或暂停格式变化时拒绝给出读数。并发收集周期可以跨窗口，每段暂停
 * 在恢复 mutator 前输出 p=；mutator 写下的边界因此能按暂停段精确切开周期。
 */
export function summarizeGcPauseProfile(stderr: string): GcPauseProfile {
  if (!/\[GC<0x[\da-f]+>: starting [\d.]+ms\]/i.test(stderr)) {
    throw new Error("JSC GC logging did not provide its startup handshake.");
  }
  const start: number = stderr.indexOf(HOT_PATH_GC_WINDOW_START);
  const end: number = stderr.indexOf(HOT_PATH_GC_WINDOW_END);
  if (start < 0 || end <= start ||
    stderr.includes(HOT_PATH_GC_WINDOW_START, start + 1) ||
    stderr.includes(HOT_PATH_GC_WINDOW_END, end + 1)) {
    throw new Error("JSC GC logging requires exactly one complete measurement window.");
  }
  const elapsedMs: number = Number(stderr.slice(end + HOT_PATH_GC_WINDOW_END.length).split("\n", 1)[0]?.trim());
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw new Error("JSC GC measurement window has an invalid elapsed time.");
  }
  const window: string = stderr.slice(start + HOT_PATH_GC_WINDOW_START.length, end);
  const phases: number = [...window.matchAll(/\[GC<0x[\da-f]+>: (?:START )?[MC] /gi)].length;
  const headers: number = [...window.matchAll(/\[GC</g)].length;
  const epilogues: number = [...window.matchAll(/\[GC<0x[\da-f]+>: epilogue [\d.]+ms\]/gi)].length;
  const ends: number = [...window.matchAll(/\bEND\]/g)].length;
  let pauseCount: number = 0;
  let pauseMs: number = 0;
  let completedCycles: number = 0;
  for (const match of window.matchAll(/\bp=([\d.]+)ms \(max [\d.]+\)(\.\.\.\]|, cycle [\d.]+ms END\])/g)) {
    const duration: number = Number(match[1]);
    if (!Number.isFinite(duration) || duration < 0) throw new Error("JSC GC pause duration is invalid.");
    pauseCount++;
    pauseMs += duration;
    if (match[2]!.endsWith("END]")) completedCycles++;
  }
  if (pauseCount !== phases || headers !== phases + epilogues || completedCycles !== ends || pauseMs > elapsedMs ||
    pauseCount !== [...window.matchAll(/\bp=/g)].length ||
    (pauseCount === 0 && /\bp=/.test(window))) {
    throw new Error("JSC GC pause log is incomplete or has an unsupported format.");
  }
  return { elapsedMs, pauseCount, pauseMs, gcPercent: pauseMs / elapsedMs * 100 };
}
