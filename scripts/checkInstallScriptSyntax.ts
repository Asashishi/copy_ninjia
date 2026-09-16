import { join } from "node:path";
import { readInstallScripts } from "./installSources";

const projectRoot: string = join(import.meta.dir, "..");
for (const script of await readInstallScripts(projectRoot)) {
  const result: Bun.SyncSubprocess<"inherit", "inherit"> = Bun.spawnSync({
    cmd: ["bash", "-n", script.path],
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    process.exitCode = 1;
    break;
  }
}
