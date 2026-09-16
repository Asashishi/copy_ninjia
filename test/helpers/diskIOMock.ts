import type * as diskIO from "../../packages/infra/diskIO";
import type { DomainFlushOutcome } from "../../packages/types/diskIO/replies";
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
    onAiMemoryDeletedPersisted: (): void => {},
    onAiMemoryPersisted: (): void => {},
    onDiskIOGiveUp: (): void => {},
    onDiskIORespawn: (): void => {},
    onIdentityStoragePersisted: (): void => {},
    onLuckAppendStalled: (): void => {},
    onVerificationPersisted: (): void => {},
    ...overrides,
  };
}
