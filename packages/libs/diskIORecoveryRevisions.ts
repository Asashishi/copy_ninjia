import type { DiskBusinessMessage } from "../types/diskIO/messages";
import type { IdentityPolicyTable } from "../types/identityPolicy";
import type { LinkedQueue } from "./linkedQueue";

/** 一次恢复的镜像水位与已覆盖消息身份；容量沿用领域未 ACK 表及有界 FIFO，恢复结束释放。 */
export class DiskIORecoveryRevisions {
  private readonly policies: Readonly<Record<IdentityPolicyTable, Map<number, number>>> = {
    whitelist: new Map(), blocklist: new Map(),
  };
  private readonly temporary: Map<number, number> = new Map();
  private readonly states: Map<number, number> = new Map();
  private readonly questions: Map<number, Map<string, number>> = new Map();
  private removals: number = 0;
  private readonly coveredStickers: WeakSet<DiskBusinessMessage> = new WeakSet();
  private readonly coveredWedOperations: WeakSet<DiskBusinessMessage> = new WeakSet();

  /** 只在镜像成功进入有序通道后登记；消费 ACK 不会清除此恢复水位。 */
  record(message: DiskBusinessMessage, buffered: LinkedQueue<DiskBusinessMessage>): void {
    switch (message.type) {
      case "identityPolicyWrite": this.policies[message.table].set(message.id, message.revision); break;
      case "temporaryWhitelistWrite": this.temporary.set(message.id, message.revision); break;
      case "chatStateWrite": this.states.set(message.chatId, message.revision); break;
      case "wedMembers":
      case "deleteWedMembers":
        // 镜像代表此刻最终操作；只覆盖登记时已在 FIFO 的旧代消息，之后的新操作仍按序送达。
        for (const previous of buffered.values()) {
          if ((previous.type === "wedMembers" || previous.type === "deleteWedMembers") && previous.chatId === message.chatId) {
            this.coveredWedOperations.add(previous);
          }
        }
        break;
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
      // 入群日志整群删除按 FIFO 执行。
      case "deleteJoinLog":
      case "joinLog":
      case "aiMemory":
      case "deleteAiMemory":
      case "forgetAiMemory":
      case "luckDraw":
      case "verificationUpsert":
      case "verificationDelete": break;
    }
  }

  /** 已被本轮镜像覆盖的旧 FIFO 操作不再执行；后续新操作继续按序投递。 */
  covers(message: DiskBusinessMessage): boolean {
    switch (message.type) {
      case "identityPolicyWrite": return (this.policies[message.table].get(message.id) ?? 0) >= message.revision;
      case "temporaryWhitelistWrite": return (this.temporary.get(message.id) ?? 0) >= message.revision;
      case "chatStateWrite": return (this.states.get(message.chatId) ?? 0) >= message.revision;
      case "wedMembers":
      case "deleteWedMembers": return this.coveredWedOperations.has(message);
      case "chatQaWrite": return (this.questions.get(message.chatId)?.get(message.q) ?? 0) >= message.revision;
      case "blocklistRemovals": return this.removals >= message.revision;
      case "stickerCatalog": return this.coveredStickers.has(message);
      default: return false;
    }
  }
}
