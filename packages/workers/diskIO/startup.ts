/** Disk I/O Worker 启动恢复编排：全域只读 inspect、统一 adopt、成功后 maintenance。 */

import { aiMemoryCache } from "../../cache/workers/diskIO/snapshots";
import { stickerCatalogCache } from "../../cache/workers/diskIO/stickers";
import { resetWedFileWrites } from "../../cache/workers/diskIO/wed";
import { inspectWedMemberFiles, maintainWedMemberFiles } from "./wedMemberFiles";
import type { WedMemberInspection } from "./wedMemberFiles";
import { inspectLogFiles, adoptLogFiles, maintainLogFiles } from "./logFiles";
import {
  adoptAiMemorySnapshots,
  inspectAiMemorySnapshots,
  maintainAiMemorySnapshots,
} from "./aiMemoryFiles";
import {
  adoptStickerCatalogSnapshots,
  inspectStickerCatalogSnapshots,
  maintainStickerCatalogSnapshots,
} from "./stickerCatalogFiles";
import { inspectJoinLogFiles, maintainJoinLogFiles } from "./joinLogFiles";
import { adoptLuckDay, inspectLuckDayState, maintainLuckDayState } from "./luckFiles";
import { adoptLuckReceiptSecret, inspectLuckReceiptSecret } from "./luckSecretFile";
import {
  adoptVerificationDay,
  inspectVerificationDay,
  maintainVerificationDay,
} from "./verificationRecovery";
import {
  adoptStorageDatabase,
  inspectStorageDatabase,
  maintainTemporaryWhitelistActivities,
} from "./storageDatabase";
import { maintainAdSampleFiles } from "./adSampleFile";
import {
  registerDiskIOMaintenanceCron,
  stopDiskIOMaintenanceCron,
} from "./maintenanceCron";
import { getTokyoDateKey } from "../../libs/time";
import type { PendingBlockedRemoval } from "../../types/blocklist";
import type { ChatState } from "../../types/chatState";
import type { VerificationSnapshot } from "../../types/antiRaid/verification";
import type {
  IdentityStoragePersistedReply,
  LoadedReply,
  MidnightMaintenanceReply,
  VerificationPersistedReply,
} from "../../types/diskIO/replies";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";
import type { LogFilesInspection } from "./logFiles";
import type {
  AiMemoryRecoveryInspection,
  LuckDayRecoveryInspection,
  StickerCatalogRecoveryInspection,
} from "./snapshotFiles";
import type { LuckSecretRecoveryInspection } from "./luckSecretFile";
import type { JoinLogRecoveryInspection } from "./joinLogFiles";
import type { VerificationRecoveryInspection } from "./verificationRecovery";
import type { StorageDatabaseInspection } from "./storageDatabase/hydration";

export type DiskIOStartupReplySink = (
  reply: LoadedReply | VerificationPersistedReply | IdentityStoragePersistedReply | MidnightMaintenanceReply
) => void;

interface StartupMaintenanceInspections {
  readonly logs: LogFilesInspection;
  readonly aiMemories: AiMemoryRecoveryInspection;
  readonly stickerCatalogs: StickerCatalogRecoveryInspection;
  readonly joinLogs: JoinLogRecoveryInspection;
  readonly luck: LuckDayRecoveryInspection;
  readonly verifications: VerificationRecoveryInspection;
  readonly wedMembers: WedMemberInspection;
}

async function runMaintenance(
  inspections: StartupMaintenanceInspections,
  reply: DiskIOStartupReplySink
): Promise<void> {
  const tasks: readonly (readonly [string, () => void | Promise<void>])[] = [
    ["logs", (): Promise<void> => maintainLogFiles(inspections.logs)],
    ["AI memories", (): Promise<void> => maintainAiMemorySnapshots(inspections.aiMemories)],
    ["wed members", (): Promise<void> => maintainWedMemberFiles(inspections.wedMembers)],
    ["sticker catalogs", (): Promise<void> => maintainStickerCatalogSnapshots(inspections.stickerCatalogs)],
    ["join logs", (): Promise<void> => maintainJoinLogFiles(inspections.joinLogs)],
    ["luck", (): Promise<void> => maintainLuckDayState(inspections.luck.day, inspections.luck)],
    ["verifications", (): Promise<void> => maintainVerificationDay(inspections.verifications)],
    ["ad samples", (): Promise<void> => maintainAdSampleFiles()],
    ["temporary whitelist", (): void => maintainTemporaryWhitelistActivities(reply)],
  ];
  for (const [domain, maintain] of tasks) {
    try {
      await maintain();
    } catch (error: unknown) {
      console.error(`[diskIOWorker] startup maintenance failed for ${domain}:`, error);
    }
  }
}

/**
 * 所有持久化域先只读严格解码；任一失败都不 adopt、chmod、rewrite、unlink 或
 * 启动维护 cron。全部成功后统一发布 owner，发送成功回执，再执行可重试维护。
 */
export async function handleDiskIOStartupLoad(
  stickerPacks: readonly string[] | null,
  postReply: DiskIOStartupReplySink
): Promise<void> {
  stopDiskIOMaintenanceCron();
  let loadError: string | undefined;
  let verifications: Map<string, VerificationSnapshot> = new Map();
  let blocklistEntryCount: number = 0;
  let whitelistEntryCount: number = 0;
  let pendingBlockedRemovals: Map<number, PendingBlockedRemoval> = new Map();
  let chatStates: Map<number, ChatState> = new Map();
  let chatQa: Map<number, ReadonlyMap<string, string>> = new Map();
  let luckReceiptSecret: LuckReceiptSecret | null = null;
  let maintenanceInspections: StartupMaintenanceInspections | null = null;
  try {
    const today: string = getTokyoDateKey();
    const logs: LogFilesInspection = await inspectLogFiles();
    const aiMemories: AiMemoryRecoveryInspection = await inspectAiMemorySnapshots();
    const stickerCatalogs: StickerCatalogRecoveryInspection =
      await inspectStickerCatalogSnapshots(stickerPacks);
    const joinLogs: JoinLogRecoveryInspection = await inspectJoinLogFiles(today);
    const luck: LuckDayRecoveryInspection = await inspectLuckDayState(today);
    const luckSecret: LuckSecretRecoveryInspection = await inspectLuckReceiptSecret({
      day: today,
      confirmedResultCount: luck.cache?.entries.size ?? 0,
    });
    const verificationState: VerificationRecoveryInspection =
      await inspectVerificationDay(today);
    const storage: StorageDatabaseInspection = inspectStorageDatabase();
    const wedMembers: WedMemberInspection = await inspectWedMemberFiles();

    // 可写 SQLite 连接先接管；文件 adopt 才可能创建或规范化内容。
    const identityStorage: ReturnType<typeof adoptStorageDatabase> =
      adoptStorageDatabase(storage);
    adoptLogFiles(logs);
    resetWedFileWrites();
    adoptAiMemorySnapshots(aiMemories);
    adoptStickerCatalogSnapshots(stickerCatalogs);
    adoptLuckDay(luck);
    verifications = adoptVerificationDay(verificationState);
    luckReceiptSecret = adoptLuckReceiptSecret(luckSecret);
    blocklistEntryCount = identityStorage.blocklistEntryCount;
    whitelistEntryCount = identityStorage.whitelistEntryCount;
    pendingBlockedRemovals = identityStorage.pendingBlockedRemovals;
    chatStates = identityStorage.chatStates;
    chatQa = identityStorage.chatQa;
    maintenanceInspections = {
      logs,
      aiMemories,
      stickerCatalogs,
      joinLogs,
      luck,
      verifications: verificationState,
      wedMembers,
    };
  } catch (error: unknown) {
    loadError = error instanceof Error ? error.message : String(error);
    console.error("[diskIOWorker] startup recovery failed:", error);
  }

  postReply({
    type: "loaded",
    aiMemories: aiMemoryCache,
    stickerCatalogs: stickerCatalogCache,
    luckDay: maintenanceInspections?.luck.cache ?? null,
    luckReceiptSecret,
    verifications,
    pendingBlockedRemovals,
    blocklistEntryCount,
    whitelistEntryCount,
    chatStates,
    chatQa,
    wedMembers: maintenanceInspections?.wedMembers.snapshots ?? new Map(),
    error: loadError,
  });
  if (maintenanceInspections === null) return;
  await runMaintenance(maintenanceInspections, postReply);
  registerDiskIOMaintenanceCron(postReply);
}
