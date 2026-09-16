/** 发布 CLI：构建与验证不访问线上部署；publish 只操作已推送 tag 的 GitHub Release。 */
import { join, resolve } from "node:path";
import { checked, createReleaseCommand, readBuildSourceTree } from "./release/command";
import type { ReleaseCommand } from "./release/command";
import { RELEASE_VERSION_PATTERN, verifyReleaseAssets } from "./release/assets";
import type { ReleaseAsset } from "./release/assets";
import { publishRelease } from "./release/github";

const projectRoot: string = join(import.meta.dir, "..");
const arguments_: readonly string[] = Bun.argv.slice(2).filter((argument: string): boolean => argument !== "--");
const action: string | undefined = arguments_[0];
if (arguments_.includes("--help")) {
  console.log("Usage: bun run release:check -- --version MAJOR.MINOR.PATCH\n" +
    "       bun run release:build -- --version MAJOR.MINOR.PATCH\n" +
    "       bun run release:verify -- --version MAJOR.MINOR.PATCH --platforms linux-x64[,linux-arm64,...] [--directory dist]\n" +
    "       bun run release:publish -- --version MAJOR.MINOR.PATCH --platforms linux-x64[,linux-arm64,...] --notes-file PATH [--directory dist]");
} else {
  if (action !== "check" && action !== "build" && action !== "verify" && action !== "publish") throw new Error("Expected check, build, verify or publish; use --help.");
  const options: Map<string, string> = new Map();
  const allowed: readonly string[] = action === "check" || action === "build" ? ["--version"]
    : action === "verify" ? ["--version", "--platforms", "--directory"] : ["--version", "--platforms", "--directory", "--notes-file"];
  for (let index: number = 1; index < arguments_.length; index += 2) {
    const name: string = arguments_[index]!;
    const value: string | undefined = arguments_[index + 1];
    if (!allowed.includes(name) || options.has(name) || value === undefined || value.startsWith("--")) throw new Error("Invalid or repeated release option; use --help.");
    options.set(name, value);
  }
  const version: string = options.get("--version") ?? "";
  if (!RELEASE_VERSION_PATTERN.test(version)) throw new Error("--version must be MAJOR.MINOR.PATCH without a v prefix.");
  const command: ReleaseCommand = createReleaseCommand(projectRoot);
  if (action === "check") {
    console.log(checked(command, [Bun.argv[0]!, "install", "--frozen-lockfile"]));
    for (const script of ["check", "check:coverage", "test:fault-injection"]) {
      console.log(checked(command, [Bun.argv[0]!, "run", script]));
    }
    console.log(checked(command, [Bun.argv[0]!, join(projectRoot, "scripts/build.ts"), "--version", version]));
  } else {
    const sourceTree: string | null = readBuildSourceTree(command);
    if (sourceTree === null) throw new Error("Release commands require a clean, committed Git worktree.");
    if (action === "build") {
      if (checked(command, ["git", "branch", "--show-current"]) !== "dev") throw new Error("Release builds must run on dev.");
      console.log(checked(command, [Bun.argv[0]!, join(projectRoot, "scripts/build.ts"), "--version", version]));
    } else {
      const platforms: readonly string[] = (options.get("--platforms") ?? "").split(",");
      const assets: readonly ReleaseAsset[] = await verifyReleaseAssets({
        directory: resolve(projectRoot, options.get("--directory") ?? "dist"), version, platforms, sourceTree, command,
      });
      if (action === "verify") console.log(`Verified ${assets.length} release assets for ${version} (${sourceTree}).`);
      else {
        const notes: string | undefined = options.get("--notes-file");
        if (notes === undefined) throw new Error("publish requires --notes-file.");
        const url: string = await publishRelease({ version, notesPath: resolve(notes), assets, command });
        console.log(`Release and downloaded assets confirmed: ${url}\nCheck git diff dev master --quiet before aligning dev.`);
      }
    }
  }
}
