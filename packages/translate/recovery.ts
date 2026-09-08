import { translateStates } from "../cache/main/translateState";
import { seedSenderCache } from "../users/senderIdentity";

/** 启动恢复后把翻译目标填入已有身份缓存，容量与清理复用身份缓存边界。 */
export function seedTranslateTargets(): void {
  for (const states of translateStates.values()) {
    for (const state of states) seedSenderCache(state.translatedUser);
  }
}
