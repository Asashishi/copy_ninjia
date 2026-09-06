import type { User } from "grammy/types";
import type { CurrentAvatar } from "./telegram";
import type { PrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";

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

/** 每群结果会话为纯内存；成员集合引用主线程持久化 owner。 */
export interface WedChat {
  readonly controller: AbortController;
  readonly members: Set<number>;
  readonly sessions: Map<number, WedSession>;
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

/** 主线程 /wed 执行器的一代运行状态；排队与在途任务都由停机边界观察。 */
export interface WedRuntime {
  readonly runner: PrioritizedBoundedTaskRunner;
  readonly controller: AbortController;
  readonly tasks: Set<Promise<void>>;
  accepting: boolean;
}
