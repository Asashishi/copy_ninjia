/**
 * 部署配置热重载链路：cron.json 中途变更后，主线程吸收这次变更的本地成本。
 *
 * 夹具是满规格任务表：CRON_MAX_TASKS 个任务，每个 CRON_MAX_ACTIONS_PER_TASK 个动作，按
 * 文字、CRON_MAX_IMAGES 张本地图片、随机目录、本地文件各种写法轮换；本地来源一律写成相对
 * 运行时数据根的路径，与部署方的写法一致。`FIXTURE_CRON_EXPRESSION` 在计时窗口内不会
 * 触发任务。每次计时先改写一个任务（改写与写盘属于部署方，按 excludedNanoseconds
 * 扣除），再按生产热重载的顺序读取并严格解析可热重载的各配置文件、替换 holder、按任务名
 * 对账调度器；广告检测与 AI 闲聊的可用性重算（只改 cron.json 时不产生分发）与热重载日志
 * 不在这条链路里。
 *
 * 本文件不加载生产模块图（见 scripts/conventions/moduleBoundaries.ts 的全量基准 import
 * 边界）：生产入口由 chain.ts 在子进程里装配后注入，这里只 import 纯常量与类型。
 */

import { join } from "node:path";
import {
  CRON_MAX_ACTIONS_PER_TASK,
  CRON_MAX_IMAGES,
  CRON_MAX_TASKS,
} from "../../../packages/consts/cron";
import type {
  applyHotDeploymentConfigs,
  readHotDeploymentConfigs,
} from "../../../packages/config/reload";
import type {
  quiesceCronScheduler,
  reconcileCronSchedule,
  startCronScheduler,
} from "../../../packages/cron/scheduler";
import type { cronRuntime } from "../../../packages/cache/main/cron";
import type { CronRuntime, CronTaskSchedule } from "../../../packages/types/cron";
import type {
  HotDeploymentConfigChanges,
  HotDeploymentConfigReads,
} from "../../../packages/types/config";
import type { BunFile } from "bun";
import type { ChainDefinition } from "./chainDefinition";
import type { ChainName } from "./types";

/** 配置链路由 chain.ts 注入的生产入口与夹具参数。 */
export interface ConfigChainDependencies {
  readonly chainCronReloadOperations: number;
  readonly cronReloadWarmupOperations: number;
  /** 生产读取的 cron.json 路径（基准配置根内）。 */
  readonly cronConfigPath: string;
  /** 本轮独占的运行时数据根；夹具本地来源写在它下面。 */
  readonly runtimeDataRoot: string;
  readonly benchmarkChatId: (index: number) => number;
  readonly readHotDeploymentConfigs: typeof readHotDeploymentConfigs;
  readonly applyHotDeploymentConfigs: typeof applyHotDeploymentConfigs;
  readonly startCronScheduler: typeof startCronScheduler;
  readonly reconcileCronSchedule: typeof reconcileCronSchedule;
  readonly quiesceCronScheduler: typeof quiesceCronScheduler;
  readonly cronRuntime: typeof cronRuntime;
  readonly cannedTelegramCalls: ReadonlyMap<string, number>;
}

/** 夹具本地来源所在的目录，相对运行时数据根。 */
const FIXTURE_DIRECTORY: string = "cron-reload";

/** 只在 2 月 29 日 0 点触发的表达式：Bun.cron.parse 认可、计时窗口内不会执行。 */
const FIXTURE_CRON_EXPRESSION: string = "0 0 29 2 *";

/** 夹具任务名；按下标唯一。 */
function taskName(index: number): string {
  return `benchmark-task-${index}`;
}

/** 夹具里全部固定图片的相对路径。 */
function fixtureImagePaths(): readonly string[] {
  const paths: string[] = [];
  for (let index: number = 0; index < CRON_MAX_IMAGES; index += 1) {
    paths.push(join(FIXTURE_DIRECTORY, `image-${index}.png`));
  }
  return paths;
}

/** 一个动作的原始 JSON 写法；按动作下标在各来源写法之间轮换。 */
function rawAction(
  taskIndex: number,
  actionIndex: number,
  revision: number
): Readonly<Record<string, unknown>> {
  switch (actionIndex % 4) {
    case 0:
      return {
        type: "send_message",
        payload: { content: `基准任务 ${taskIndex} 动作 ${actionIndex}，第 ${revision} 版` },
      };
    case 1:
      return {
        type: "send_image",
        payload: { content: `相册 ${actionIndex}`, path: fixtureImagePaths() },
      };
    case 2:
      return {
        type: "send_image",
        payload: { rand_image: true, path: join(FIXTURE_DIRECTORY, "gallery"), is_blurred: true },
      };
    default:
      return {
        type: "send_file",
        payload: { content: `周报 ${actionIndex}`, path: join(FIXTURE_DIRECTORY, "report.pdf") },
      };
  }
}

/** 一个任务的原始 JSON 写法；revision 只改变第一条文字动作的内容。 */
function rawTask(
  index: number,
  revision: number,
  chatId: number
): Readonly<Record<string, unknown>> {
  const actions: Readonly<Record<string, unknown>>[] = [];
  for (let actionIndex: number = 0; actionIndex < CRON_MAX_ACTIONS_PER_TASK; actionIndex += 1) {
    actions.push(rawAction(index, actionIndex, revision));
  }
  return { name: taskName(index), chat_id: [chatId], cron: FIXTURE_CRON_EXPRESSION, actions };
}

/** 读取并应用一轮热重载；任何拒绝或 cron 未被接管都使基准失败。 */
async function reloadCronConfig(
  dependencies: ConfigChainDependencies,
  label: string
): Promise<void> {
  const reads: HotDeploymentConfigReads = await dependencies.readHotDeploymentConfigs();
  const changes: HotDeploymentConfigChanges = dependencies.applyHotDeploymentConfigs(reads);
  if (changes.rejections.length > 0) {
    throw new Error(`${label} rejected a deployment config: ${changes.rejections.join("; ")}`);
  }
  if (!changes.cron) throw new Error(`${label} did not adopt the changed cron task table.`);
}

/** 当前调度器；未启动时基准失败。 */
function requireRuntime(dependencies: ConfigChainDependencies): CronRuntime {
  const runtime: CronRuntime | null = dependencies.cronRuntime.current;
  if (runtime === null) throw new Error("Benchmark cron scheduler is not running.");
  return runtime;
}

/** 本进程罐头 Telegram 收到的请求总数。 */
function totalTelegramCalls(calls: ReadonlyMap<string, number>): number {
  let total: number = 0;
  for (const count of calls.values()) total += count;
  return total;
}

/**
 * cron.json 中途变更：改写满规格任务表中的一个任务后跑一轮生产热重载，终点是调度器
 * 只替换了这一个任务的调度。
 */
function cronConfigReloadChain(dependencies: ConfigChainDependencies): ChainDefinition {
  const chatId: number = dependencies.benchmarkChatId(0);
  const tasks: Readonly<Record<string, unknown>>[] = [];
  const excludedNs: { current: number } = { current: 0 };
  return {
    chain: "cron-config-reload",
    operations: dependencies.chainCronReloadOperations,
    recordsPerOperation: 1,
    warmupOperations: dependencies.cronReloadWarmupOperations,
    prepare: async (): Promise<void> => {
      const fixtureRoot: string = join(dependencies.runtimeDataRoot, FIXTURE_DIRECTORY);
      for (let index: number = 0; index < CRON_MAX_IMAGES; index += 1) {
        await Bun.write(join(fixtureRoot, `image-${index}.png`), "png");
      }
      await Bun.write(join(fixtureRoot, "gallery", "image.png"), "png");
      await Bun.write(join(fixtureRoot, "report.pdf"), "pdf");
      tasks.length = 0;
      for (let index: number = 0; index < CRON_MAX_TASKS; index += 1) tasks.push(rawTask(index, 0, chatId));
      await Bun.write(dependencies.cronConfigPath, JSON.stringify(tasks));
      await reloadCronConfig(dependencies, "Initial cron reload");
      dependencies.startCronScheduler();
      if (requireRuntime(dependencies).schedules.size !== CRON_MAX_TASKS) {
        throw new Error(`Benchmark cron scheduler did not register ${CRON_MAX_TASKS} tasks.`);
      }
    },
    run: async (sequence: number): Promise<void> => {
      const index: number = sequence % CRON_MAX_TASKS;
      const writeStartedAtNs: number = Bun.nanoseconds();
      tasks[index] = rawTask(index, sequence + 1, chatId);
      await Bun.write(dependencies.cronConfigPath, JSON.stringify(tasks));
      excludedNs.current = Bun.nanoseconds() - writeStartedAtNs;
      const runtime: CronRuntime = requireRuntime(dependencies);
      const changedName: string = taskName(index);
      const untouchedName: string = taskName((index + 1) % CRON_MAX_TASKS);
      const previous: CronTaskSchedule | undefined = runtime.schedules.get(changedName);
      const untouched: CronTaskSchedule | undefined = runtime.schedules.get(untouchedName);
      await reloadCronConfig(dependencies, `Cron reload ${sequence}`);
      dependencies.reconcileCronSchedule();
      const next: CronTaskSchedule | undefined = runtime.schedules.get(changedName);
      if (next === undefined || next === previous) {
        throw new Error(`Cron reload ${sequence} did not reschedule the changed task.`);
      }
      if (runtime.schedules.get(untouchedName) !== untouched || runtime.schedules.size !== CRON_MAX_TASKS) {
        throw new Error(`Cron reload ${sequence} rescheduled tasks that did not change.`);
      }
    },
    excludedNanoseconds: (): number => excludedNs.current,
    verify: (): void => {
      // 计时窗口内任务不触发；出现任何罐头 Telegram 请求即抛错。
      const calls: number = totalTelegramCalls(dependencies.cannedTelegramCalls);
      if (calls > 0) throw new Error(`Cron reload benchmark sent ${calls} Telegram request(s).`);
    },
    cleanup: async (): Promise<void> => {
      dependencies.quiesceCronScheduler();
      // 配置根在各子进程间共用，其余基准里定时任务保持缺省（见 mockRoot.ts）；
      // 只删存在的文件，prepare 在写出前失败时 cleanup 不抛错。
      const cronConfig: BunFile = Bun.file(dependencies.cronConfigPath);
      if (await cronConfig.exists()) await cronConfig.delete();
    },
  };
}

/** 返回配置链路定义；其余链路交给 storageChains 与 commandChains。 */
export function createConfigChain(
  chain: ChainName,
  dependencies: ConfigChainDependencies
): ChainDefinition | undefined {
  switch (chain) {
    case "cron-config-reload": return cronConfigReloadChain(dependencies);
    case "join-log-append":
    case "identity-policy-write":
    case "temporary-whitelist-write":
    case "chat-state-write":
    case "chat-qa-write":
    case "ai-memory-snapshot":
    case "diagnostic-log":
    case "ad-detect-command":
    case "ai-reply-command":
    case "cron-send-voice": return undefined;
  }
}
