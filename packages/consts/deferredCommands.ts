/** 延迟命令同时在途的任务上限，属 commands/deferredCommands.ts；槽位覆盖目录枚举、读盘、下载与出站等待。 */
export const DEFERRED_COMMAND_MAX_CONCURRENT: number = 2;
/** 延迟命令尚未开始的任务上限（两档合计），属 commands/deferredCommands.ts；满额时直接回「稍后再试」，不排队。 */
export const DEFERRED_COMMAND_MAX_PENDING: number = 16;
/**
 * 后台档任务的等待上限，属 commands/deferredCommands.ts；必须不大于 DEFERRED_COMMAND_MAX_PENDING。
 * 批量收图这类耗时任务走后台档，最多占这么多等待位，其余等待位留给交互请求。
 */
export const DEFERRED_COMMAND_MAX_BACKGROUND_PENDING: number = 4;
