import { describe, expect, mock, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot: string = join(import.meta.dir, "..");

function findRuntimeModules(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path: string = join(dir, entry.name);
    if (entry.isDirectory()) {
      // src/types/ 只含被 TypeScript 擦除的 interface/type 声明，没有运行时代码。
      if (path === join(projectRoot, "src", "types")) continue;
      result.push(...findRuntimeModules(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      result.push(path);
    }
  }
  return result;
}

const productionRuntimeModules: string[] = [
  join(projectRoot, "index.ts"),
  ...findRuntimeModules(join(projectRoot, "src")),
].sort();

describe("production module coverage manifest", () => {
  test("loads every runtime module without starting Workers, timers, or network", async () => {
    const originalWorker: typeof Worker = globalThis.Worker;
    const originalFetch: typeof fetch = globalThis.fetch;
    const originalSetInterval: typeof setInterval = globalThis.setInterval;
    const originalSetTimeout: typeof setTimeout = globalThis.setTimeout;
    let workerStarts: number = 0;
    let networkStarts: number = 0;
    let intervalStarts: number = 0;
    let timeoutStarts: number = 0;
    let currentImportPath: string = "";
    const timeoutImportPaths: string[] = [];

    class ImportGuardWorker {
      constructor() {
        workerStarts++;
        throw new Error("A production module started a Worker during import.");
      }
    }

    globalThis.Worker = ImportGuardWorker as unknown as typeof Worker;
    globalThis.fetch = ((): Promise<Response> => {
      networkStarts++;
      throw new Error("A production module started a network request during import.");
    }) as unknown as typeof fetch;
    globalThis.setInterval = ((): ReturnType<typeof setInterval> => {
      intervalStarts++;
      throw new Error("A production module registered an interval during import.");
    }) as typeof setInterval;
    globalThis.setTimeout = ((): ReturnType<typeof setTimeout> => {
      timeoutStarts++;
      timeoutImportPaths.push(currentImportPath);
      throw new Error("A production module registered a timeout during import.");
    }) as unknown as typeof setTimeout;

    // 文件系统写入与上面三类副作用同级拦截：任何生产模块都不得在 import
    // 阶段写盘（历史事故见 .claude/CLAUDE.md——曾有测试进程覆盖掉线上
    // state.json，这里是同一道防线在模块图层面的兜底断言）。只拦截写路径，
    // import 阶段的合法读取（readFileSync/readdirSync 等）走真实实现。
    //
    // 拦截必须做成「带开关的透传包装」而不是简单替换：本 bun 版本对同一
    // builtin 的 mock.module 二次调用不会覆盖第一次，mock 装上就摘不掉；
    // 非 --isolate 的 bun test 里它会泄漏到同进程随后加载的测试文件（真实
    // 读写临时目录的 diskIO/instanceLock 等测试会被误伤）。开关在 finally
    // 里关掉后，泄漏出去的只是对真实实现的纯透传。
    let fsWriteStarts: number = 0;
    let fsGuardActive: boolean = false;
    const realFs: Record<string, unknown> = { ...(await import("node:fs")) };
    const realFsPromises: Record<string, unknown> = { ...(await import("node:fs/promises")) };
    function guardFsWrite(real: Record<string, unknown>, name: string, label: string): (...args: unknown[]) => unknown {
      return (...args: unknown[]): unknown => {
        if (fsGuardActive) {
          fsWriteStarts++;
          throw new Error(`A production module called fs.${label} during import.`);
        }
        return (real[name] as (...passthroughArgs: unknown[]) => unknown)(...args);
      };
    }
    const syncWriteFns: readonly string[] = [
      "writeFileSync", "appendFileSync", "writeSync", "openSync", "mkdirSync", "renameSync",
      "unlinkSync", "rmSync", "rmdirSync", "chmodSync", "copyFileSync", "truncateSync",
      "ftruncateSync", "symlinkSync", "linkSync", "createWriteStream",
    ];
    const asyncWriteFns: readonly string[] = [
      "writeFile", "appendFile", "open", "mkdir", "rename",
      "unlink", "rm", "rmdir", "chmod", "copyFile", "truncate", "symlink", "link",
    ];
    const guardedFs: Record<string, unknown> = { ...realFs };
    for (const name of syncWriteFns) guardedFs[name] = guardFsWrite(realFs, name, name);
    const guardedFsPromises: Record<string, unknown> = { ...realFsPromises };
    for (const name of asyncWriteFns) guardedFsPromises[name] = guardFsWrite(realFsPromises, name, `promises.${name}`);
    mock.module("node:fs", () => guardedFs);
    mock.module("node:fs/promises", () => guardedFsPromises);
    fsGuardActive = true;

    try {
      for (const path of productionRuntimeModules) {
        currentImportPath = path;
        await import(pathToFileURL(path).href);
      }
    } finally {
      globalThis.Worker = originalWorker;
      globalThis.fetch = originalFetch;
      globalThis.setInterval = originalSetInterval;
      globalThis.setTimeout = originalSetTimeout;
      // 关掉开关：此后（含泄漏到其它测试文件的场景）包装函数全部透传真实实现。
      fsGuardActive = false;
    }

    expect(productionRuntimeModules.length).toBeGreaterThan(100);
    expect(timeoutImportPaths).toEqual([]);
    expect({ workerStarts, networkStarts, intervalStarts, timeoutStarts, fsWriteStarts }).toEqual({
      workerStarts: 0,
      networkStarts: 0,
      intervalStarts: 0,
      timeoutStarts: 0,
      fsWriteStarts: 0,
    });
  }, 15_000);
});
