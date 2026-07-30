import type { WhitelistConfig } from "../../types/whitelist";

/**
 * 主线程白名单配置缓存。首次启动预检时从 config/whitelist.json 填充；
 * /permission 或 /white 成功原子落盘后整体替换。白名单判定只在主线程
 * 进行，Worker 所需结论随既有业务消息携带；进程重启后重新从配置文件建立。
 */
export const whitelistConfigCache: { current: WhitelistConfig | null } = {
  current: null,
};

/**
 * 主线程白名单写入串行链。/permission 与 /white 可在不同群并发抵达，必须把
 * 「取当前快照 -> 改一项 -> 原子写入 -> 发布新快照」整体排队，避免较早的
 * 写入较晚落盘、反向覆盖后一次授权。失败只拒绝本次更新，链本身继续可用。
 */
export const whitelistMutationQueue: { current: Promise<void> } = {
  current: Promise.resolve(),
};
