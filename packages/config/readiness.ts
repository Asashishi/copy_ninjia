/**
 * 按功能聚合部署配置的可用性判定。
 *
 * 主进程启动总闸先校验全部已存在的部署输入；真正缺省的可选文件再由相关功能
 * （`/ai_chat enable`、`/ad_detect enable`、`/translate enable`）按需判定。
 *
 * 结论按功能缓存成功与缺省两侧；运行时只检查已校验配置 holder，不重新读取文件。
 * 启动总闸填充三条结论。之后 config/ 热重载每轮改写 holder，由 app/configReload.ts
 * 按本模块的 *ReadinessFromHolders 重算 AI 闲聊与广告检测两条并经 adopt* 发布；
 * 翻译结论（g-auth.json 不热重载）只在启动时判定。
 *
 * 结论只在主线程判定（见 cache/main/configReadiness.ts）：三条判定挂的都是命令与
 * 投喂门禁，全在主线程；Worker 不问「这个功能能不能开」。
 *
 * 功能 readiness 对 config/agent.json 仍按消费方**分段**探测，且与运行时共用同
 * 一对 holder：启动总闸严格解析整份文件后会同时填充两段快照，探测因此只是
 * 「holder 空不空」的一次分支，已存在文件在一个进程里只解析一次。运行时那一侧
 * 只读 holder，Worker 的那份由初始化消息投递（见 config/agent.ts 的边界说明）。
 *
 * AI 探测表都是模块级只读常量，翻译直接消费启动快照：命中缓存只读 holder，
 * 每条群消息都要走的路上不构造数组与 probe 对象。
 */

import { validateGoogleServiceAccountKey } from "./googleAuth";
import { googleServiceAccountKey } from "../cache/main/translate";
import { lstat } from "node:fs/promises";
import { ensureAdSampleConfig } from "./adSamples";
import { ensureMoodConfig } from "./mood";
import { ensureStickerConfig } from "./stickers";
import { getBotConfig } from "./bot";
import {
  ensureAdDetectAgentConfig,
  ensureAgentDeploymentConfig,
  validateAgentDeploymentConfig,
} from "./agent";
import { ensureCronConfig } from "./cron";
import { ensurePersona } from "./persona";
import {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  translateConfigReadinessCache,
} from "../cache/main/configReadiness";
import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  defaultAdSampleConfigCache,
  defaultMoodConfigCache,
  defaultStickerConfigCache,
  personaCache,
} from "../cache/perThread/config";
import {
  AD_SAMPLES_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  CRON_CONFIG_PATH,
  GOOGLE_AUTH_FILE_PATH,
  MOOD_CONFIG_PATH,
  PERSONA_PATH,
  STICKERS_CONFIG_PATH,
} from "../consts/paths";
import { isErrno } from "../libs/errno";
import { InputValidationError, invalidInput } from "../libs/inputValidation";
import type {
  ConfigReadiness,
  ConfigReadinessCache,
  DeploymentFileProbe,
  GoogleServiceAccountKey,
} from "../types/config";
import { errorMessage } from "../libs/errorMessage";

/** 逐份探测，返回第一份坏掉的；全通过返回 ok。 */
async function probeAll(
  probes: readonly DeploymentFileProbe[]
): Promise<ConfigReadiness> {
  for (const probe of probes) {
    try {
      await probe.load();
    } catch (error: unknown) {
      return {
        ok: false,
        failure: {
          file: probe.file,
          reason: errorMessage(error),
        },
      };
    }
  }
  return { ok: true };
}

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

/**
 * AI 闲聊要读的部署配置：贴纸白名单、心情表、人设与 agent 段必检。
 *
 * 前两份缺一不可——回复流水线在 Worker 里同步取用它们（aiChat/ai/tools/stickers.ts、
 * aiChat/ai/mood.ts），任一份解析失败都会让那条线程当场抛出而不是降级。
 *
 * agent 配置按能力声明 provider、api_key、model 与 base_url。AI 对话只要求
 * text、summary、media；image/song 缺省不阻塞，由工具装配单独摘挂。探测不读取
 * ad_detect，因此它的缺省不影响 AI 对话，反过来也一样。
 *
 * 顺序即拒绝顺序：probeAll 报第一份坏掉的文件，改动这张表等于改动运维看到的
 * 拒绝文案。
 */
const AI_CHAT_PROBES: readonly DeploymentFileProbe[] = [
  { file: "config/stickers.json", load: ensureStickerConfig },
  { file: "config/mood.json", load: ensureMoodConfig },
  { file: "prompt/persona.md", load: ensurePersona },
  { file: "config/agent.json", load: ensureAgentDeploymentConfig },
];

/**
 * 广告检测要读的两份：判定口径的示例清单，以及 config/agent.json 的
 * **ad_detect 段**。
 *
 * 开启广告检测时后者**必填**：`provider`、`api_key` 与 `model` 缺一不可；缺文件、
 * 缺能力、缺字段都在这里判为不可用。可省的只有 `base_url`，缺省时由所选 SDK
 * 使用自己的官方端点；兼容端点必须显式配置。
 *
 * 这份功能结论只探 ad_detect 段；文件一旦存在，其他段的合法性已由
 * validateExistingDeploymentInputs 的启动总闸独立保证。
 */
const AD_DETECT_PROBES: readonly DeploymentFileProbe[] = [
  { file: "config/ad_samples.json", load: ensureAdSampleConfig },
  { file: "config/agent.json", load: ensureAdDetectAgentConfig },
];

/** 一份缺失部署输入的不可用结论；诊断口径同 InputValidationError。 */
function unavailable(file: string, message: string): ConfigReadiness {
  return { ok: false, failure: { file, reason: message } };
}

/**
 * 按主线程当前 holder 判定 AI 闲聊的部署前提；只读 holder，不读盘。
 *
 * 顺序与 AI_CHAT_PROBES 一致，报第一份缺失的文件。启动总闸之后 holder 为空只可能
 * 是文件或 agent.json 的对话核心能力段缺省（存在但非法的输入已拒绝启动或被热重载
 * 拒绝），与启动时 probeAll 的判据相同。persona 不热重载，启动时缺省则一直为空。
 */
export function aiChatReadinessFromHolders(): ConfigReadiness {
  if (defaultStickerConfigCache.current === null) {
    return unavailable("config/stickers.json", new InputValidationError(STICKERS_CONFIG_PATH, "$", "a readable valid JSON document").message);
  }
  if (defaultMoodConfigCache.current === null) {
    return unavailable("config/mood.json", new InputValidationError(MOOD_CONFIG_PATH, "$", "a readable valid JSON document").message);
  }
  if (personaCache.current === null) {
    return unavailable("prompt/persona.md", new InputValidationError(PERSONA_PATH, "$", "a readable non-empty UTF-8 text file").message);
  }
  if (agentDeploymentConfigCache.current === null) {
    return unavailable(
      "config/agent.json",
      new InputValidationError(AGENT_CONFIG_PATH, "$.agent", "configured with text, summary and media").message
    );
  }
  return { ok: true };
}

/** 按主线程当前 holder 判定广告检测的部署前提；顺序与 AD_DETECT_PROBES 一致，其余同上。 */
export function adDetectReadinessFromHolders(): ConfigReadiness {
  if (defaultAdSampleConfigCache.current === null) {
    return unavailable("config/ad_samples.json", new InputValidationError(AD_SAMPLES_CONFIG_PATH, "$", "a readable valid JSON document").message);
  }
  if (adDetectAgentConfigCache.current === null) {
    return unavailable(
      "config/agent.json",
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

/** 启动总闸成功校验默认密钥后同步填充 readiness，避免首次功能探测重复读盘。 */
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
 * 启动阶段校验所有已经存在的可选部署输入。文件真正缺省时由功能 readiness
 * 决定能否开启；文件一旦存在，就不能因相应功能当前关闭而掩盖非法内容。
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
    { path: PERSONA_PATH, load: ensurePersona },
    { path: CRON_CONFIG_PATH, load: ensureCronConfig },
  ];
  for (const probe of probes) {
    if (await deploymentInputExists(probe.path)) await probe.load();
  }
  aiChatConfigReadinessCache.current = await probeAll(AI_CHAT_PROBES);
  adDetectConfigReadinessCache.current = await probeAll(AD_DETECT_PROBES);
  translateConfigReadinessCache.current ??= {
    ok: false,
    failure: {
      file: "config/g-auth.json",
      reason: `${GOOGLE_AUTH_FILE_PATH}: $ must be a configured Google service account JSON file.`,
    },
  };
}
