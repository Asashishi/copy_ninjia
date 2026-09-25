import { getChatStateCache } from "../infra/storage/stateStore";
import { updateCachedIdentity } from "../users/senderIdentity";
import type { TranslateState } from "../types/translate";

/** 启动恢复后把各群翻译目标填入已有身份缓存，容量与清理复用身份缓存边界。 */
export function seedTranslateTargets(): void {
  for (const chatState of getChatStateCache().values()) {
    const states: readonly TranslateState[] | undefined = chatState.translate;
    if (states === undefined) continue;
    for (const state of states) updateCachedIdentity(state.translatedUser);
  }
}
