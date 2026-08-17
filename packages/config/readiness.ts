/**
 * 按功能聚合部署配置的可用性判定。
 *
 * 主进程启动总闸先校验全部已存在的部署输入；真正缺省的可选文件再由相关功能
 * （`/ai_chat enable`、`/ad_detect enable`、`/ja_copy enable`）按需判定。
 *
 * 结论按进程缓存**成功与失败两侧**：底层 loader 只缓存成功，失败会每次重新
 * 读盘解析，而判定要挂在每条群消息的门禁上（见 antiRaid/adDetect.ts）——不缓存
 * 失败就等于每条消息一次 readFileSync。修好文件后要重启才生效，与
 * `config/*.json` 一贯的「读一次、进程内不再重载」语义一致，拒绝文案里也点明了。
 *
 * 结论只在主线程判定（见 cache/main/configReadiness.ts）：三条判定挂的都是命令与
 * 投喂门禁，全在主线程；Worker 不问「这个功能能不能开」。
 *
 * 功能 readiness 对 config/agent.json 仍按消费方**分段**探测，且与运行时共用同
 * 一对 holder：启动总闸严格解析整份文件后会同时填充两段快照，探测因此只是
 * 「holder 空不空」的一次分支，已存在文件在一个进程里只解析一次。运行时那一侧
 * 只读 holder，Worker 的那份由初始化消息投递（见 config/agent.ts 的边界说明）。
 *
 * 三张探测表都是模块级只读常量：判定命中缓存后只剩一次 holder 读取和一次分支，
 * 每条群消息都要走的路上不再构造数组与 probe 对象。
 */

import { createPrivateKey } from "node:crypto";
import { lstatSync } from "node:fs";
import { getAdSampleConfig } from "./adSamples";
import { getMoodConfig } from "./mood";
import { getReactionConfig } from "./reactions";
import { getStickerConfig } from "./stickers";
import { getTelegramConfig } from "./telegram";
import {
  ensureAdDetectAgentConfig,
  ensureAgentDeploymentConfig,
  validateAgentDeploymentConfig,
} from "./agent";
import { getPersona } from "./persona";
import {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  jaTranslateConfigReadinessCache,
} from "../cache/main/configReadiness";
import {
  AD_SAMPLES_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  GOOGLE_AUTH_FILE_PATH,
  MOOD_CONFIG_PATH,
  PERSONA_PATH,
  REACTIONS_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
} from "../consts/paths";
import { isErrno } from "../libs/errno";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { isPlainRecord } from "../libs/record";
import type {
  ConfigReadiness,
  ConfigReadinessCache,
  DeploymentFileProbe,
} from "../types/config";

/** 逐份探测，返回第一份坏掉的；全通过返回 ok。 */
function probeAll(probes: readonly DeploymentFileProbe[]): ConfigReadiness {
  for (const probe of probes) {
    try {
      probe.load();
    } catch (error: unknown) {
      return {
        ok: false,
        failure: {
          file: probe.file,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  return { ok: true };
}

/**
 * 按 holder 缓存一次探测结论（成功与失败都缓存，理由见模块头注）。
 *
 * 命中缓存的那一路只有一次 holder 读取加一次分支：三条 readiness 全部挂在每条
 * 群消息的门禁上，`??=` 虽然短路了 probeAll，调用方为它准备的 probe 表却仍然
 * 每次都要构造。因此探测表一律是模块级只读常量（见下方三张表），本函数不再
 * 参与任何分配。
 */
function cachedReadiness(cache: ConfigReadinessCache, probes: readonly DeploymentFileProbe[]): ConfigReadiness {
  const cached: ConfigReadiness | null = cache.current;
  if (cached !== null) return cached;
  const verdict: ConfigReadiness = probeAll(probes);
  cache.current = verdict;
  return verdict;
}

/**
 * AI 闲聊要读的部署配置：贴纸白名单、反应词表、心情表、人设与 agent 段必检。
 *
 * 前三份缺一不可——回复流水线在 Worker 里同步取用它们（aiChat/ai/tools/stickers.ts、
 * aiChat/ai/reactions.ts、aiChat/ai/mood.ts），任一份解析失败都会让那条线程当场
 * 抛出而不是降级。
 *
 * agent 配置按能力声明 provider、api_key、model 与 base_url。AI 对话只要求
 * text、summary、media；image/song 缺省不阻塞，由工具装配单独摘挂。探测不读取
 * ad_detect，因此它的缺省不影响 AI 对话，反过来也一样。
 *
 * 顺序即拒绝顺序：probeAll 报第一份坏掉的文件，改动这张表等于改动运维看到的
 * 拒绝文案。
 */
const AI_CHAT_PROBES: readonly DeploymentFileProbe[] = [
  { file: "config/stickers.json", load: getStickerConfig },
  { file: "config/reactions.json", load: getReactionConfig },
  { file: "config/mood.json", load: getMoodConfig },
  { file: "prompt/persona.md", load: getPersona },
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
  { file: "config/ad_samples.json", load: getAdSampleConfig },
  { file: "config/agent.json", load: ensureAdDetectAgentConfig },
];

/** 日语翻译只探一份服务账号密钥；就地校验见 validateGoogleServiceAccountKey。 */
const JA_TRANSLATE_PROBES: readonly DeploymentFileProbe[] = [
  { file: "g-auth.json", load: validateGoogleServiceAccountKey },
];

export function aiChatConfigReadiness(): ConfigReadiness {
  return cachedReadiness(aiChatConfigReadinessCache, AI_CHAT_PROBES);
}

export function adDetectConfigReadiness(): ConfigReadiness {
  return cachedReadiness(adDetectConfigReadinessCache, AD_DETECT_PROBES);
}

/**
 * 日语翻译要读的服务账号密钥。这一份不像 config/*.json 有解析器，因此在这里
 * 就地做最小校验：能读、是 JSON 对象、带着 gRPC 客户端鉴权真正要用的那两个
 * 字段。只判「文件在不在」是不够的——空文件与占位文本同样能通过，然后每条
 * `/ja_copy` 都会退化成原文照发，而群里看不出与「翻译服务抖了一下」的区别。
 */
function validateGoogleServiceAccountKey(
  path: string = GOOGLE_AUTH_FILE_PATH
): void {
  const parsed: unknown = readJsonInput(path);
  if (!isPlainRecord(parsed)) {
    return invalidInput(path, "$", "a Google service account JSON object");
  }
  if (typeof parsed.client_email !== "string" || parsed.client_email.trim().length === 0) {
    return invalidInput(path, "$.client_email", "a non-empty string");
  }
  if (typeof parsed.private_key !== "string" || parsed.private_key.trim().length === 0) {
    return invalidInput(path, "$.private_key", "a parseable non-empty PEM private key");
  }
  try {
    createPrivateKey(parsed.private_key);
  } catch {
    return invalidInput(path, "$.private_key", "a parseable non-empty PEM private key");
  }
}

/** 启动总闸成功校验默认密钥后同步填充 readiness，避免首次功能探测重复读盘。 */
function validateAndCacheGoogleServiceAccountKey(): void {
  validateGoogleServiceAccountKey();
  // 失败结论一旦缓存就保持到重启；不得因进程内文件变化把它静默翻成成功。
  jaTranslateConfigReadinessCache.current ??= { ok: true };
}

export function jaTranslateConfigReadiness(): ConfigReadiness {
  return cachedReadiness(jaTranslateConfigReadinessCache, JA_TRANSLATE_PROBES);
}

/** 只把路径真正不存在视为缺省；断链软链接和无权访问都是已配置但非法。 */
function deploymentInputExists(path: string): boolean {
  try {
    lstatSync(path);
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
export function validateExistingDeploymentInputs(): void {
  // Telegram 身份是进程级必填配置，不受任何功能开关控制。
  getTelegramConfig();
  const probes: readonly Readonly<{ path: string; load: () => unknown }>[] = [
    { path: STICKERS_CONFIG_PATH, load: (): unknown => getStickerConfig() },
    { path: REACTIONS_CONFIG_PATH, load: (): unknown => getReactionConfig() },
    { path: MOOD_CONFIG_PATH, load: (): unknown => getMoodConfig() },
    { path: AD_SAMPLES_CONFIG_PATH, load: (): unknown => getAdSampleConfig() },
    { path: AGENT_CONFIG_PATH, load: (): void => validateAgentDeploymentConfig() },
    { path: GOOGLE_AUTH_FILE_PATH, load: validateAndCacheGoogleServiceAccountKey },
    { path: PERSONA_PATH, load: (): string => getPersona() },
  ];
  for (const probe of probes) {
    if (deploymentInputExists(probe.path)) probe.load();
  }
}
