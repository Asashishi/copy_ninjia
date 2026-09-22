/** 编译当前 Linux 平台的发行包；仅收集显式列出的源码资产和已安装的原生依赖。 */
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { familySync, GLIBC, MUSL } from "detect-libc";
import { ACTIVE_COLD_MIGRATION_EDGES } from "./migrations/active";
import { copyFixtureTree } from "./fixtures/copyTree";
import { createReleaseCommand, readBuildSourceTree } from "./release/command";
import { fileSha256, RELEASE_VERSION_PATTERN } from "./release/assets";
import type { ReleaseCommand } from "./release/command";

interface PackageManifest {
  readonly packageManager?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

const projectRoot: string = join(import.meta.dir, "..");
const arguments_: readonly string[] = Bun.argv.slice(2).filter((value: string): boolean => value !== "--");
if (arguments_.length !== 2 || arguments_[0] !== "--version" || !RELEASE_VERSION_PATTERN.test(arguments_[1]!)) {
  throw new Error("Usage: bun run build -- --version MAJOR.MINOR.PATCH (required, no default).");
}
const version: string = arguments_[1]!;
const sourceCommand: ReleaseCommand | null = Bun.which("git") === null ? null : createReleaseCommand(projectRoot);
const sourceTree: string | null = sourceCommand === null ? null : readBuildSourceTree(sourceCommand);
const manifest: PackageManifest = await Bun.file(join(projectRoot, "package.json")).json() as PackageManifest;
if (manifest.packageManager !== `bun@${Bun.version}`) throw new Error("Build requires the packageManager Bun version.");
const libc: string | null = familySync();
if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) || (libc !== GLIBC && libc !== MUSL)) {
  throw new Error("Build requires Linux x64/arm64 with glibc or musl; build natively on each release platform.");
}
const platform: string = `linux-${process.arch}${libc === MUSL ? "-musl" : ""}`;
const sharpPlatform: string = `linux${libc === MUSL ? "musl" : ""}-${process.arch}`;
const assetName: string = `copy-ninjia-${platform}`;
const outputRoot: string = join(projectRoot, "dist");
mkdirSync(outputRoot, { recursive: true });
const stagingRoot: string = mkdtempSync(join(outputRoot, ".build-"));
const packageRoot: string = join(stagingRoot, "copy-ninjia");
mkdirSync(packageRoot);

/** 同步子命令只处理发行暂存目录；失败不产出可上传的包。 */
function run(command: string[], cwd: string): void {
  const result: Bun.SyncSubprocess<"inherit", "inherit"> = Bun.spawnSync({
    cmd: command, cwd, stdout: "inherit", stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`Build command failed: ${command[0]}`);
}

const copiedPackages: Set<string> = new Set();
/** 保留 sharp 官方加载器与当前平台原生库，按已安装 manifest 收集其直接依赖。 */
async function copyPackage(name: string): Promise<void> {
  if (copiedPackages.has(name)) return;
  copiedPackages.add(name);
  const source: string = join(projectRoot, "node_modules", name);
  const dependency: PackageManifest = await Bun.file(join(source, "package.json")).json() as PackageManifest;
  await copyFixtureTree(source, join(packageRoot, "node_modules", name));
  for (const child of Object.keys(dependency.dependencies ?? {})) await copyPackage(child);
}

try {
  const executable: string = join(packageRoot, "copy-ninjia");
  const application: Bun.BuildOutput = await Bun.build({
    entrypoints: ["scripts/binary.ts", "packages/workers/diskIOWorker.ts", "packages/workers/aiChatWorker.ts", "packages/workers/antiRaidWorker.ts"].map(
      (path: string): string => join(projectRoot, path)
    ),
    root: projectRoot,
    compile: { outfile: executable, autoloadBunfig: false },
    external: ["sharp"],
    minify: true,
    sourcemap: "none",
  });
  if (!application.success) throw new AggregateError(application.logs, "Application compilation failed.");
  const installer: Bun.BuildOutput = await Bun.build({
    entrypoints: [join(projectRoot, "scripts/install/runtime.ts")],
    outdir: join(packageRoot, "scripts/install"),
    target: "bun",
    naming: "runtime.js",
    sourcemap: "none",
    // 安装器通过发行包内的 Bun CLI 执行，路径同样以部署工作目录为根。
    define: { "Bun.isStandaloneExecutable": "true" },
    external: ["sharp"],
  });
  if (!installer.success) throw new AggregateError(installer.logs, "Installer compilation failed.");
  for (const edge of ACTIVE_COLD_MIGRATION_EDGES) {
    const migration: Bun.BuildOutput = await Bun.build({
      entrypoints: [join(projectRoot, edge.entryPath)],
      outdir: join(packageRoot, "scripts/migrations"),
      target: "bun",
      naming: "[name].js",
      sourcemap: "none",
      // bundle 的目录与 consts 源码同为根下两层，SQL 等资产相对包根解析。
      define: { "Bun.isStandaloneExecutable": "false" },
      external: ["sharp"],
    });
    if (!migration.success) throw new AggregateError(migration.logs, `Migration compilation failed: ${edge.command}`);
  }
  for (const relative of ["install.sh", "config_example", "prompt", "LICENSES", "packages/database/schema/migrations"]) {
    await copyFixtureTree(join(projectRoot, relative), join(packageRoot, relative));
  }
  for await (const file of new Bun.Glob("*.sh").scan(join(projectRoot, "scripts/install"))) {
    await Bun.write(join(packageRoot, "scripts/install", file), Bun.file(join(projectRoot, "scripts/install", file)));
  }
  for (const name of ["sharp", `@img/sharp-${sharpPlatform}`, `@img/sharp-libvips-${sharpPlatform}`]) await copyPackage(name);
  for await (const file of new Bun.Glob("**/*.map").scan({ cwd: packageRoot, dot: true })) {
    await Bun.file(join(packageRoot, file)).delete();
  }
  await Bun.write(join(packageRoot, "package.json"), JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  await Bun.write(join(packageRoot, "binary.json"), JSON.stringify({ version, platform, bun: Bun.version, bunRevision: Bun.revision, sourceTree }, null, 2) + "\n");
  chmodSync(executable, 0o755);
  run([executable, "--help"], packageRoot);
  run([Bun.argv[0]!, join(projectRoot, "scripts/checkBinary.ts"), packageRoot], projectRoot);
  if (sourceTree !== null && sourceCommand !== null && readBuildSourceTree(sourceCommand) !== sourceTree) {
    throw new Error("Source tree changed during the build; discard this candidate and rebuild.");
  }
  const archive: string = join(stagingRoot, `${assetName}.tar.gz`);
  run(["tar", "-czf", archive, "copy-ninjia"], stagingRoot);
  const checksum: string = await fileSha256(archive);
  await Bun.write(`${archive}.sha256`, `${checksum}  ${assetName}.tar.gz\n`);
  rmSync(join(outputRoot, assetName), { recursive: true, force: true });
  renameSync(packageRoot, join(outputRoot, assetName));
  renameSync(archive, join(outputRoot, `${assetName}.tar.gz`));
  renameSync(`${archive}.sha256`, join(outputRoot, `${assetName}.tar.gz.sha256`));
  console.log(`Built ${version}: dist/${assetName}.tar.gz and .tar.gz.sha256`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
