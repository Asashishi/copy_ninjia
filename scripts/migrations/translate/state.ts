import { decodeStateFile } from "../../../packages/libs/stateFileCodec";
import { hasExactKeys, isPlainRecord } from "../../../packages/libs/record";
import { invalidInput, parseJsonInput } from "../../../packages/libs/inputValidation";
import type { DecodedStateFile } from "../../../packages/types/chatState";
import type { TranslateState } from "../../../packages/types/translate";

/** 状态解码器的安全诊断；只携带文件、字段路径和期望形态。 */
export class TranslationStateMigrationError extends Error {}

/** 仅转换 10.5.4 的 global-only 状态；日语 copy 目标转入独立翻译会话。 */
export function migrateTranslationState(text: string, source: string): string {
  const value: unknown = parseJsonInput(text, source);
  if (!isPlainRecord(value) || !hasExactKeys(value, ["global"]) ||
    !isPlainRecord(value.global) || !isPlainRecord(value.global.copy)) {
    return invalidInput(source, "$", "the 10.5.4 global-only state format");
  }
  const global: Record<string, unknown> = value.global;
  const copy: Record<string, unknown> = value.global.copy;
  const isJapanese: boolean = copy.copyMode === "ja";
  const validationInput: unknown = isJapanese
    ? { global: { ...global, copy: { ...copy, copyMode: "reverse" } } }
    : value;
  let decoded: DecodedStateFile;
  try {
    decoded = decodeStateFile(validationInput);
  } catch (error: unknown) {
    throw new TranslationStateMigrationError(`${source}: ${error instanceof Error ? error.message : "state must match the 10.5.4 schema"}`, { cause: error });
  }
  const translate: Record<string, readonly TranslateState[]> = {};
  let migratedGlobal: Record<string, unknown> = global;
  if (isJapanese) {
    if (decoded.global.copy.copiedUser === null) return invalidInput(source, "$.global.copy", "an active Japanese copy target");
    translate[String(decoded.global.copy.copyChatId)] = [{
      translatedUser: decoded.global.copy.copiedUser,
      language: "ja",
    }];
    const { copiedUser: _user, copyMode: _mode, copyChatId: _chat, ...retained }: Record<string, unknown> = copy;
    migratedGlobal = { ...global, copy: { ...retained, copiedUser: null } };
  }
  const output: unknown = { global: migratedGlobal, translate };
  decodeStateFile(output);
  return `${JSON.stringify(output, null, 2)}\n`;
}
