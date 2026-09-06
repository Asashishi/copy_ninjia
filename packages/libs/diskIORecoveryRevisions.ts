import type { DiskBusinessMessage } from "../types/diskIO/messages";
import type { IdentityPolicyTable } from "../types/identityPolicy";
import type { LinkedQueue } from "./linkedQueue";

/** 一次恢复期间已成功投递的 SQLite 镜像水位；上限沿用各主线程未 ACK 表，恢复结束即释放。 */
export class DiskIORecoveryRevisions {
  private readonly policies: Readonly<Record<IdentityPolicyTable, Map<number, number>>> = {
    whitelist: new Map(), blocklist: new Map(),
  };
  private readonly temporary: Map<number, number> = new Map();
  private readonly states: Map<number, number> = new Map();
  private readonly wedMembers: Map<number, number> = new Map();
  private readonly questions: Map<number, Map<string, number>> = new Map();
  private removals: number = 0;
  private readonly coveredStickers: WeakSet<DiskBusinessMessage> = new WeakSet();

  /** 只在镜像成功进入有序通道后登记；消费 ACK 不会清除此恢复水位。 */
  record(message: DiskBusinessMessage, buffered: LinkedQueue<DiskBusinessMessage>): void {
    switch (message.type) {
      case "identityPolicyWrite": this.policies[message.table].set(message.id, message.revision); break;
      case "temporaryWhitelistWrite": this.temporary.set(message.id, message.revision); break;
      case "chatStateWrite": this.states.set(message.chatId, message.revision); break;
      case "wedMembers": this.wedMembers.set(message.chatId, message.revision); break;
      case "chatQaWrite": {
        let questions: Map<string, number> | undefined = this.questions.get(message.chatId);
        if (questions === undefined) { questions = new Map(); this.questions.set(message.chatId, questions); }
        questions.set(message.q, message.revision);
        break;
      }
      case "blocklistRemovals": this.removals = message.revision; break;
      case "stickerCatalog":
        for (const previous of buffered.values()) {
          if (previous.type === "stickerCatalog" && previous.pack === message.pack) this.coveredStickers.add(previous);
        }
        break;
      case "joinLog":
      case "aiMemory":
      case "deleteAiMemory":
      case "forgetAiMemory":
      case "luckDraw":
      case "verificationUpsert":
      case "verificationDelete": break;
    }
  }

  /** 旧 FIFO 的最终值已被本轮更高或相同 revision 镜像覆盖时，不再反向覆盖事务。 */
  covers(message: DiskBusinessMessage): boolean {
    switch (message.type) {
      case "identityPolicyWrite": return (this.policies[message.table].get(message.id) ?? 0) >= message.revision;
      case "temporaryWhitelistWrite": return (this.temporary.get(message.id) ?? 0) >= message.revision;
      case "chatStateWrite": return (this.states.get(message.chatId) ?? 0) >= message.revision;
      case "wedMembers": return (this.wedMembers.get(message.chatId) ?? -1) >= message.revision;
      case "chatQaWrite": return (this.questions.get(message.chatId)?.get(message.q) ?? 0) >= message.revision;
      case "blocklistRemovals": return this.removals >= message.revision;
      case "stickerCatalog": return this.coveredStickers.has(message);
      default: return false;
    }
  }
}
