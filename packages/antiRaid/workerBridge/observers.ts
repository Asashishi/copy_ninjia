import { chatIsSupergroupById } from "../../cache/main/antiRaid/chatKind";
import {
  activeVerificationSnapshots,
  pendingVerificationDeletes,
} from "../../cache/main/antiRaid/verificationMirror";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import {
  registerBotPermissionObserver,
} from "../../infra/botAdmin";
import { registerChatTeardown } from "../../infra/chatTeardownRegistry";
import { projectBotActionPermissions } from "../../libs/chatMember";
import {
  onDiskIORespawn,
  onDiskIOReply,
} from "../../infra/diskIO";
import { logger } from "../../infra/logger";
import type { AntiRaidWorkerMessage } from
  "../../types/antiRaid/protocol";
import type { ChatTeardownReason } from "../../types/chatTeardown";
import type {
  VerificationPersistedReply,
} from "../../types/diskIO/replies";
import type { DiskIORecoveryTransport } from "../../types/diskIO/messages";
import type {
  BotActionPermissions,
  BotChatPermissions,
} from "../../types/telegram";
import { settlePersistedVerificationDeferral } from "../verificationAttempts";
import {
  recordVerificationPersisted,
  settleVerificationDeletePersisted,
} from "../verificationMirror";

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

  onDiskIOReply("verificationPersisted", (reply: VerificationPersistedReply): void => {
    if (!reply.deleted) {
      if (!recordVerificationPersisted(reply.key, reply.generation, reply.revision)) return;
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
    settleVerificationDeletePersisted(reply.key, reply.generation, reply.revision);
  });
}
