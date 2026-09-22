import type { FSWatcher } from "node:fs";
import type { LatestValueRunner } from "../../libs/latestValueRunner";

/**
 * owner：主线程。config/ 热重载（app/configReload.ts）的运行时状态。
 *
 * startConfigReload 填充 watcher 与执行器并开始接纳事件；每个文件事件整体替换
 * 一次防抖 timer，到期即清空；quiesceConfigReload 停止接纳、关闭 watcher 并清除
 * timer。执行器跨启停保留，同一时刻至多一轮在途读取加一轮待补跑。容量恒为一个
 * watcher、一个 timer 与一个执行器，不随事件数增长；主线程不随 Worker 重建，
 * 进程重启后从初始值开始。
 */
export const configReloadRuntime: {
  watcher: FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  accepting: boolean;
  runner: LatestValueRunner<null> | null;
} = {
  watcher: null,
  debounceTimer: null,
  accepting: false,
  runner: null,
};
