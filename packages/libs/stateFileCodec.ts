import { isPlainRecord } from "./record";
import { TRANSLATE_CHAT_USER_LIMIT } from "../consts/translate";
import { isTelegramGroupChatId } from "./telegramId";
import { STATE_MANAGED_CHAT_LIMIT } from "../consts/storage";
import type { TranslateState } from "../types/translate";
import type {
  CachedUser,
  CopyMode,
  GlobalAssetState,
  DecodedGlobalCopyState,
  DecodedGlobalState,
  DecodedStateFile,
} from "../types/chatState";

/**
 * state.json 当前 schema 的纯解码器。本模块不执行 I/O；所有持久化字段都从
 * unknown 逐项收窄，未知字段、类型错误和跨字段不变量冲突会拒绝整个文件。
 */
function record(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const keys: Set<string> = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${path}.${key} is not part of the current state schema`);
  }
}

function optionalBoolean(value: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "boolean") throw new Error(`${path}.${key} must be a boolean`);
  return field;
}

function optionalString(value: Record<string, unknown>, key: string, path: string): string | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string") throw new Error(`${path}.${key} must be a string`);
  return field;
}

function optionalTimestamp(value: Record<string, unknown>, key: string, path: string): number | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new Error(`${path}.${key} must be a non-negative safe integer timestamp`);
  }
  return field;
}

function copyMode(value: unknown, path: string): CopyMode | undefined {
  if (value === undefined) return undefined;
  if (value === "reverse" || value === "nya") return value;
  throw new Error(`${path} must be one of reverse or nya`);
}

/**
 * 外部素材直链。口径与其余字段一致：缺省即从没设过、由代码常量兜底；存在但不是
 * 可解析的绝对地址（协议见下）就拒绝整份文件——少写 scheme（`cdn.example.com/face.jpg`）
 * 是最常见的手误，而 Telegram 收到它只会静默不显示这张图，运维看到的现象与
 * 「图挂了」没有区别。
 *
 * `allowHttp` 只对机器人默认头像开：那张图由本进程自己抓取，配成明文 http 的
 * 内网或自建地址是部署方的决定，走不走 TLS 由配置者负责。三张内联缩略图不同——
 * 直链是交给 Telegram 去取的，这里只认 https。
 */
function assetUrl(value: unknown, path: string, allowHttp: boolean = false): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a non-empty string`);
  // 收下的是去空白后的值：URL 构造器会自行忽略首尾空白，直接留着原样等于把
  // `" https://…"` 存进内存再原样发给 Telegram，那边可不惯着。
  const raw: string = value.trim();
  if (raw.length === 0) throw new Error(`${path} must be a non-empty string`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${path} must be an absolute ${allowHttp ? "http(s)" : "https"} URL`);
  }
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new Error(`${path} must use ${allowHttp ? "http or https" : "https"}`);
  }
  // 归一化后的 href 而不是 raw：trim 只管首尾，而 URL 构造器还会吃掉字符串**内部**
  // 的 tab/LF/CR、对空格做百分号编码。留着 raw 等于让一个「构造器认、Telegram 不认」
  // 的地址通过校验，再由它把整个 answerInlineQuery 载荷带崩——而这些字符在 JSON
  // 里肉眼不可见，运维粘贴一个折行的直链就中招。
  return parsed.href;
}

function cachedUser(value: unknown, path: string): CachedUser {
  const raw: Record<string, unknown> = record(value, path);
  knownKeys(raw, ["id", "username", "first_name", "last_name", "title", "isChannel"], path);
  if (typeof raw.id !== "number" || !Number.isSafeInteger(raw.id) || raw.id === 0) {
    throw new Error(`${path}.id must be a non-zero safe integer`);
  }
  return {
    id: raw.id,
    username: optionalString(raw, "username", path),
    first_name: optionalString(raw, "first_name", path),
    last_name: optionalString(raw, "last_name", path),
    title: optionalString(raw, "title", path),
    isChannel: optionalBoolean(raw, "isChannel", path),
  };
}

function globalCopy(value: unknown): DecodedGlobalCopyState {
  const path: string = "state.global.copy";
  const raw: Record<string, unknown> = record(value, path);
  knownKeys(raw, ["lastCopyTime", "copiedUser", "copyMode", "copyChatId"], path);
  if (!("copiedUser" in raw)) throw new Error(`${path}.copiedUser is required`);
  const lastCopyTime: number | undefined = optionalTimestamp(raw, "lastCopyTime", path);
  if (raw.copiedUser === null) {
    if (raw.copyMode !== undefined || raw.copyChatId !== undefined) {
      throw new Error(`${path} cannot contain copyMode/copyChatId without copiedUser`);
    }
    return { copiedUser: null, lastCopyTime };
  }
  if (!isTelegramGroupChatId(raw.copyChatId)) {
    throw new Error(
      `${path}.copyChatId must be a negative safe integer Telegram group or channel ID when copiedUser is set`
    );
  }
  return {
    lastCopyTime,
    copiedUser: cachedUser(raw.copiedUser, `${path}.copiedUser`),
    copyMode: copyMode(raw.copyMode, `${path}.copyMode`),
    copyChatId: raw.copyChatId,
  };
}

/**
 * 全局素材直链。整块缺省按「四项都没设过」处理：这一块是
 * 后加的，既有的 state.json 里没有它，不该逼运维补一个空对象；块内字段存在但
 * 非法照旧拒绝整份文件。
 */
function globalAssets(value: unknown): GlobalAssetState {
  const path: string = "state.global.assets";
  // 两条分支返回同一组字段，save 时的自校验才不会看到两种 shape。
  if (value === undefined) {
    return {
      fortuneThumbnailUrl: undefined,
      probabilityThumbnailUrl: undefined,
      gagThumbnailUrl: undefined,
      botDefaultAvatarUrl: undefined,
    };
  }
  const raw: Record<string, unknown> = record(value, path);
  knownKeys(raw, [
    "fortuneThumbnailUrl",
    "probabilityThumbnailUrl",
    "gagThumbnailUrl",
    "botDefaultAvatarUrl",
  ], path);
  return {
    fortuneThumbnailUrl: assetUrl(raw.fortuneThumbnailUrl, `${path}.fortuneThumbnailUrl`),
    probabilityThumbnailUrl: assetUrl(raw.probabilityThumbnailUrl, `${path}.probabilityThumbnailUrl`),
    gagThumbnailUrl: assetUrl(raw.gagThumbnailUrl, `${path}.gagThumbnailUrl`),
    // 只有这一项允许明文 http，理由见 assetUrl。
    botDefaultAvatarUrl: assetUrl(raw.botDefaultAvatarUrl, `${path}.botDefaultAvatarUrl`, true),
  };
}

/** 所有群共用的那一块；copy 必填，assets 可缺省。 */
function globalState(value: unknown): DecodedGlobalState {
  const path: string = "state.global";
  const raw: Record<string, unknown> = record(value, path);
  knownKeys(raw, ["copy", "assets"], path);
  if (!("copy" in raw)) throw new Error(`${path}.copy is required`);
  return {
    copy: globalCopy(raw.copy),
    assets: globalAssets(raw.assets),
  };
}

/** 每群保存非空会话数组；身份不得重复，方向与容量均严格校验。 */
function translationChat(value: unknown, path: string): readonly TranslateState[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > TRANSLATE_CHAT_USER_LIMIT) {
    throw new Error(`${path} must be an array containing 1 to ${TRANSLATE_CHAT_USER_LIMIT} translation sessions`);
  }
  const result: TranslateState[] = [];
  const userIds: Set<number> = new Set();
  for (let index: number = 0; index < value.length; index++) {
    const entryPath: string = `${path}[${index}]`;
    const entry: Record<string, unknown> = record(value[index], entryPath);
    knownKeys(entry, ["translatedUser", "language"], entryPath);
    if (entry.language !== "ja" && entry.language !== "cn" && entry.language !== "en" &&
      entry.language !== "uk" && entry.language !== "ru") {
      throw new Error(`${entryPath}.language must be one of ja, cn, en, uk or ru`);
    }
    const translatedUser: CachedUser = cachedUser(entry.translatedUser, `${entryPath}.translatedUser`);
    if (userIds.has(translatedUser.id)) throw new Error(`${entryPath}.translatedUser.id must be unique within the chat`);
    userIds.add(translatedUser.id);
    result.push({ translatedUser, language: entry.language });
  }
  return result;
}

/** 翻译会话按规范负整数群 ID 索引；缺省为空，不接受空条目或非法方向。 */
function translationStates(value: unknown): Readonly<Record<string, readonly TranslateState[]>> {
  if (value === undefined) return {};
  const path: string = "state.translate";
  const raw: Record<string, unknown> = record(value, path);
  const entries: string[] = Object.keys(raw);
  if (entries.length > STATE_MANAGED_CHAT_LIMIT) {
    throw new Error(`${path} must contain at most ${STATE_MANAGED_CHAT_LIMIT} groups`);
  }
  const result: Record<string, readonly TranslateState[]> = {};
  for (const key of entries) {
    const chatId: number = Number(key);
    if (!isTelegramGroupChatId(chatId) || String(chatId) !== key) {
      throw new Error(`${path} keys must be canonical negative safe integer Telegram group IDs`);
    }
    result[key] = translationChat(raw[key], `${path}.${key}`);
  }
  return result;
}

/** 解码完整 state.json；任何存在但非法的字段都会拒绝整个文件。 */
export function decodeStateFile(value: unknown): DecodedStateFile {
  const raw: Record<string, unknown> = record(value, "state");
  // 旧顶层键（globalCopy/imageProvider/chatProvider）会在这里被当场拒绝：结构
  // 变更只做手工迁移，解码器不留兼容分支（见 types/chatState.ts 的 StateFileSchema）。
  knownKeys(raw, ["global", "translate"], "state");
  if (!("global" in raw)) throw new Error("state.global is required");
  return { global: globalState(raw.global), translate: translationStates(raw.translate) };
}
