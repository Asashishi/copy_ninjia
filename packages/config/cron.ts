/**
 * config/cron.json 的严格解析：定时任务表，缺省即没有任务。
 *
 * parseCronConfig 只做形态、取值与路径的词法判定，不做 I/O；loadCronConfig 在读盘后
 * 再逐项核对 `payload.path` 指向的文件或目录存在且类型相符（跟随符号链接）。
 * 固定图片使用 1–10 项文件或 URL 数组，随机图片的 path 使用可选目录字符串；
 * 随机目录缺省时由发送侧读取 state 的专用图库，该路径按运行时数据根解析。
 * `payload.path` 写绝对路径，或相对项目根（PROJECT_ROOT）的路径，不限定目录。
 * `send_voice` 依赖 config/agent.json 的 `agent.tts`：assertCronVoiceSupported 在启动总闸
 * （ensureCronConfig）与热重载（config/reload.ts）里按当时生效的 agent 配置核对。任何一处
 * 非法都整份拒绝：启动时拒绝启动，热重载时沿用上一份（见 config/reload.ts）。诊断只含
 * 文件路径、字段路径与期望形态。
 */

import type { Stats } from "node:fs";
import { resolve } from "node:path";
import { cronConfigCache } from "../cache/main/cron";
import {
  CRON_ALL_CHATS,
  CRON_DEFAULT_TIME_ZONE,
  CRON_EXCEPT_CHATS,
  CRON_MAX_ACTIONS_PER_TASK,
  CRON_MAX_IMAGES,
  CRON_MAX_CHAT_IDS_PER_TASK,
  CRON_MAX_TASKS,
  CRON_RANDOM_INTERVAL_MAX_MS,
  CRON_RANDOM_INTERVAL_MIN_MS,
  CRON_TASK_KEYS,
  CRON_TASK_NAME_MAX_CHARS,
} from "../consts/cron";
import { CRON_CONFIG_PATH, PROJECT_ROOT } from "../consts/paths";
import { VOICE_OPERATOR_TEXT_MAX_CHARS, VOICE_TONE_MAX_CHARS } from "../consts/aiChat/voiceMessage";
import { agentTtsConfig } from "./agent";
import { sanitizeInline } from "../libs/text";
import { TELEGRAM_CAPTION_MAX_CHARS, TELEGRAM_MESSAGE_MAX_CHARS } from "../consts/telegram";
import { parseDurationTokenMs } from "../libs/durationToken";
import { invalidInput, optionalBooleanField, readJsonInput } from "../libs/inputValidation";
import type { InputFieldContext } from "../libs/inputValidation";
import { hasOnlyKeys, isPlainRecord } from "../libs/record";
import type { AgentTtsCapabilityConfig } from "../types/config";
import type {
  CronAction,
  CronChatTargets,
  CronConfig,
  CronFileSource,
  CronImageSource,
  CronRandomInterval,
  CronTask,
} from "../types/cron";

/** 字段路径与诊断文件的组合，逐层下传。 */

function fail(context: InputFieldContext, expected: string): never {
  return invalidInput(context.source, context.path, expected);
}

function child(context: InputFieldContext, key: string): InputFieldContext {
  return { source: context.source, path: `${context.path}.${key}` };
}

/** 非空（去空白后）且不超过上限的字符串。 */
function boundedText(value: unknown, context: InputFieldContext, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxChars) {
    return fail(context, `a non-empty string of at most ${maxChars} characters`);
  }
  return value;
}

/** `"<min>-<max>"` 或单值（≡ `1m-<值>`），单位 m/h/d，落在 [1m, 24d] 且 min ≤ max。 */
function parseRandomInterval(value: unknown, context: InputFieldContext): CronRandomInterval {
  const expected: string = "\"<min>-<max>\" or \"<max>\" with m/h/d units, within 1m-24d and min <= max";
  if (typeof value !== "string") return fail(context, expected);
  const parts: string[] = value.split("-");
  if (parts.length > 2) return fail(context, expected);
  const first: number | undefined = parseDurationTokenMs(parts[0]!);
  const second: number | undefined = parts.length === 2 ? parseDurationTokenMs(parts[1]!) : undefined;
  const minMs: number | undefined = parts.length === 2 ? first : CRON_RANDOM_INTERVAL_MIN_MS;
  const maxMs: number | undefined = parts.length === 2 ? second : first;
  if (
    minMs === undefined || maxMs === undefined ||
    minMs < CRON_RANDOM_INTERVAL_MIN_MS || maxMs > CRON_RANDOM_INTERVAL_MAX_MS || minMs > maxMs
  ) {
    return fail(context, expected);
  }
  return { minMs, maxMs };
}

/** 本机的文件或目录路径：绝对路径原样使用，相对路径按项目根解析；拒绝空串与 NUL，返回规范化后的绝对路径。 */
function parseLocalPath(value: unknown, context: InputFieldContext): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    return fail(context, "an absolute local path or a path relative to the project root");
  }
  return resolve(PROJECT_ROOT, value);
}

/** 交给 Telegram 拉取的绝对 http(s) 地址；只校验形态。 */
function parseUrl(value: unknown, context: InputFieldContext): string {
  const parsed: URL | null = typeof value === "string" ? URL.parse(value) : null;
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return fail(context, "an absolute http(s) URL");
  }
  return parsed.href;
}

/** 非空（清洗成单行并去空白后）且原文不超过上限的字符串；返回清洗后的单行。 */
function boundedLine(value: unknown, context: InputFieldContext, maxChars: number): string {
  return sanitizeInline(boundedText(value, context, maxChars)).trim();
}

function optionalCaption(value: unknown, context: InputFieldContext): string | undefined {
  return value === undefined ? undefined : boundedText(value, context, TELEGRAM_CAPTION_MAX_CHARS);
}

/** 恰好一个 `url` 或 `path`（普通文件）。 */
function parseFileSource(payload: Record<string, unknown>, context: InputFieldContext): CronFileSource {
  if ((payload.url === undefined) === (payload.path === undefined)) {
    return fail(context, "exactly one of url or path");
  }
  if (payload.url !== undefined) return { kind: "url", url: parseUrl(payload.url, child(context, "url")) };
  return { kind: "path", path: parseLocalPath(payload.path, child(context, "path")) };
}

/** 固定图片必须是一个非空来源数组；单张也使用数组，不接受随机目录。 */
function parseImageSources(payload: Record<string, unknown>, context: InputFieldContext): CronImageSource {
  if ((payload.url === undefined) === (payload.path === undefined)) {
    return fail(context, "exactly one of url or path arrays");
  }
  const isUrl: boolean = payload.url !== undefined;
  const value: unknown = isUrl ? payload.url : payload.path;
  const fieldContext: InputFieldContext = child(context, isUrl ? "url" : "path");
  if (!Array.isArray(value) || value.length === 0 || value.length > CRON_MAX_IMAGES) {
    return fail(fieldContext, `an array of 1–${CRON_MAX_IMAGES} image sources`);
  }
  const sources: string[] = [];
  for (let index: number = 0; index < value.length; index++) {
    const item: InputFieldContext = { source: context.source, path: `${fieldContext.path}[${index}]` };
    sources.push(isUrl ? parseUrl(value[index], item) : parseLocalPath(value[index], item));
  }
  return isUrl ? { kind: "urls", urls: sources } : { kind: "paths", paths: sources };
}

function parseAction(value: unknown, context: InputFieldContext): CronAction {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["type", "payload"]) || !isPlainRecord(value.payload)) {
    return fail(context, "{ type, payload: object }");
  }
  const payload: Record<string, unknown> = value.payload;
  const payloadContext: InputFieldContext = child(context, "payload");
  switch (value.type) {
    case "send_message":
      if (!hasOnlyKeys(payload, ["content"])) return fail(payloadContext, "{ content }");
      return {
        type: "send_message",
        content: boundedText(payload.content, child(payloadContext, "content"), TELEGRAM_MESSAGE_MAX_CHARS),
      };
    case "send_image": {
      if (!hasOnlyKeys(payload, ["content", "rand_image", "url", "path", "is_blurred"])) {
        return fail(payloadContext, "{ content?, rand_image?, url?, path?, is_blurred? }");
      }
      const content: string | undefined = optionalCaption(payload.content, child(payloadContext, "content"));
      const isBlurred: boolean = optionalBooleanField(payload, "is_blurred", payloadContext) === true;
      if (optionalBooleanField(payload, "rand_image", payloadContext) !== true) {
        return { type: "send_image", content, source: parseImageSources(payload, payloadContext), isBlurred };
      }
      if (payload.url !== undefined) return fail(child(payloadContext, "url"), "absent when rand_image is true");
      const source: CronImageSource = {
        kind: "random",
        directory: payload.path === undefined ? null : parseLocalPath(payload.path, child(payloadContext, "path")),
      };
      return { type: "send_image", content, source, isBlurred };
    }
    case "send_file":
      if (!hasOnlyKeys(payload, ["content", "url", "path"])) return fail(payloadContext, "{ content?, url?, path? }");
      return {
        type: "send_file",
        content: optionalCaption(payload.content, child(payloadContext, "content")),
        source: parseFileSource(payload, payloadContext),
      };
    case "send_voice":
      if (!hasOnlyKeys(payload, ["content", "tone"])) return fail(payloadContext, "{ content, tone? }");
      return {
        type: "send_voice",
        content: boundedLine(payload.content, child(payloadContext, "content"), VOICE_OPERATOR_TEXT_MAX_CHARS),
        tone: payload.tone === undefined
          ? undefined
          : boundedLine(payload.tone, child(payloadContext, "tone"), VOICE_TONE_MAX_CHARS),
      };
    default:
      return fail(child(context, "type"), "send_message, send_image, send_file or send_voice");
  }
}

/**
 * `chat_id` 数组：`["all"]`、`["except", ...会话 id]`，或直接列出会话 id。
 *
 * 三种写法都必须是数组，且都至少要有一个元素；`"all"` 只能单独出现，`"except"` 只能作为
 * 首项。会话 id 是非零安全整数且不得重复，最多 CRON_MAX_CHAT_IDS_PER_TASK 个。
 */
function parseChatTargets(value: unknown, context: InputFieldContext): CronChatTargets {
  const expected: string =
    `["${CRON_ALL_CHATS}"], ["${CRON_EXCEPT_CHATS}", <chat id>, ...] or a list of at most ` +
    `${CRON_MAX_CHAT_IDS_PER_TASK} unique non-zero safe integer chat ids`;
  if (!Array.isArray(value) || value.length === 0) return fail(context, expected);
  if (value[0] === CRON_ALL_CHATS) {
    if (value.length !== 1) return fail(context, expected);
    return { kind: "all" };
  }
  const except: boolean = value[0] === CRON_EXCEPT_CHATS;
  const offset: number = except ? 1 : 0;
  if (value.length - offset === 0 || value.length - offset > CRON_MAX_CHAT_IDS_PER_TASK) {
    return fail(context, expected);
  }
  const chatIds: number[] = [];
  for (let index: number = offset; index < value.length; index++) {
    const chatId: unknown = value[index];
    if (typeof chatId !== "number" || !Number.isSafeInteger(chatId) || chatId === 0 || chatIds.includes(chatId)) {
      return fail(
        { source: context.source, path: `${context.path}[${index}]` },
        "a unique non-zero safe integer chat id"
      );
    }
    chatIds.push(chatId);
  }
  return except ? { kind: "except", chatIds } : { kind: "list", chatIds };
}

/** parseSchedule 的结果。 */
interface CronScheduleFields {
  readonly cron: string;
  readonly timeZone: string;
}

/** 校验时区与表达式：两者都用 Bun.cron.parse 判定，且必须还有将来的触发时间。 */
function parseSchedule(record: Record<string, unknown>, context: InputFieldContext): CronScheduleFields {
  // 只有键真正缺省才用默认时区；显式写出的非法值（含 null）照常拒绝。
  const timeZone: unknown = record.time_zone === undefined ? CRON_DEFAULT_TIME_ZONE : record.time_zone;
  if (typeof timeZone !== "string" || timeZone.length === 0) return fail(child(context, "time_zone"), "an IANA time zone name");
  try {
    Bun.cron.parse("0 0 * * *", Date.now(), { tz: timeZone });
  } catch {
    return fail(child(context, "time_zone"), "an IANA time zone name");
  }
  const cron: unknown = record.cron;
  const expected: string = "a 5-field cron expression or @nickname with a future occurrence";
  if (typeof cron !== "string") return fail(child(context, "cron"), expected);
  let next: Date | null;
  try {
    next = Bun.cron.parse(cron, Date.now(), { tz: timeZone });
  } catch {
    return fail(child(context, "cron"), expected);
  }
  if (next === null) return fail(child(context, "cron"), expected);
  return { cron, timeZone };
}

function parseTask(value: unknown, context: InputFieldContext): CronTask {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, CRON_TASK_KEYS)) {
    return fail(context, "{ name, chat_id, cron, time_zone?, rand_cron?, just_once?, actions }");
  }
  const name: string = boundedText(value.name, child(context, "name"), CRON_TASK_NAME_MAX_CHARS);
  const chatTargets: CronChatTargets = parseChatTargets(value.chat_id, child(context, "chat_id"));
  const { cron, timeZone }: CronScheduleFields = parseSchedule(value, context);
  const randomInterval: CronRandomInterval | undefined = value.rand_cron === undefined
    ? undefined
    : parseRandomInterval(value.rand_cron, child(context, "rand_cron"));
  const justOnce: boolean = optionalBooleanField(value, "just_once", context) === true;
  if (justOnce && randomInterval !== undefined) {
    return fail(child(context, "just_once"), "false or absent when rand_cron is set");
  }
  if (!Array.isArray(value.actions) || value.actions.length === 0 || value.actions.length > CRON_MAX_ACTIONS_PER_TASK) {
    return fail(child(context, "actions"), `a non-empty array with at most ${CRON_MAX_ACTIONS_PER_TASK} actions`);
  }
  const actionsContext: InputFieldContext = child(context, "actions");
  const actions: Readonly<CronAction>[] = [];
  for (let index: number = 0; index < value.actions.length; index++) {
    actions.push(parseAction(value.actions[index], { source: context.source, path: `${actionsContext.path}[${index}]` }));
  }
  return { name, chatTargets, cron, timeZone, randomInterval, justOnce, actions };
}

/** 严格解析 cron.json 的内容；只做形态与词法判定，不访问文件系统。 */
export function parseCronConfig(value: unknown, sourcePath: string = CRON_CONFIG_PATH): CronConfig {
  const root: InputFieldContext = { source: sourcePath, path: "$" };
  if (!Array.isArray(value) || value.length > CRON_MAX_TASKS) {
    return fail(root, `an array with at most ${CRON_MAX_TASKS} tasks`);
  }
  const tasks: Readonly<CronTask>[] = [];
  const names: Set<string> = new Set();
  for (let index: number = 0; index < value.length; index++) {
    const task: CronTask = parseTask(value[index], { source: sourcePath, path: `$[${index}]` });
    if (names.has(task.name)) return fail({ source: sourcePath, path: `$[${index}].name` }, "unique across tasks");
    names.add(task.name);
    tasks.push(task);
  }
  return tasks;
}

/** 核对一个本地来源存在且类型相符；跟随符号链接，读不到一律按不存在处理。 */
async function verifyLocalSource(
  path: string,
  kind: "file" | "directory",
  context: InputFieldContext
): Promise<void> {
  let valid: boolean;
  try {
    const stats: Stats = await Bun.file(path).stat();
    valid = kind === "file" ? stats.isFile() : stats.isDirectory();
  } catch {
    valid = false;
  }
  if (!valid) fail(context, kind === "file" ? "an existing regular file" : "an existing directory");
}

/** 读取并严格解析 cron.json，再核对全部本地来源；模块 import 本身不访问文件系统。 */
export async function loadCronConfig(path: string = CRON_CONFIG_PATH): Promise<CronConfig> {
  const config: CronConfig = parseCronConfig(await readJsonInput(path), path);
  for (let taskIndex: number = 0; taskIndex < config.length; taskIndex++) {
    const actions: readonly Readonly<CronAction>[] = config[taskIndex]!.actions;
    for (let actionIndex: number = 0; actionIndex < actions.length; actionIndex++) {
      const action: Readonly<CronAction> = actions[actionIndex]!;
      if (action.type === "send_message" || action.type === "send_voice") continue;
      const context: InputFieldContext = { source: path, path: `$[${taskIndex}].actions[${actionIndex}].payload.path` };
      if (action.source.kind === "path") await verifyLocalSource(action.source.path, "file", context);
      else if (action.source.kind === "paths") {
        for (let index: number = 0; index < action.source.paths.length; index++) {
          await verifyLocalSource(action.source.paths[index]!, "file", { source: path, path: `${context.path}[${index}]` });
        }
      } else if (action.source.kind === "random" && action.source.directory !== null) {
        await verifyLocalSource(action.source.directory, "directory", context);
      }
    }
  }
  return config;
}

/**
 * `send_voice` 要用 config/agent.json 的 `agent.tts` 合成语音：任务表里出现 send_voice 而
 * tts 缺省时，按第一个 send_voice 动作的字段路径拒绝整份文件。
 * @param tts 与这份任务表同时生效的 tts 配置；启动时是刚校验的 agent 配置，热重载时是
 *   本轮对账后生效的那一份。
 */
export function assertCronVoiceSupported(
  config: CronConfig,
  tts: AgentTtsCapabilityConfig | undefined,
  sourcePath: string = CRON_CONFIG_PATH
): void {
  if (tts !== undefined) return;
  for (let taskIndex: number = 0; taskIndex < config.length; taskIndex++) {
    const actions: readonly Readonly<CronAction>[] = config[taskIndex]!.actions;
    for (let actionIndex: number = 0; actionIndex < actions.length; actionIndex++) {
      if (actions[actionIndex]!.type !== "send_voice") continue;
      fail(
        { source: sourcePath, path: `$[${taskIndex}].actions[${actionIndex}].type` },
        "send_message, send_image or send_file unless config/agent.json configures $.agent.tts alongside text, summary and media"
      );
    }
  }
}

/** 任务表里是否有 send_voice 动作；热重载据此判断 agent.json 能否去掉 tts。 */
export function cronConfigUsesVoice(config: CronConfig): boolean {
  for (const task of config) {
    for (const action of task.actions) {
      if (action.type === "send_voice") return true;
    }
  }
  return false;
}

/** 接管已严格校验的任务表：启动总闸或 config/ 热重载；null 表示文件已删除或缺省。 */
export function adoptCronConfig(config: CronConfig | null): void {
  cronConfigCache.current = config;
}

/**
 * 启动总闸：文件存在时加载、核对 send_voice 与 `agent.tts` 后接管。须排在 agent.json 的
 * 校验之后（见 config/readiness.ts 的 validateExistingDeploymentInputs）。
 */
export async function ensureCronConfig(): Promise<void> {
  const config: CronConfig = await loadCronConfig();
  assertCronVoiceSupported(config, agentTtsConfig());
  adoptCronConfig(config);
}

/** 当前生效的任务表；文件缺省时为空表。只读 holder，不读盘。 */
export function getCronConfig(): CronConfig {
  return cronConfigCache.current ?? [];
}
