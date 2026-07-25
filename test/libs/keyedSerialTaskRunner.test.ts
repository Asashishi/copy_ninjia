import { describe, expect, test } from "bun:test";
import { createKeyedSerialTaskRunner } from "../../packages/libs/keyedSerialTaskRunner";
import { deferred } from "./helpers";

describe("createKeyedSerialTaskRunner", () => {
  test("同一个 key 严格按提交顺序执行，较早的慢任务不会晚于新任务落地", async () => {
    const first = deferred();
    const second = deferred();
    const started: number[] = [];
    const finished: number[] = [];
    const chains = new Map<string, Promise<void>>();
    const runner = createKeyedSerialTaskRunner(chains);

    runner.run("chat-1", async () => {
      started.push(1);
      await first.promise;
      finished.push(1);
    });
    runner.run("chat-1", async () => {
      started.push(2);
      await second.promise;
      finished.push(2);
    });
    await Promise.resolve();

    expect(started).toEqual([1]);
    first.resolve();
    await Bun.sleep(0);
    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([1]);

    second.resolve();
    await Bun.sleep(0);
    expect(finished).toEqual([1, 2]);
  });

  test("不同 key 各自独立，互不阻塞", async () => {
    const slow = deferred();
    const order: string[] = [];
    const chains = new Map<string, Promise<void>>();
    const runner = createKeyedSerialTaskRunner(chains);

    runner.run("chat-1", async () => {
      await slow.promise;
      order.push("chat-1");
    });
    runner.run("chat-2", async () => {
      order.push("chat-2");
    });
    await Bun.sleep(0);

    // chat-2 不必等 chat-1 的慢任务，先完成。
    expect(order).toEqual(["chat-2"]);
    slow.resolve();
    await Bun.sleep(0);
    expect(order).toEqual(["chat-2", "chat-1"]);
  });

  test("任务失败不中断该 key 后续任务（task 自身兜错，链靠 then(task, task) 推进）", async () => {
    const error = new Error("compaction failed");
    const completed: number[] = [];
    const chains = new Map<string, Promise<void>>();
    const runner = createKeyedSerialTaskRunner(chains);

    runner.run("chat-1", async () => {
      throw error;
    });
    runner.run("chat-1", async () => {
      completed.push(2);
    });
    await Bun.sleep(0);

    expect(completed).toEqual([2]);
  });

  test("链跑完后自动从 Map 里删除该 key，不留历史条目", async () => {
    const chains = new Map<string, Promise<void>>();
    const runner = createKeyedSerialTaskRunner(chains);

    runner.run("chat-1", async () => {});
    expect(chains.has("chat-1")).toBe(true);

    await Bun.sleep(0);
    expect(chains.has("chat-1")).toBe(false);
  });

  test("链跑完之前又有新任务顶上：清理只认自己那一代，不误删顶替者", async () => {
    const first = deferred();
    const chains = new Map<string, Promise<void>>();
    const runner = createKeyedSerialTaskRunner(chains);

    runner.run("chat-1", async () => {
      await first.promise;
    });
    const firstNext: Promise<void> = chains.get("chat-1")!;
    first.resolve();
    // 第一个任务的收尾清理与第二次 run 之间人为制造竞争：在第一个任务的
    // then 清理执行之前就提交第二个任务，验证清理不会把第二个任务的链
    // 顶替记录误删。
    runner.run("chat-1", async () => {});
    await Bun.sleep(0);

    expect(chains.get("chat-1")).not.toBe(firstNext);
  });
});
