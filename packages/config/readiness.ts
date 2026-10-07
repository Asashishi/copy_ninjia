/**
 * 按功能聚合部署配置的可用性判定。
 *
 * 主进程启动总闸先校验全部已存在的部署输入；真正缺省的可选文件再由相关功能
 * （`/ai_chat enable`、`/ad_detect enable`、`/translate enable`）按需判定。
 *
 * 结论只在主线程判定（见 cache/main/configReadiness.ts）：判定挂在命令与
 * 投喂门禁上，全在主线程；Worker 不判定功能能否开启。
 *
 * 启动与热重载共用同一套判定：AI 闲聊与广告检测的结论都由 *ReadinessFromHolders 按
 * 已校验配置 holder 得出，不重新读盘。启动总闸严格解析每份已存在的文件后填充对应 holder
 * （config/dynamic/agent.json 同时填充对话与 ad_detect 两段快照），holder 为空即文件或所需
 * 的段缺省；之后 config/dynamic/ 热重载每轮改写 holder，由 app/configReload.ts 重算这两项结论并
 * 经 adopt* 发布。翻译结论（g-auth.json 不热重载）只在启动时按启动快照判定。Worker 的那份配置由
 * 初始化消息投递（见 config/agent.ts 的边界说明）。结论按功能缓存成功与缺省两侧，命中缓存只读
 * holder，每条群消息都要走的路上不分配。
 */

import { validateGoogleServiceAccountKey } from "./googleAuth";
import { googleServiceAccountKey } from "../cache/main/translate";
import { lstat } from "node:fs/promises";
import { ensureAdSampleConfig } from "./adSamples";
import { ensureAssetConfig } from "./assets";
import { ensureMoodConfig } from "./mood";
import { ensureStickerConfig } from "./stickers";
import { getBotConfig } from "./bot";
import { validateAgentDeploymentConfig } from "./agent";
import { ensureCronConfig } from "./cron";
import { adoptPersona } from "./persona";
import { loadPromptFile } from "./promptFile";
import {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  translateConfigReadinessCache,
} from "../cache/main/configReadiness";
import { botAtmosphereState } from "../cache/main/atmosphere";
import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  defaultAdSampleConfigCache,
  defaultMoodConfigCache,
  defaultStickerConfigCache,
  voiceToolPromptCache,
} from "../cache/perThread/config";
import { DEFAULT_AI_PERSONA } from "../consts/aiChat/prompts/persona";
import { BOT_ATMOSPHERES, DEFAULT_BOT_ATMOSPHERE } from "../consts/bot";
import type { BotAtmosphere } from "../types/atmosphere";
import {
  AD_SAMPLES_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  CRON_CONFIG_PATH,
  GOOGLE_AUTH_FILE_PATH,
  MOOD_CONFIG_PATH,
  PERSONA_PATH,
  STICKERS_CONFIG_PATH,
  VOICE_TOOL_PROMPT_PATH,
} from "../consts/paths";
import { isErrno } from "../libs/errno";
import { InputValidationError, invalidInput } from "../libs/inputValidation";
import type {
  ConfigReadiness,
  ConfigReadinessCache,
  GoogleServiceAccountKey,
} from "../types/config";

/**
 * 读取一条功能的已缓存结论：命中时只有一次 holder 读取加一次分支，不分配。
 * 结论由启动总闸 validateExistingDeploymentInputs 填充、热重载经 adopt* 替换；
 * 启动总闸完成前返回 `startup` 的不可用结论。
 */
function cachedReadiness(cache: ConfigReadinessCache): ConfigReadiness {
  const cached: ConfigReadiness | null = cache.current;
  if (cached !== null) return cached;
  return {
    ok: false,
    failure: {
      file: "startup",
      reason: "deployment configuration preflight has not completed",
    },
  };
}

/** 一份缺失部署输入的不可用结论；诊断口径同 InputValidationError。 */
function unavailable(file: string, message: string): ConfigReadiness {
  return { ok: false, failure: { file, reason: message } };
}

/**
 * 按主线程当前 holder 判定 AI 闲聊的部署前提；只读 holder，不读盘，按顺序报第一份缺失的文件。
 *
 * 必检贴纸白名单、心情表与 agent.json 的对话核心能力段（text、summary、media）：前两份是回复
 * 流水线在 Worker 里同步取用的（aiChat/ai/tools/stickers.ts、aiChat/ai/mood.ts）；image/tts 缺省
 * 不阻塞，由工具装配单独摘挂；不看 ad_detect 段。prompt/ 下的提示词不在此列：缺省时由启动总闸
 * 接管内置人设与内置 send_voice 说明（见 ensurePromptFiles）。启动总闸之后 holder 为空只可能是
 * 文件或所需的段缺省（存在但非法的输入已拒绝启动或被热重载拒绝）。
 */
export function aiChatReadinessFromHolders(): ConfigReadiness {
  if (defaultStickerConfigCache.current === null) {
    return unavailable("config/dynamic/stickers.json", new InputValidationError(STICKERS_CONFIG_PATH, "$", "a readable valid JSON document").message);
  }
  if (defaultMoodConfigCache.current === null) {
    return unavailable("config/dynamic/mood.json", new InputValidationError(MOOD_CONFIG_PATH, "$", "a readable valid JSON document").message);
  }
  if (agentDeploymentConfigCache.current === null) {
    return unavailable(
      "config/dynamic/agent.json",
      new InputValidationError(AGENT_CONFIG_PATH, "$.agent", "configured with text, summary and media").message
    );
  }
  return { ok: true };
}

/**
 * 按主线程当前 holder 判定广告检测的部署前提：判定口径的示例清单与 agent.json 的 ad_detect 段
 * （开启时必填 provider、api_key 与 model，由 agent 配置解析器严格校验）；只看这一段，其余同上。
 */
export function adDetectReadinessFromHolders(): ConfigReadiness {
  if (defaultAdSampleConfigCache.current === null) {
    return unavailable("config/dynamic/ad_samples.json", new InputValidationError(AD_SAMPLES_CONFIG_PATH, "$", "a readable valid JSON document").message);
  }
  if (adDetectAgentConfigCache.current === null) {
    return unavailable(
      "config/dynamic/agent.json",
      new InputValidationError(AGENT_CONFIG_PATH, "$.agent.ad_detect", "configured").message
    );
  }
  return { ok: true };
}

/**
 * 热重载发布 AI 闲聊可用性结论（app/configReload.ts 在一轮对账里调用）。整体替换
 * holder，每条群消息的门禁仍只读一次 holder、不分配。
 */
export function adoptAiChatConfigReadiness(readiness: ConfigReadiness): void {
  aiChatConfigReadinessCache.current = readiness;
}

/** 热重载发布广告检测可用性结论；语义同 adoptAiChatConfigReadiness。 */
export function adoptAdDetectConfigReadiness(readiness: ConfigReadiness): void {
  adDetectConfigReadinessCache.current = readiness;
}

export function aiChatConfigReadiness(): ConfigReadiness {
  return cachedReadiness(aiChatConfigReadinessCache);
}

export function adDetectConfigReadiness(): ConfigReadiness {
  return cachedReadiness(adDetectConfigReadinessCache);
}

/** 启动总闸成功校验默认密钥后，同步填充密钥 holder 与 readiness。 */
async function validateAndCacheGoogleServiceAccountKey(): Promise<void> {
  const validated: GoogleServiceAccountKey = await validateGoogleServiceAccountKey();
  if (translateConfigReadinessCache.current === null) {
    googleServiceAccountKey.current = validated;
    translateConfigReadinessCache.current = { ok: true };
  }
}

export function translateConfigReadiness(): ConfigReadiness {
  return cachedReadiness(translateConfigReadinessCache);
}

/** 只把路径真正不存在视为缺省；断链软链接和无权访问都是已配置但非法。 */
export async function deploymentInputExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return false;
    return invalidInput(path, "$", "an accessible deployment input");
  }
}

/**
 * 启动总闸接管 AI 人设、send_voice 说明与本进程群通知风格，同批填充、不热重载。
 * prompt/persona.md 存在时严格读取其正文，缺省时使用内置人设；prompt/voice_tool.md 存在时严格
 * 读取其正文，缺省时为 null（按 `agent.tts.bot_language` 取内置说明），是否配置 `agent.tts`
 * 都同样校验。显式 atmosphere 优先；风格缺省时自定义人设使用普通文案，内置人设使用默认风格。
 * 已接管时只读 holder，不读盘。
 */
async function ensurePromptFiles(): Promise<void> {
  if (botAtmosphereState.current !== null) return;
  const hasCustomPersona: boolean = await deploymentInputExists(PERSONA_PATH);
  const persona: string = hasCustomPersona ? await loadPromptFile(PERSONA_PATH) : DEFAULT_AI_PERSONA;
  const voiceToolPrompt: string | null = await deploymentInputExists(VOICE_TOOL_PROMPT_PATH)
    ? await loadPromptFile(VOICE_TOOL_PROMPT_PATH)
    : null;
  const atmosphere: BotAtmosphere | undefined = getBotConfig().atmosphere;
  adoptPersona(persona);
  voiceToolPromptCache.current = voiceToolPrompt;
  botAtmosphereState.current = atmosphere !== undefined
    ? BOT_ATMOSPHERES[atmosphere]
    : hasCustomPersona ? "plain" : BOT_ATMOSPHERES[DEFAULT_BOT_ATMOSPHERE];
}

/**
 * 启动阶段校验所有已经存在的可选部署输入。文件真正缺省时由功能 readiness
 * 决定能否开启；文件一旦存在，就不能因相应功能当前关闭而掩盖非法内容。
 * prompt/ 下的提示词缺省不影响任何功能，由 ensurePromptFiles 接管内置文案。
 */
export async function validateExistingDeploymentInputs(): Promise<void> {
  // Telegram 身份是进程级必填配置，不受任何功能开关控制。
  getBotConfig();
  const probes: readonly Readonly<{ path: string; load: () => Promise<unknown> }>[] = [
    { path: STICKERS_CONFIG_PATH, load: ensureStickerConfig },
    { path: MOOD_CONFIG_PATH, load: ensureMoodConfig },
    { path: AD_SAMPLES_CONFIG_PATH, load: ensureAdSampleConfig },
    { path: AGENT_CONFIG_PATH, load: validateAgentDeploymentConfig },
    { path: GOOGLE_AUTH_FILE_PATH, load: validateAndCacheGoogleServiceAccountKey },
    { path: CRON_CONFIG_PATH, load: ensureCronConfig },
    { path: ASSETS_CONFIG_PATH, load: ensureAssetConfig },
  ];
  for (const probe of probes) {
    if (await deploymentInputExists(probe.path)) await probe.load();
  }
  await ensurePromptFiles();
  aiChatConfigReadinessCache.current = aiChatReadinessFromHolders();
  adDetectConfigReadinessCache.current = adDetectReadinessFromHolders();
  translateConfigReadinessCache.current ??= {
    ok: false,
    failure: {
      file: "config/static/g-auth.json",
      reason: `${GOOGLE_AUTH_FILE_PATH}: $ must be a configured Google service account JSON file.`,
    },
  };
}
