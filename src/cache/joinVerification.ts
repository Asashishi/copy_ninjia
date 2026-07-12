import type { PendingVerification } from "../types";

/** 入群验证（src/joinVerification.ts）的内存状态。 */

// 仅存于内存中，符合需求——不会在重启后保留。以 "chatId:userId" 为键，
// 这样同一个人在不同群里会被独立追踪。
export const pendingVerifications: Map<string, PendingVerification> = new Map();
