import type { User } from "grammy/types";
import type { CurrentAvatar } from "./telegram";

/** /wed 本轮核实的用户与头像发送源，仅在本次交互中持有。 */
export interface WedCandidate extends CurrentAvatar {
  readonly identity: User;
}

/** 主线程拥有的一张 /wed 结果；图片仅在单次请求栈中持有。 */
export interface WedSession {
  readonly chatId: number;
  readonly actor: User;
  readonly messageThreadId: number | undefined;
  readonly controller: AbortController;
  messageId: number | undefined;
  targetId: number | undefined;
  confirmed: boolean;
  busy: boolean;
}

/** 在途头像查询；按群记录新发言，防止旧查询结论删除新观察到的候选。 */
export interface WedAvatarProbe {
  readonly observedChats: Set<number>;
}

/** 每群结果会话为纯内存；成员集合引用主线程持久化 owner。 */
export interface WedChat {
  readonly controller: AbortController;
  readonly members: Set<number>;
  readonly sessions: Map<number, WedSession>;
  /** 机器人已离群：收尾置位后，正在重抽的会话不再删除被它替换的旧结果。 */
  departed: boolean;
}

/** 主线程拥有的成员集合；修订号只用于进程内恢复定序，不写入 JSON。 */
export interface WedMemberState {
  readonly members: Set<number>;
  revision: number;
  dirty: boolean;
}

/** 主线程每日成员复核的调度与当前探测；新在群观察可否决迟到的离群结果。 */
export interface WedMemberReview {
  readonly controller: AbortController;
  ready: boolean;
  pendingDay: string | null;
  lastDay: string | null;
  running: boolean;
  chatId: number | null;
  userId: number | null;
  observed: boolean;
}
