import { describe, expect, test } from "bun:test";
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
    let workerStarts: number = 0;
    let networkStarts: number = 0;
    let intervalStarts: number = 0;

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

    try {
      for (const path of productionRuntimeModules) {
        await import(pathToFileURL(path).href);
      }
    } finally {
      globalThis.Worker = originalWorker;
      globalThis.fetch = originalFetch;
      globalThis.setInterval = originalSetInterval;
    }

    expect(productionRuntimeModules.length).toBeGreaterThan(100);
    expect({ workerStarts, networkStarts, intervalStarts }).toEqual({
      workerStarts: 0,
      networkStarts: 0,
      intervalStarts: 0,
    });
  }, 15_000);
});
