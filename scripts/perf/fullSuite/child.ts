/**
 * 子进程编排：每一项测量都在自己的进程里跑。
 *
 * 父进程只负责 spawn、限时和解析 JSON，不参与被测量的执行过程。
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
  /** 子进程成功返回 JSON 后收到完整 stderr；回调抛错按本次调用失败处理。 */
  readonly onStderr?: (stderr: string) => void;
}

/**
 * 跑一个子进程并把 stdout 解析成 JSON。
 *
 * 以下情形都会抛出而不是返回部分结果：非零退出、超时、stdout 不是合法 JSON。
 */
export async function spawnJsonChild<TResult>({
  args,
  env,
  label,
  timeoutMs = CHILD_TIMEOUT_MS,
  onStderr,
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
  // 超时单独归类为一种失败，不复用 kill 后子进程留下的信号退出码。
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
  let result: TResult;
  try {
    result = JSON.parse(text) as TResult;
  } catch {
    throw new Error(`${label}: benchmark child did not return JSON.`);
  }
  onStderr?.(stderr);
  return result;
}
