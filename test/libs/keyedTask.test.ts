import { expect, test } from "bun:test";
import { getOrCreateKeyedTask } from "../../packages/libs/keyedTask";

test("同键在途时复用同一个 Promise，结算后释放槽位", async () => {
  const tasks: Map<number, Promise<string>> = new Map<number, Promise<string>>();
  let created: number = 0;
  const release: PromiseWithResolvers<string> = Promise.withResolvers<string>();
  const create = (): Promise<string> => {
    created++;
    return release.promise;
  };
  const first: Promise<string> = getOrCreateKeyedTask(tasks, 1, create);
  expect(getOrCreateKeyedTask(tasks, 1, create)).toBe(first);
  expect(created).toBe(1);
  release.resolve("done");
  expect(await first).toBe("done");
  expect(tasks.has(1)).toBeFalse();
});

test("整表清空后陈旧任务结算不删除同键新登记的槽位", async () => {
  const tasks: Map<number, Promise<void>> = new Map<number, Promise<void>>();
  const stale: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  const staleTask: Promise<void> = getOrCreateKeyedTask(tasks, 1, (): Promise<void> => stale.promise);
  tasks.clear();
  const fresh: Promise<void> = getOrCreateKeyedTask(tasks, 1, (): Promise<void> => new Promise<void>((): void => {}));
  stale.resolve();
  await staleTask;
  expect(tasks.get(1)).toBe(fresh);
});
