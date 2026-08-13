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

  test("取消后台等待任务会释放总等待位和后台等待位", async () => {
    const runner = createPrioritizedBoundedTaskRunner({
      maxConcurrent: 1,
      maxPending: 2,
      maxBackgroundPending: 1,
      interactiveBurst: 2,
    });
    const gate = deferred();
    const controller: AbortController = new AbortController();
    let queuedStarted: boolean = false;
    const active: Promise<string | undefined> = runner.run("interactive", async (): Promise<string> => {
      await gate.promise;
      return "active";
    });
    const queued: Promise<string | undefined> = runner.run(
      "background",
      async (): Promise<string> => {
        queuedStarted = true;
        return "queued";
      },
      controller.signal
    );

    await Promise.resolve();
    expect(runner.pendingCount).toBe(1);
    expect(runner.backgroundPendingCount).toBe(1);
    controller.abort();
    expect(await queued).toBeUndefined();
    expect(runner.pendingCount).toBe(0);
    expect(runner.backgroundPendingCount).toBe(0);

    gate.resolve();
    expect(await active).toBe("active");
    expect(queuedStarted).toBeFalse();
  });

  test("占到执行位后、真正调用前被取消的任务不再执行", async () => {
    // start() 先占执行位，任务本体要到下一个微任务才调用；这一拍里取消的话，
    // 两条等待队列都不参与，只有 start() 里的复查挡得住。
    const runner = createPrioritizedBoundedTaskRunner({
      maxConcurrent: 1,
      maxPending: 0,
      maxBackgroundPending: 0,
      interactiveBurst: 1,
    });
    const controller: AbortController = new AbortController();
    let started: boolean = false;
    const task: Promise<string | undefined> = runner.run(
      "interactive",
      async (): Promise<string> => {
        started = true;
        return "ran";
      },
      controller.signal
    );

    expect(runner.activeCount).toBe(1);
    controller.abort();
    expect(await task).toBeUndefined();
    expect(started).toBeFalse();
    expect(runner.activeCount).toBe(0);
  });
});
