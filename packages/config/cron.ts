/**
 * config/cron.json 的严格解析：定时任务表，缺省即没有任务。
 *
 * parseCronConfig 只做形态、取值与路径的词法判定，不做 I/O；loadCronConfig 在读盘后
 * 再逐项核对 `payload.path` 指向的文件或目录存在且类型相符（跟随符号链接）。
 * 固定图片使用 1–10 项文件或 URL 数组，随机图片的 path 使用可选目录字符串；
 * 随机目录缺省时由发送侧读取 state 的专用图库，该路径按运行时数据根解析。
 * `payload.path` 写绝对路径，或相对项目根（PROJECT_ROOT）的路径，不限定目录。任何一处
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
import { TELEGRAM_CAPTION_MAX_CHARS, TELEGRAM_MESSAGE_MAX_CHARS } from "../consts/telegram";
import { parseDurationTokenMs } from "../libs/durationToken";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { hasOnlyKeys, isPlainRecord } from "../libs/record";
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
interface FieldContext {
  readonly sourcePath: string;
  readonly field: string;
}

function fail(context: FieldContext, expected: string): never {
  return invalidInput(context.sourcePath, context.field, expected);
}

function child(context: FieldContext, key: string): FieldContext {
  return { sourcePath: context.sourcePath, field: `${context.field}.${key}` };
}

/** 非空（去空白后）且不超过上限的字符串。 */
function boundedText(value: unknown, context: FieldContext, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxChars) {
    return fail(context, `a non-empty string of at most ${maxChars} characters`);
  }
  return value;
}

function optionalBoolean(value: unknown, context: FieldContext): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") return fail(context, "a boolean");
  return value;
}

/** `"<min>-<max>"` 或单值（≡ `1m-<值>`），单位 m/h/d，落在 [1m, 24d] 且 min ≤ max。 */
function parseRandomInterval(value: unknown, context: FieldContext): CronRandomInterval {
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
function parseLocalPath(value: unknown, context: FieldContext): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    return fail(context, "an absolute local path or a path relative to the project root");
  }
  return resolve(PROJECT_ROOT, value);
}

/** 交给 Telegram 拉取的绝对 http(s) 地址；只校验形态。 */
function parseUrl(value: unknown, context: FieldContext): string {
  const parsed: URL | null = typeof value === "string" ? URL.parse(value) : null;
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return fail(context, "an absolute http(s) URL");
  }
  return parsed.href;
}

function optionalCaption(value: unknown, context: FieldContext): string | undefined {
  return value === undefined ? undefined : boundedText(value, context, TELEGRAM_CAPTION_MAX_CHARS);
}

/** 恰好一个 `url` 或 `path`（普通文件）。 */
function parseFileSource(payload: Record<string, unknown>, context: FieldContext): CronFileSource {
  if ((payload.url === undefined) === (payload.path === undefined)) {
    return fail(context, "exactly one of url or path");
  }
  if (payload.url !== undefined) return { kind: "url", url: parseUrl(payload.url, child(context, "url")) };
  return { kind: "path", path: parseLocalPath(payload.path, child(context, "path")) };
}

/** 固定图片必须是一个非空来源数组；单张也使用数组，不接受随机目录。 */
function parseImageSources(payload: Record<string, unknown>, context: FieldContext): CronImageSource {
  if ((payload.url === undefined) === (payload.path === undefined)) {
    return fail(context, "exactly one of url or path arrays");
  }
  const isUrl: boolean = payload.url !== undefined;
  const value: unknown = isUrl ? payload.url : payload.path;
  const fieldContext: FieldContext = child(context, isUrl ? "url" : "path");
  if (!Array.isArray(value) || value.length === 0 || value.length > CRON_MAX_IMAGES) {
    return fail(fieldContext, `an array of 1–${CRON_MAX_IMAGES} image sources`);
  }
  const sources: string[] = [];
  for (let index: number = 0; index < value.length; index++) {
    const item: FieldContext = { sourcePath: context.sourcePath, field: `${fieldContext.field}[${index}]` };
    sources.push(isUrl ? parseUrl(value[index], item) : parseLocalPath(value[index], item));
  }
  return isUrl ? { kind: "urls", urls: sources } : { kind: "paths", paths: sources };
}

function parseAction(value: unknown, context: FieldContext): CronAction {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["type", "payload"]) || !isPlainRecord(value.payload)) {
    return fail(context, "{ type, payload: object }");
  }
  const payload: Record<string, unknown> = value.payload;
  const payloadContext: FieldContext = child(context, "payload");
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
      const isBlurred: boolean = optionalBoolean(payload.is_blurred, child(payloadContext, "is_blurred"));
      if (!optionalBoolean(payload.rand_image, child(payloadContext, "rand_image"))) {
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
    default:
      return fail(child(context, "type"), "send_message, send_image or send_file");
  }
}

/**
 * `chat_id` 数组：`["all"]`、`["except", ...会话 id]`，或直接列出会话 id。
 *
 * 三种写法都必须是数组，且都至少要有一个元素；`"all"` 只能单独出现，`"except"` 只能作为
 * 首项。会话 id 是非零安全整数且不得重复，最多 CRON_MAX_CHAT_IDS_PER_TASK 个。
 */
function parseChatTargets(value: unknown, context: FieldContext): CronChatTargets {
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
        { sourcePath: context.sourcePath, field: `${context.field}[${index}]` },
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
function parseSchedule(record: Record<string, unknown>, context: FieldContext): CronScheduleFields {
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

function parseTask(value: unknown, context: FieldContext): CronTask {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, CRON_TASK_KEYS)) {
    return fail(context, "{ name, chat_id, cron, time_zone?, rand_cron?, just_once?, actions }");
  }
  const name: string = boundedText(value.name, child(context, "name"), CRON_TASK_NAME_MAX_CHARS);
  const chatTargets: CronChatTargets = parseChatTargets(value.chat_id, child(context, "chat_id"));
  const { cron, timeZone }: CronScheduleFields = parseSchedule(value, context);
  const randomInterval: CronRandomInterval | undefined = value.rand_cron === undefined
    ? undefined
    : parseRandomInterval(value.rand_cron, child(context, "rand_cron"));
  const justOnce: boolean = optionalBoolean(value.just_once, child(context, "just_once"));
  if (justOnce && randomInterval !== undefined) {
    return fail(child(context, "just_once"), "false or absent when rand_cron is set");
  }
  if (!Array.isArray(value.actions) || value.actions.length === 0 || value.actions.length > CRON_MAX_ACTIONS_PER_TASK) {
    return fail(child(context, "actions"), `a non-empty array with at most ${CRON_MAX_ACTIONS_PER_TASK} actions`);
  }
  const actionsContext: FieldContext = child(context, "actions");
  const actions: Readonly<CronAction>[] = [];
  for (let index: number = 0; index < value.actions.length; index++) {
    actions.push(parseAction(value.actions[index], { sourcePath: context.sourcePath, field: `${actionsContext.field}[${index}]` }));
  }
  return { name, chatTargets, cron, timeZone, randomInterval, justOnce, actions };
}

/** 严格解析 cron.json 的内容；只做形态与词法判定，不访问文件系统。 */
export function parseCronConfig(value: unknown, sourcePath: string = CRON_CONFIG_PATH): CronConfig {
  const root: FieldContext = { sourcePath, field: "$" };
  if (!Array.isArray(value) || value.length > CRON_MAX_TASKS) {
    return fail(root, `an array with at most ${CRON_MAX_TASKS} tasks`);
  }
  const tasks: Readonly<CronTask>[] = [];
  const names: Set<string> = new Set();
  for (let index: number = 0; index < value.length; index++) {
    const task: CronTask = parseTask(value[index], { sourcePath, field: `$[${index}]` });
    if (names.has(task.name)) return fail({ sourcePath, field: `$[${index}].name` }, "unique across tasks");
    names.add(task.name);
    tasks.push(task);
  }
  return tasks;
}

/** 核对一个本地来源存在且类型相符；跟随符号链接，读不到一律按不存在处理。 */
async function verifyLocalSource(
  path: string,
  kind: "file" | "directory",
  context: FieldContext
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
      if (action.type === "send_message") continue;
      const context: FieldContext = { sourcePath: path, field: `$[${taskIndex}].actions[${actionIndex}].payload.path` };
      if (action.source.kind === "path") await verifyLocalSource(action.source.path, "file", context);
      else if (action.source.kind === "paths") {
        for (let index: number = 0; index < action.source.paths.length; index++) {
          await verifyLocalSource(action.source.paths[index]!, "file", { sourcePath: path, field: `${context.field}[${index}]` });
        }
      } else if (action.source.kind === "random" && action.source.directory !== null) {
        await verifyLocalSource(action.source.directory, "directory", context);
      }
    }
  }
  return config;
}

/** 接管已严格校验的任务表：启动总闸或 config/ 热重载；null 表示文件已删除或缺省。 */
export function adoptCronConfig(config: CronConfig | null): void {
  cronConfigCache.current = config;
}

/** 启动总闸：文件存在时加载并接管。 */
export async function ensureCronConfig(): Promise<void> {
  adoptCronConfig(await loadCronConfig());
}

/** 当前生效的任务表；文件缺省时为空表。只读 holder，不读盘。 */
export function getCronConfig(): CronConfig {
  return cronConfigCache.current ?? [];
}
