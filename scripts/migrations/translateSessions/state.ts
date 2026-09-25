import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import { decodeChatStateData } from "../../../packages/database/codec/chatState";
import { invalidInput } from "../../../packages/libs/inputValidation";
import { isPlainRecord } from "../../../packages/libs/record";
import { decodeStateFile } from "../../../packages/libs/stateFileCodec";
import { isTelegramGroupChatId } from "../../../packages/libs/telegramId";
import type { TranslateState } from "../../../packages/types/translate";

/** 源状态文档拆分结果：去掉 translate 的当前格式文档，以及按群的翻译会话。 */
export interface SplitStateDocument {
  readonly document: Readonly<Record<string, unknown>>;
  readonly sessions: ReadonlyMap<number, readonly TranslateState[]>;
}

/**
 * 按迁移前格式（顶层 global 与可选 translate）拆分一份 state 文档。去掉 translate 后的
 * 部分必须通过当前 state 解码器；每群会话按 chat_states codec 严格校验，群键必须是
 * 规范负整数群 ID，群数不超过 STATE_MANAGED_CHAT_LIMIT。任何不符都拒绝整份文档。
 */
export function splitStateDocument(value: unknown, source: string): SplitStateDocument {
  if (!isPlainRecord(value)) return invalidInput(source, "state", "an object");
  const { translate, ...document }: Record<string, unknown> = value;
  decodeStateFile(document, source);
  const sessions: Map<number, readonly TranslateState[]> = new Map();
  if (translate === undefined) return { document, sessions };
  if (!isPlainRecord(translate)) return invalidInput(source, "state.translate", "an object");
  const keys: string[] = Object.keys(translate);
  if (keys.length > STATE_MANAGED_CHAT_LIMIT) {
    return invalidInput(source, "state.translate", `an object with at most ${STATE_MANAGED_CHAT_LIMIT} groups`);
  }
  for (const key of keys) {
    const chatId: number = Number(key);
    if (!isTelegramGroupChatId(chatId) || String(chatId) !== key) {
      return invalidInput(source, "state.translate keys", "canonical negative safe integer Telegram group IDs");
    }
    const decoded: readonly TranslateState[] | undefined = decodeChatStateData(
      JSON.stringify({ translate: translate[key] }),
      `${source}:state.translate.${key}`
    ).translate;
    if (decoded === undefined) return invalidInput(source, `state.translate.${key}`, "a non-empty session array");
    sessions.set(chatId, decoded);
  }
  return { document, sessions };
}
