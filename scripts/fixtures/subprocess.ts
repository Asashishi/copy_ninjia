/** 测试与夹具共用的外部命令执行边界：异步启动子进程并收集两路输出。 */

/** 一次外部命令的退出码与 stdout、stderr 文本。 */
export interface CapturedCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** runCapturedCommand 的参数；未给出的项沿用 Bun.spawn 的缺省行为。 */
export interface CapturedCommandOptions {
  readonly cmd: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 写入子进程 stdin 的完整字节；缺省时不提供 stdin。 */
  readonly stdin?: Uint8Array;
  /** 超时毫秒数；到时以 killSignal 结束子进程。 */
  readonly timeout?: number;
  readonly killSignal?: NodeJS.Signals;
  /** 子进程可输出的最大字节数；超过时以 killSignal 结束子进程。 */
  readonly maxBuffer?: number;
}

/**
 * 以 Bun.spawn 运行命令，先开始读取 stdout 与 stderr，再等待退出，两路输出读完后返回。
 * 被信号结束时退出码为 128 加信号值。供测试与夹具收集外部命令的退出码和完整输出。
 *
 * 使用异步 Bun.spawn，不使用 Bun.spawnSync。
 */
export async function runCapturedCommand({
  cmd,
  cwd,
  env,
  stdin,
  timeout,
  killSignal,
  maxBuffer,
}: CapturedCommandOptions): Promise<CapturedCommandResult> {
  const subprocess: Bun.Subprocess<Uint8Array | "ignore", "pipe", "pipe"> = Bun.spawn({
    cmd: [...cmd],
    cwd,
    env,
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal,
    maxBuffer,
  });
  const stdout: Promise<string> = subprocess.stdout.text();
  const stderr: Promise<string> = subprocess.stderr.text();
  const exitCode: number = await subprocess.exited;
  return { exitCode, stdout: await stdout, stderr: await stderr };
}
