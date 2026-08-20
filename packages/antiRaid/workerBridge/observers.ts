import { chatIsSupergroupById } from "../../cache/main/antiRaid/chatKind";
import {
  activeVerificationSnapshots,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
} from "../../cache/main/antiRaid/verificationMirror";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import {
  registerBotPermissionObserver,
} from "../../infra/botAdmin";
import { registerChatTeardown } from "../../infra/chatTeardown";
import { projectBotActionPermissions } from "../../libs/chatMember";
import {
  onDiskIORespawn,
  onVerificationPersisted,
} from "../../infra/diskIO";
import { logger } from "../../infra/logger";
import type { AntiRaidWorkerMessage } from
  "../../types/antiRaid/protocol";
import type { VerificationSnapshot } from
  "../../types/antiRaid/verification";
import type { ChatTeardownReason } from "../../types/chatTeardown";
import type {
  DiskIORecoveryTransport,
  VerificationPersistedReply,
} from "../../types/diskIO";
import type {
  BotActionPermissions,
  BotChatPermissions,
} from "../../types/telegram";
import { settlePersistedVerificationDeferral } from "../verificationAttempts";

/** Anti-Raid 主线程观察者注册所需的代理能力。 */
export interface RegisterAntiRaidBridgeObserversOptions {
  readonly post: (message: AntiRaidWorkerMessage) => boolean;
  readonly deactivateChat: (
    chatId: number,
    cleanupVerificationMessages: boolean
  ) => void;
}

/**
 * 注册权限、群 teardown 与 Disk I/O 回执观察者。
 *
 * 调用一次后由各上游长期持有回调；Worker 重建只替换 post 背后的当前代际，
 * 不重复注册观察者。
 */
export function registerAntiRaidBridgeObservers({
  post,
  deactivateChat,
}: RegisterAntiRaidBridgeObserversOptions): void {
  registerBotPermissionObserver((
    chatId: number,
    permissions: BotChatPermissions | undefined
  ): void => {
    const workerPermissions: BotActionPermissions | undefined =
      permissions === undefined ? undefined : projectBotActionPermissions(permissions);
    post({
      type: "botPermissionsChanged",
      chatId,
      ...(workerPermissions !== undefined
        ? { permissions: workerPermissions }
        : {}),
    });
  });

  registerChatTeardown("antiRaid", (
    chatId: number,
    reason: ChatTeardownReason
  ): void => {
    deactivateChat(chatId, reason === "explicitDisable");
    chatIsSupergroupById.delete(chatId);
  });

  onDiskIORespawn(
    "Anti-Raid verification",
    DISK_IO_RESPAWN_PRIORITIES.ANTI_RAID_VERIFICATION,
    (transport: DiskIORecoveryTransport): boolean => {
      for (const record of activeVerificationSnapshots.values()) {
        if (!transport.post({
          type: "verificationUpsert",
          record,
          critical: true,
        })) return false;
      }
      for (const deletion of pendingVerificationDeletes.values()) {
        if (!transport.post({ type: "verificationDelete", ...deletion })) {
          return false;
        }
      }
      return true;
    }
  );

  onVerificationPersisted((reply: VerificationPersistedReply): void => {
    if (!reply.deleted) {
      const current: VerificationSnapshot | undefined =
        activeVerificationSnapshots.get(reply.key);
      if (
        current?.generation !== reply.generation ||
        current.revision !== reply.revision
      ) return;
      persistedVerificationRevisions.set(reply.key, {
        generation: reply.generation,
        revision: reply.revision,
      });
      if (settlePersistedVerificationDeferral(
        reply.key,
        reply.generation,
        reply.revision
      )) return;
      if (!post({
        type: "verificationPersisted",
        key: reply.key,
        generation: reply.generation,
        revision: reply.revision,
      })) {
        logger.error(
          `Anti-Raid Worker rejected the persisted verification receipt for ${reply.key}; ` +
          "relying on respawn replay to redeliver it."
        );
      }
      return;
    }
    const deletion: {
      chatId: number;
      userId: number;
      generation: number;
      revision: number;
    } | undefined = pendingVerificationDeletes.get(reply.key);
    if (
      deletion?.generation === reply.generation &&
      deletion.revision === reply.revision
    ) {
      pendingVerificationDeletes.delete(reply.key);
    }
  });
}
