/** `/bot_status` 展示的当前 Bot 进程本机资源快照。 */
export interface BotProcessStatus {
  /** 自进程启动以来经过的秒数。 */
  readonly uptimeSeconds: number;
  /** 进程累计 CPU 时间折算到可用逻辑核后的运行期平均占用率。 */
  readonly averageCpuPercent: number;
  /** OS 报告给进程的可用逻辑核数。 */
  readonly availableCpuCount: number;
  /** 当前进程常驻内存字节数。 */
  readonly rssBytes: number;
  /** 容器/OS 约束下的内存上限；取不到约束时为物理内存。 */
  readonly memoryLimitBytes: number;
  /** RSS 占上述内存上限的比例。 */
  readonly memoryPercent: number;
}
