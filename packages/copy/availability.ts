/**
 * 日语翻译「此刻到底跑不跑」的唯一判定入口，与 aiChat/availability.ts 同构。
 *
 * 两个条件缺一不可：进程侧的服务账号密钥可用（`g-auth.json`，见
 * config/readiness.ts），本群开了 /ja_copy enable（ChatState.isJATranslationEnabled，
 * 缺省关闭）。
 *
 * 密钥那一半单独判，是因为翻译失败的降级是**静默**的：translateToJapanese 出错
 * 只返回 null，copyModes 于是原样发出未翻译的原文。群里看到的就是「/ja_copy 复读了
 * 一句中文」，与「翻译服务抖了一下」完全不可区分——一次配置事故能这样连续伪装
 * 好几天。判定提前到这里，`/ja_copy` 会直接说清楚是密钥的问题，自动复读路径也
 * 干脆退化成普通复制而不是假装翻译过。
 *
 * 单独成文件而不并进 copy/translate.ts：那个模块在 import 期就拉起 Google 的
 * gRPC SDK，而命令与自动流水线只想问一句「开没开」。
 */

import { jaTranslateConfigReadiness } from "../config/readiness";
import { getChatState } from "../infra/storage/stateStore";

/**
 * 进程侧是否具备跑日语翻译的前提。为假时 /ja_copy enable 被拒；已经开着的群
 * 也会在消息入口降级为普通复读，但不会因此阻止整个进程启动。
 */
export function isJaTranslationConfigured(): boolean {
  return jaTranslateConfigReadiness().ok;
}

/** 某群此刻是否真的在跑日语翻译：前提齐备且本群 opt-in。 */
export function isJaTranslationActiveIn(chatId: number): boolean {
  return isJaTranslationConfigured() && getChatState(chatId).isJATranslationEnabled === true;
}
