import { afterEach, describe, expect, test } from "bun:test";
import { createConfigChain } from "../../scripts/perf/fullSuite/configChains";
import type { ConfigChainDependencies } from "../../scripts/perf/fullSuite/configChains";
import { createCommandChain } from "../../scripts/perf/fullSuite/commandChains";
import type { CommandChainDependencies } from "../../scripts/perf/fullSuite/commandChains";
import { createStorageChain } from "../../scripts/perf/fullSuite/storageChains";
import type { StorageChainDependencies } from "../../scripts/perf/fullSuite/storageChains";
import { CHAIN_NAMES } from "../../scripts/perf/fullSuite/sections";
import type { ChainDefinition } from "../../scripts/perf/fullSuite/chainDefinition";
import { CRON_MAX_ACTIONS_PER_TASK, CRON_MAX_TASKS } from "../../packages/consts/cron";
import { CRON_CONFIG_PATH, RUNTIME_DATA_ROOT } from "../../packages/consts/paths";
import { applyHotDeploymentConfigs, readHotDeploymentConfigs } from "../../packages/config/reload";
import { getCronConfig } from "../../packages/config/cron";
import { quiesceCronScheduler, reconcileCronSchedule, startCronScheduler } from "../../packages/cron/scheduler";
import { cronRuntime } from "../../packages/cache/main/cron";
import type { CronRuntime, CronTask, CronTaskSchedule } from "../../packages/types/cron";
import type { HotDeploymentConfigChanges } from "../../packages/types/config";

/**
 * cron.json 中途变更链路（scripts/perf/fullSuite/configChains.ts）：满规格夹具必须过生产的
 * 严格解析，每次计时只重排被改动的那个任务；拒绝、未接管、重排范围不对或计时窗口内有
 * 任务执行都使基准失败，收尾撤回共用配置根里的 cron.json。
 */

/** 测试 preload 写入的缺省任务表；收尾删除后原样放回，其余用例照常读取。 */
const EMPTY_CRON_TABLE: string = "[]\n";

afterEach(async (): Promise<void> => {
  quiesceCronScheduler();
  await Bun.write(CRON_CONFIG_PATH, EMPTY_CRON_TABLE);
});

function productionDependencies(calls: ReadonlyMap<string, number>): ConfigChainDependencies {
  return {
    chainCronReloadOperations: 1,
    cronReloadWarmupOperations: 0,
    cronConfigPath: CRON_CONFIG_PATH,
    runtimeDataRoot: RUNTIME_DATA_ROOT,
    benchmarkChatId: (index: number): number => -1_000 - index,
    readHotDeploymentConfigs,
    applyHotDeploymentConfigs,
    startCronScheduler,
    reconcileCronSchedule,
    quiesceCronScheduler,
    cronRuntime,
    cannedTelegramCalls: calls,
  };
}

describe("cron.json 中途变更链路", () => {
  test("满规格夹具经生产入口严格解析并登记全部任务，每次改动只重排那一个任务", async () => {
    const definition: ChainDefinition = createConfigChain("cron-config-reload", productionDependencies(new Map()))!;
    await definition.prepare?.();
    const config: readonly Readonly<CronTask>[] = getCronConfig();
    expect(config).toHaveLength(CRON_MAX_TASKS);
    expect(config.every((task: Readonly<CronTask>): boolean => task.actions.length === CRON_MAX_ACTIONS_PER_TASK)).toBeTrue();
    const runtime: CronRuntime = cronRuntime.current!;
    const before: Map<string, CronTaskSchedule> = new Map<string, CronTaskSchedule>(runtime.schedules);

    await definition.run(0);

    const changed: string[] = [];
    for (const [name, schedule] of runtime.schedules) {
      if (before.get(name) !== schedule) changed.push(name);
    }
    expect(changed).toEqual([config[0]!.name]);
    expect(definition.excludedNanoseconds?.()).toBeGreaterThan(0);
    await definition.verify?.();

    await definition.cleanup?.();
    expect(await Bun.file(CRON_CONFIG_PATH).exists()).toBeFalse();
    expect(cronRuntime.current?.accepting).toBeFalse();
  });

  test("计时窗口内有出站请求说明任务执行了，基准失败", async () => {
    const calls: Map<string, number> = new Map<string, number>([["sendMessage", 1]]);
    const definition: ChainDefinition = createConfigChain("cron-config-reload", productionDependencies(calls))!;
    expect(() => definition.verify?.()).toThrow("sent 1 Telegram request(s)");
  });

  function fakeDependencies(overrides: Partial<ConfigChainDependencies>): ConfigChainDependencies {
    const schedules: Map<string, CronTaskSchedule> = new Map<string, CronTaskSchedule>();
    const runtime: { current: CronRuntime | null } = { current: null };
    const newSchedule = (): CronTaskSchedule => ({ task: {} as CronTask, job: null, cancelled: false });
    return {
      ...productionDependencies(new Map()),
      readHotDeploymentConfigs: async () => ({}) as never,
      applyHotDeploymentConfigs: (): HotDeploymentConfigChanges => ({ cron: true, rejections: [] }) as unknown as HotDeploymentConfigChanges,
      startCronScheduler: (): void => {
        for (let index: number = 0; index < CRON_MAX_TASKS; index += 1) schedules.set(`benchmark-task-${index}`, newSchedule());
        runtime.current = { schedules } as unknown as CronRuntime;
      },
      reconcileCronSchedule: (): void => {
        schedules.set("benchmark-task-0", newSchedule());
      },
      quiesceCronScheduler: (): void => {},
      cronRuntime: runtime,
      ...overrides,
    };
  }

  test("热重载拒绝、未接管新任务表、没重排改动的任务或重排了没改的任务都使基准失败", async () => {
    const rejected: ChainDefinition = createConfigChain("cron-config-reload", fakeDependencies({
      applyHotDeploymentConfigs: (): HotDeploymentConfigChanges =>
        ({ cron: false, rejections: ["cron.json: invalid"] }) as unknown as HotDeploymentConfigChanges,
    }))!;
    await expect(rejected.prepare?.()).rejects.toThrow("Initial cron reload rejected a deployment config: cron.json: invalid");

    let adopted: boolean = true;
    const unadopted: ChainDefinition = createConfigChain("cron-config-reload", fakeDependencies({
      applyHotDeploymentConfigs: (): HotDeploymentConfigChanges =>
        ({ cron: adopted, rejections: [] }) as unknown as HotDeploymentConfigChanges,
    }))!;
    await unadopted.prepare?.();
    adopted = false;
    await expect(unadopted.run(0)).rejects.toThrow("Cron reload 0 did not adopt the changed cron task table.");

    const unscheduled: ChainDefinition = createConfigChain("cron-config-reload", fakeDependencies({
      reconcileCronSchedule: (): void => {},
    }))!;
    await unscheduled.prepare?.();
    await expect(unscheduled.run(0)).rejects.toThrow("did not reschedule the changed task");

    const dependencies: ConfigChainDependencies = fakeDependencies({});
    const overscheduled: ChainDefinition = createConfigChain("cron-config-reload", {
      ...dependencies,
      reconcileCronSchedule: (): void => {
        const schedules: Map<string, CronTaskSchedule> = dependencies.cronRuntime.current!.schedules;
        for (const name of [...schedules.keys()]) {
          schedules.set(name, { task: {} as CronTask, job: null, cancelled: false });
        }
      },
    })!;
    await overscheduled.prepare?.();
    await expect(overscheduled.run(0)).rejects.toThrow("rescheduled tasks that did not change");
  });

  test("链路登记进出数顺序，只由配置链路工厂构造", () => {
    expect(CHAIN_NAMES).toContain("cron-config-reload");
    expect(createStorageChain("cron-config-reload", {} as StorageChainDependencies)).toBeUndefined();
    expect(createCommandChain("cron-config-reload", {} as CommandChainDependencies)).toBeUndefined();
    expect(createConfigChain("cron-send-voice", productionDependencies(new Map()))).toBeUndefined();
  });
});
