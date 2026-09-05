/**
 * 子进程编排：每一项测量都在自己的进程里跑。
 *
 * 独立进程是本基准的测量前提，不是实现偏好：同一个 JSC 堆里连着跑，前一项的
 * 类型反馈、内联缓存、页缓存温度和已分配堆都会带进下一项，读数会系统性偏乐观
 * 且顺序相关。父进程只负责 spawn、限时和解析 JSON。
 */

import { CHILD_TIMEOUT_MS } from "./constants";

/** 一次子进程调用的参数。 */
export interface SpawnChildOptions {
  /** `bun` 之后的完整参数表，通常以脚本路径开头。 */
  readonly args: readonly string[];
  /** 追加到当前环境的变量；主要是两个根目录。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 出错信息里用来指认是哪一项测量。 */
  readonly label: string;
  /** 本次调用的时间预算；缺省用 `CHILD_TIMEOUT_MS`。 */
  readonly timeoutMs?: number;
}

/**
 * 跑一个子进程并把 stdout 解析成 JSON。
 *
 * 任何一种失败都抛：非零退出、超时、stdout 不是 JSON。半截读数没有价值，
 * 让它静默变成一行 NaN 只会让整份报告不可信。
 */
export async function spawnJsonChild<TResult>({
  args,
  env,
  label,
  timeoutMs = CHILD_TIMEOUT_MS,
}: SpawnChildOptions): Promise<TResult> {
  const subprocess: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    [Bun.argv[0]!, ...args],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    }
  );
  const stdoutPromise: Promise<string> = subprocess.stdout.text();
  const stderrPromise: Promise<string> = subprocess.stderr.text();
  let timedOut: boolean = false;
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    timedOut = true;
    subprocess.kill();
  }, timeoutMs);
  let exitCode: number;
  try {
    exitCode = await subprocess.exited;
  } finally {
    clearTimeout(timer);
  }
  const stdout: string = await stdoutPromise;
  const stderr: string = await stderrPromise;
  // 超时要点名。被 kill 掉的子进程只留下一个信号退出码，照「exited 143」报，
  // 排查的人会去找一个并不存在的崩溃。
  if (timedOut) {
    throw new Error(
      `${label}: benchmark child exceeded ${timeoutMs} ms and was killed. ${stderr.trim()}`
    );
  }
  if (exitCode !== 0) {
    throw new Error(
      `${label}: benchmark child exited ${exitCode}. ${stderr.trim()}`
    );
  }
  const text: string = stdout.trim();
  if (text.length === 0) {
    throw new Error(`${label}: benchmark child produced no result. ${stderr.trim()}`);
  }
  try {
    return JSON.parse(text) as TResult;
  } catch {
    throw new Error(`${label}: benchmark child did not return JSON.`);
  }
}
