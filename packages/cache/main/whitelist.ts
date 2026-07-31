import type { WhitelistConfig } from "../../types/whitelist";

/** 白名单文件最近一次由本进程读取或写入后的内容指纹。 */
export interface WhitelistFileRevision {
  readonly path: string;
  readonly sha256: string;
}

/**
 * 主线程白名单配置缓存。首次启动预检时从 config/whitelist.json 填充；
 * /permission 或 /white 成功原子落盘后整体替换。白名单判定只在主线程
 * 进行，Worker 所需结论随既有业务消息携带；进程重启后重新从配置文件建立。
 */
export const whitelistConfigCache: { current: WhitelistConfig | null } = {
  current: null,
};

/**
 * 主线程白名单文件指纹。启动读取时填充，命令成功写入后更新；命令落盘前
 * 用它发现进程外编辑并拒绝整份覆盖。进程重启后从部署文件重新建立。
 */
export const whitelistFileRevisionCache: {
  current: WhitelistFileRevision | null;
} = {
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
