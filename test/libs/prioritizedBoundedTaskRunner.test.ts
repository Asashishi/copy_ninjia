import { describe, expect, test } from "bun:test";
import { createPrioritizedBoundedTaskRunner } from "../../packages/libs/prioritizedBoundedTaskRunner";
import { deferred } from "./helpers";
import { settleTestBatch } from "./helpers";

describe("createPrioritizedBoundedTaskRunner", () => {
  test("交互任务优先且后台突发受独立等待上限约束", async () => {
    const runner = createPrioritizedBoundedTaskRunner({
      maxConcurrent: 1,
      maxPending: 4,
      maxBackgroundPending: 1,
      interactiveBurst: 2,
    });
    const gate = deferred();
    const started: string[] = [];
    const first: Promise<string | undefined> = runner.run("interactive", async (): Promise<string> => {
      started.push("active");
      await gate.promise;
      return "active";
    });
    const background: Promise<string | undefined> = runner.run("background", async (): Promise<string> => {
      started.push("background");
      return "background";
    });
    const rejectedBackground: Promise<string | undefined> = runner.run("background", async (): Promise<string> => {
      started.push("rejected");
      return "rejected";
    });
    const interactive: Promise<string | undefined> = runner.run("interactive", async (): Promise<string> => {
      started.push("interactive");
      return "interactive";
    });

    await Promise.resolve();
    expect(runner.activeCount).toBe(1);
    expect(runner.pendingCount).toBe(2);
    expect(runner.backgroundPendingCount).toBe(1);
    expect(await rejectedBackground).toBeUndefined();

    gate.resolve();
    expect(await first).toBe("active");
    expect(await interactive).toBe("interactive");
    expect(await background).toBe("background");
    expect(started).toEqual(["active", "interactive", "background"]);
  });

  test("连续交互达到突发额度后给后台任务一次执行机会", async () => {
    const runner = createPrioritizedBoundedTaskRunner({
      maxConcurrent: 1,
      maxPending: 5,
      maxBackgroundPending: 2,
      interactiveBurst: 2,
    });
    const gate = deferred();
    const started: string[] = [];
    const active: Promise<string | undefined> = runner.run("interactive", async (): Promise<string> => {
      started.push("active");
      await gate.promise;
      return "active";
    });
    const background: Promise<string | undefined> = runner.run("background", async (): Promise<string> => {
      started.push("background");
      return "background";
    });
    const first: Promise<string | undefined> = runner.run("interactive", async (): Promise<string> => {
      started.push("i1");
      return "i1";
    });
    const second: Promise<string | undefined> = runner.run("interactive", async (): Promise<string> => {
      started.push("i2");
      return "i2";
    });
    const third: Promise<string | undefined> = runner.run("interactive", async (): Promise<string> => {
      started.push("i3");
      return "i3";
    });

    gate.resolve();
    await settleTestBatch([active, background, first, second, third]);
    expect(started).toEqual(["active", "i1", "i2", "background", "i3"]);
  });
});
