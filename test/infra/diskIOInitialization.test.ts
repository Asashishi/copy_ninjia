import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const projectRoot: string = join(import.meta.dir, "..", "..");

describe("explicit Worker initialization", () => {
  test("imports are side-effect free and repeated init calls are idempotent", () => {
    const script: string = `
      let constructed = 0;
      class FakeWorker {
        onmessage = null;
        onerror = null;
        constructor(_url) { constructed++; }
        unref() {}
        postMessage(_message) {}
      }
      globalThis.Worker = FakeWorker;

      const diskIO = await import("./src/infra/diskIO.ts");
      const workers = await import("./src/libs/supervisedWorker.ts");
      const beforeInit = constructed;

      diskIO.initDiskIO();
      const afterDiskInit = constructed;
      diskIO.initDiskIO();
      const afterSecondDiskInit = constructed;

      const handle = workers.superviseWorker({
        url: "fake-worker.ts",
        label: "fake",
        giveUpConsequence: "none",
      });
      const afterHandleCreation = constructed;
      handle.init();
      const afterHandleInit = constructed;
      handle.init();

      process.stdout.write(JSON.stringify({
        beforeInit,
        afterDiskInit,
        afterSecondDiskInit,
        afterHandleCreation,
        afterHandleInit,
        afterSecondHandleInit: constructed,
      }));
    `;
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      cwd: projectRoot,
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
      beforeInit: 0,
      afterDiskInit: 1,
      afterSecondDiskInit: 1,
      afterHandleCreation: 1,
      afterHandleInit: 2,
      afterSecondHandleInit: 2,
    });
  });
});
