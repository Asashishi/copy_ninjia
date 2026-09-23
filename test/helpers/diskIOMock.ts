import type * as diskIO from "../../packages/infra/diskIO";
import type { DiskIOReplyListenerMap, DomainFlushOutcome } from "../../packages/types/diskIO/replies";
import type { FlushResult } from "../../packages/types/lifecycle";

/** 未提供读取夹具时拒绝调用，不把缺失数据伪装成空结果。 */
async function unavailableRead(): Promise<never> {
  throw new Error("Disk I/O read fixture is not configured.");
}

/**
 * 完整 Disk I/O 模块替身；默认未初始化、拒收写入且 flush 失败。
 * 观察者默认不保留回调，生命周期测试须显式捕获并驱动它们；不会加载生产模块或创建 Worker。
 */
export function diskIOStub(overrides: Partial<typeof diskIO> = {}): typeof diskIO {
  return {
    initDiskIO: (): never => { throw new Error("Disk I/O initialization fixture is not configured."); },
    isDiskIOInitialized: (): boolean => false,
    isDiskIOBuffering: (): boolean => false,
    postDiskIO: (): boolean => false,
    postDiskIODiagnostic: (): boolean => false,
    relayLogMessage: (): boolean => false,
    loadPersistedData: unavailableRead,
    ensureLuckReceiptSecret: unavailableRead,
    readJoinLog: unavailableRead,
    readIdentityPolicies: unavailableRead,
    readBlocklistIdPage: unavailableRead,
    flushDiskIO: async (): Promise<FlushResult> => "failed",
    flushDiskIODomain: async (): Promise<FlushResult> => "failed",
    flushDiskIODomainOutcome: async (): Promise<DomainFlushOutcome> => ({ result: "failed" }),
    terminateDiskIO: async (): Promise<void> => {},
    onDiskIOGiveUp: (): void => {},
    onDiskIOReply: (): void => {},
    onDiskIORespawn: (): void => {},
    ...overrides,
  };
}

/** 各类可订阅回执的登记捕获；未列出的回执类型登记即丢弃。 */
export type DiskIOReplyCaptures = {
  readonly [K in keyof DiskIOReplyListenerMap]?: (listener: (reply: DiskIOReplyListenerMap[K]) => void) => void;
};

/**
 * `onDiskIOReply` 替身：按回执类型把登记交给对应的捕获函数，测试据此持有并驱动
 * 生产 owner 登记的回调。
 */
export function diskIOReplyStub(captures: DiskIOReplyCaptures): typeof diskIO.onDiskIOReply {
  return <K extends keyof DiskIOReplyListenerMap>(
    type: K,
    listener: (reply: DiskIOReplyListenerMap[K]) => void
  ): void => {
    const capture = captures[type] as ((captured: (reply: DiskIOReplyListenerMap[K]) => void) => void) | undefined;
    capture?.(listener);
  };
}
