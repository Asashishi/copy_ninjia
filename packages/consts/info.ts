/**
 * 一次 `/info` 的总预算，属 commands/info.ts；成员与会话资料、头像读取（含 t.me 兜底与频道
 * 头像下载）都算在里面，超出后按已拿到的资料回复，头像拿不到就注明没有。
 */
export const INFO_TASK_BUDGET_MS: number = 30_000;
