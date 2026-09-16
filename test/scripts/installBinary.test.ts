import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const source: string = await Bun.file(join(import.meta.dir, "../../install.sh")).text();
const decoder: TextDecoder = new TextDecoder();

async function executable(path: string, script: string): Promise<void> {
  await Bun.write(path, `#!/usr/bin/env bash\nset -Eeuo pipefail\n${script}\n`);
  chmodSync(path, 0o700);
}

async function fixture(options: { corrupt?: boolean; missing?: boolean; version?: string; architecture?: string; musl?: boolean; symlink?: boolean; malformedChecksum?: boolean } = {}): Promise<{
  root: string; target: string; result: Bun.SyncSubprocess<"pipe", "pipe">; calls: string;
}> {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-binary-download-"));
  roots.push(root);
  const bin: string = join(root, "bin");
  const target: string = join(root, "deployment");
  const packageRoot: string = join(root, "assets/copy-ninjia");
  const platform: string = options.musl ? "linux-x64-musl" : "linux-x64";
  mkdirSync(join(packageRoot, "config_example"), { recursive: true });
  mkdirSync(bin);
  await executable(join(packageRoot, "copy-ninjia"), 'exec "$REAL_BUN" "$@"');
  await Bun.write(join(packageRoot, "binary.json"), JSON.stringify({ version: options.version ?? "99.0.0", platform, bun: Bun.version }));
  await Bun.write(join(packageRoot, "install.sh"), 'printf "PACKAGE_INSTALLER %s\\n" "$1"\n');
  if (options.symlink) symlinkSync("/outside-deployment", join(packageRoot, "escape"));
  const assetName: string = `copy-ninjia-${platform}.tar.gz`;
  const archive: string = join(root, assetName);
  const tar: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({
    cmd: ["tar", "-czf", archive, "copy-ninjia"], cwd: join(root, "assets"), stdout: "pipe", stderr: "pipe",
  });
  expect(tar.exitCode).toBe(0);
  const hash: string = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
  await Bun.write(`${archive}.sha256`, `${options.corrupt ? "0".repeat(64) : hash}  ${assetName}\n${options.malformedChecksum ? "unexpected line\n" : ""}`);
  await executable(join(bin, "curl"), `
printf 'curl:%s\n' "$*" >> "$CALL_LOG"
case "\u0024{*: -1}" in
  */releases/latest) printf '{"tag_name":"99.0.0"}\n' ;;
  */99.0.0/copy-ninjia-linux-*.tar.gz) [ "$MISSING_ASSET" != 1 ] || exit 22; cp -- "$ASSET" "$3" ;;
  */99.0.0/copy-ninjia-linux-*.tar.gz.sha256) cp -- "$ASSET.sha256" "$3" ;;
  *) exit 93 ;;
esac`);
  for (const command of ["bun", "git", "systemctl", "apt-get", "dnf", "sudo"]) {
    await executable(join(bin, command), `printf '${command}:FORBIDDEN\n' >> "$CALL_LOG"; exit 94`);
  }
  await executable(join(bin, "uname"), 'if [ "$1" = -s ]; then echo Linux; else echo "$ARCHITECTURE"; fi');
  await executable(join(bin, "getconf"), options.musl ? "exit 1" : 'echo "glibc 2.36"');
  await executable(join(bin, "ldd"), 'echo "musl libc" >&2; exit 1');
  // BusyBox 与 GNU 共用 -c；夹具拒绝 GNU 专属长参数，仍用真实 SHA-256 核验内容。
  await executable(join(bin, "sha256sum"), '[ "$1" = -c ] || exit 95; exec "$REAL_SHA256SUM" "$@"');
  await Bun.write(join(root, "install.sh"), source
    .replaceAll("/run/systemd/system", join(root, "absent-systemd"))
    .replace("/etc/systemd/system/${SERVICE_NAME}.service", join(root, "absent.service")));
  const callLog: string = join(root, "calls");
  await Bun.write(callLog, "");
  const result: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({
    cmd: ["script", "-qefc", "bash ./install.sh --binary", "/dev/null"], cwd: root,
    env: {
      PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: root, COPY_NINJIA_DIR: target,
      REAL_BUN: Bun.argv[0]!, REAL_SHA256SUM: Bun.which("sha256sum")!, ASSET: archive, CALL_LOG: callLog,
      MISSING_ASSET: options.missing ? "1" : "0", ARCHITECTURE: options.architecture ?? "x86_64",
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL",
  });
  return { root, target, result, calls: await Bun.file(callLog).text() };
}

afterEach((): void => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("二进制下载安装", (): void => {
  test.each([false, true])("直接下载并校验 Release 包，交给包内安装器，不执行 git 或系统 Bun（musl=%s）", async (musl: boolean): Promise<void> => {
    const { target, result, calls } = await fixture({ musl });
    expect(decoder.decode(result.stderr)).toBe("");
    expect(decoder.decode(result.stdout)).toContain("PACKAGE_INSTALLER --binary");
    expect(result.exitCode).toBe(0);
    expect(calls).toContain("/releases/latest");
    expect(calls).toContain(`/99.0.0/copy-ninjia-linux-x64${musl ? "-musl" : ""}.tar.gz.sha256`);
    expect(calls).not.toContain("FORBIDDEN");
    expect(existsSync(join(target, "copy-ninjia"))).toBe(true);
    expect(existsSync(join(target, ".git"))).toBe(false);
  });

  test.each([
    { corrupt: true }, { missing: true }, { version: "98.0.0" }, { architecture: "riscv64" },
    { symlink: true }, { malformedChecksum: true },
  ])("下载或元数据校验失败时不创建部署：%j", async (options): Promise<void> => {
    const { target, result, calls } = await fixture(options);
    expect(result.exitCode).not.toBe(0);
    expect(decoder.decode(result.stdout)).not.toContain("PACKAGE_INSTALLER");
    expect(existsSync(target)).toBe(false);
    expect(calls).not.toContain("FORBIDDEN");
  });
});
