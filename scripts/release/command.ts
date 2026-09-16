/** 发布子命令只由显式 CLI 调用；测试注入替身，不访问 GitHub 或修改分支。 */
export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

export type ReleaseCommand = (arguments_: readonly string[]) => CommandResult;

/** 固定工作目录，参数按 argv 传递，不经过 shell 展开。 */
export function createReleaseCommand(cwd: string): ReleaseCommand {
  return (arguments_: readonly string[]): CommandResult => {
    const result: Bun.SyncSubprocess<"pipe", "inherit"> = Bun.spawnSync({
      cmd: [...arguments_], cwd, stdout: "pipe", stderr: "inherit",
    });
    return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout) };
  };
}

/** 任一步失败立即停止，由调用者保留已推送 tag 和 Release 草稿以便续跑。 */
export function checked(command: ReleaseCommand, arguments_: readonly string[]): string {
  const result: CommandResult = command(arguments_);
  if (result.exitCode !== 0) throw new Error(`Release command failed: ${arguments_.slice(0, 3).join(" ")}`);
  return result.stdout.trim();
}

/** 只为干净 Git 工作树记录谱系；本地开发包和无 Git 源码包不具备发布谱系。 */
export function readBuildSourceTree(command: ReleaseCommand): string | null {
  const status: CommandResult = command(["git", "status", "--porcelain", "--untracked-files=all"]);
  if (status.exitCode !== 0 || status.stdout.trim() !== "") return null;
  const tree: CommandResult = command(["git", "rev-parse", "HEAD^{tree}"]);
  return tree.exitCode === 0 && /^[a-f0-9]{40}$/.test(tree.stdout.trim()) ? tree.stdout.trim() : null;
}

/** 发布前后都核对 master、annotated tag 及其远端对象；本函数不创建或推送引用。 */
export function verifyReleaseReferences(command: ReleaseCommand, version: string): void {
  if (checked(command, ["git", "branch", "--show-current"]) !== "master") throw new Error("Publish requires master.");
  const origin: string = checked(command, ["git", "remote", "get-url", "origin"]);
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:)Asashishi\/copy_ninjia(?:\.git)?$/.test(origin)) {
    throw new Error("origin must be Asashishi/copy_ninjia on github.com.");
  }
  const head: string = checked(command, ["git", "rev-parse", "HEAD"]);
  const tag: string = `refs/tags/${version}`;
  if (checked(command, ["git", "cat-file", "-t", tag]) !== "tag" ||
    checked(command, ["git", "rev-parse", `${tag}^{commit}`]) !== head) {
    throw new Error("The annotated release tag must point to master HEAD.");
  }
  const tagObject: string = checked(command, ["git", "rev-parse", tag]);
  const remote: string = checked(command, ["git", "ls-remote", "origin", "refs/heads/master", tag, `${tag}^{}`]);
  const references: Map<string, string> = new Map(remote.split("\n").map((line: string): [string, string] => {
    const fields: string[] = line.split(/\s+/);
    return [fields[1] ?? "", fields[0] ?? ""];
  }));
  if (references.get("refs/heads/master") !== head || references.get(tag) !== tagObject || references.get(`${tag}^{}`) !== head) {
    throw new Error("Push master and its annotated tag separately before publishing; remote references must match.");
  }
}
