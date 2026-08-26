import { describe, expect, mock, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const projectRoot: string = join(import.meta.dir, "..");

function findRuntimeModules(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path: string = join(dir, entry.name);
    if (entry.isDirectory()) {
      // packages/types/ 只含被 TypeScript 擦除的 interface/type 声明，没有运行时代码。
      if (path === join(projectRoot, "packages", "types")) continue;
      result.push(...findRuntimeModules(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      result.push(path);
    }
  }
  return result;
}

const productionRuntimeModules: string[] = [
  join(projectRoot, "index.ts"),
  ...findRuntimeModules(join(projectRoot, "packages")),
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
    // 阶段写盘。只拦截写路径，合法读取（readFileSync/readdirSync 等）走真实实现。
    //
    // 使用带开关的透传包装：mock.module 注册会保留到同进程后续测试，finally
    // 关闭开关后包装只透传真实实现，不影响需要读写临时目录的用例。
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

    // 生产代码的落盘不止 node:fs：删除走 Bun 原生 BunFile.delete()（见
    // packages/libs/atomicFile.ts、infra/storage/{cleanup,dataRoot,instanceLock}.ts），
    // 只拦 node:fs 会给这条路留一个 import 期写盘的盲区。Bun.write 与 BunFile 的
    // write/writer 同理一并拦下。与 mock.module 不同，这两个是普通可写属性，
    // finally 里能原样还原，不会把 Proxy 留给后续用例。
    const realBunFile = Bun.file;
    const realBunWrite = Bun.write;
    function guardBunWrite(label: string): void {
      if (!fsGuardActive) return;
      fsWriteStarts++;
      throw new Error(`A production module called ${label} during import.`);
    }
    Bun.write = ((...args: any[]): any => {
      guardBunWrite("Bun.write");
      return (realBunWrite as (...passthroughArgs: any[]) => any)(...args);
    }) as typeof Bun.write;
    Bun.file = ((path: any, options?: any): any => {
      const file = realBunFile(path, options);
      // 文件描述符形态（Bun.stdout/stderr、内部 fs.WriteStream）是控制台输出，
      // 不是落盘：依赖内部的 debug / google-logging-utils 在 import 期就会为
      // TTY 探测建 WriteStream，把它算成写盘会让这道防线永远误报。
      if (typeof path === "number") return file;
      return new Proxy(file, {
        get(target: any, property: string | symbol): unknown {
          if (property === "delete" || property === "unlink" || property === "write" || property === "writer") {
            return (...args: unknown[]): unknown => {
              guardBunWrite(`BunFile.${String(property)}`);
              return target[property](...args);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof Bun.file;

    fsGuardActive = true;

    try {
      for (const path of productionRuntimeModules) {
        currentImportPath = path;
        await import(Bun.pathToFileURL(path).href);
      }
    } finally {
      globalThis.Worker = originalWorker;
      globalThis.fetch = originalFetch;
      globalThis.setInterval = originalSetInterval;
      globalThis.setTimeout = originalSetTimeout;
      Bun.file = realBunFile;
      Bun.write = realBunWrite;
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
