/**
 * 按功能聚合部署配置的可用性判定。
 *
 * 这些文件曾经在 `ApplicationLifecycle.init()` 里统一预热，任何一份写坏都让
 * 进程在联网之前退出。代价与收益不对等：贴纸白名单里多一个逗号，换来的是
 * copy、抽奖、入群验证、黑名单——全部按群 opt-in 之外的核心能力——一起离线，
 * systemd 还会照着重启循环。因此判定改在功能自己的入口做：
 * 相关命令（`/ai_chat enable`、`/ad_detect enable`、`/ja_copy enable`）读一次
 * 结论，坏了就只拒绝这一个功能并点名是哪份文件，进程照常服务其余能力。
 *
 * 结论按进程缓存**成功与失败两侧**：底层 loader 只缓存成功，失败会每次重新
 * 读盘解析，而判定要挂在每条群消息的门禁上（见 antiRaid/adDetect.ts）——不缓存
 * 失败就等于每条消息一次 readFileSync。修好文件后要重启才生效，与
 * `config/*.json` 一贯的「读一次、进程内不再重载」语义一致，拒绝文案里也点明了。
 *
 * 缓存是每 isolate 一份（见 cache/perThread/config.ts）：Worker 各自判各自的，与四份
 * 底层 loader 的单例缓存同一口径。
 *
 * config/openai.json 是唯一被**分段**探测的一份：两条线各读各的半边，因此
 * config/openai.ts 为它另开了 loadAdDetectOpenAiConfig / loadAiAgentOpenAiConfig。
 * 这两个入口不走 getAdDetectOpenAiConfig / getAiAgentOpenAiConfig 的单例缓存，
 * 于是探测各自多读一次盘——每进程每闸门一次，换来的是「一段写坏只关掉那一个功能」。
 *
 * 分段必须一路贯穿到运行时：运行时侧同样是两个分段访问器、两对缓存 holder。
 * 只要有任何一个消费点回退成整份加载，这里的分段判定就等于没做——那一段的笔误
 * 会先通过闸门与启动 preflight，再在真实调用时抛错并被上游 catch 吞掉。
 */

import { readFileSync } from "node:fs";
import { getAdSampleConfig } from "./adSamples";
import { getMoodConfig } from "./mood";
import { getReactionConfig } from "./reactions";
import { getStickerConfig } from "./stickers";
import { loadAdDetectOpenAiConfig, loadAiAgentOpenAiConfig } from "./openai";
import { loadGeminiDeploymentConfig } from "./gemini";
import { hasGeminiChatCredentials, hasOpenAiChatCredentials } from "../aiChat/credentials";
import {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  jaTranslateConfigReadinessCache,
} from "../cache/main/configReadiness";
import { GOOGLE_AUTH_FILE_PATH } from "../consts/paths";
import { isPlainRecord } from "../libs/runtimeConfig";
import type { ConfigReadiness, ConfigReadinessCache, DeploymentFileProbe } from "../types/config";

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

/** 按 holder 缓存一次探测结论（成功与失败都缓存，理由见模块头注）。 */
function cachedReadiness(cache: ConfigReadinessCache, probes: readonly DeploymentFileProbe[]): ConfigReadiness {
  cache.current ??= probeAll(probes);
  return cache.current;
}

/**
 * AI 闲聊要读的部署配置：贴纸白名单、反应词表、心情表三份必检，
 * config/openai.json 的 **ai_agent 段**在握有 OpenAI 凭据时一并检。
 *
 * 前三份缺一不可——回复流水线在 Worker 里同步取用它们（aiChat/ai/tools/stickers.ts、
 * aiChat/ai/reactions.ts、aiChat/ai/mood.ts），任一份解析失败都会让那条线程当场
 * 抛出而不是降级。
 *
 * 后两份是条件项，各自的判定依据是「握没握着那一家的凭据」，而不是
 * 「activeAiProvider() 选了谁」：Gemini 部署也能把生图单独切到 OpenAI
 * （`/image_model gpt`），那时 ai_agent.models.image 照样会被读到；反过来
 * OpenAI 部署补上 Gemini key 之后同理。凭据一在，那份文件就是 AI 闲聊的前提；
 * 一不在，它根本没有消费方，不该拦住只配一把 key 的部署。
 *
 * 两份模型配置都**必填且无默认值**：代码里一个模型名都不留，缺文件、缺字段一律
 * 在这里被判为不可用，进而由 app/featurePreflight.ts 拒绝启动（见 config/gemini.ts
 * 与 config/openai.ts 的模块头注）。
 *
 * 探的是 ai_agent 段而不是整份文件：ad_detect 段的笔误与 AI 闲聊无关，反过来
 * 也一样（见下方广告检测那份清单）。两段共用顶层形状校验，整份文件不是对象时
 * 两边都会失败——那时谁也读不出自己那一段。
 */
export function aiChatConfigReadiness(): ConfigReadiness {
  const probes: DeploymentFileProbe[] = [
    { file: "config/stickers.json", load: getStickerConfig },
    { file: "config/reactions.json", load: getReactionConfig },
    { file: "config/mood.json", load: getMoodConfig },
  ];
  if (hasGeminiChatCredentials()) probes.push({ file: "config/gemini.json", load: loadGeminiDeploymentConfig });
  if (hasOpenAiChatCredentials()) probes.push({ file: "config/openai.json", load: loadAiAgentOpenAiConfig });
  return cachedReadiness(aiChatConfigReadinessCache, probes);
}

/**
 * 广告检测要读的两份：判定口径的示例清单，以及 config/openai.json 的
 * **ad_detect 段**。
 *
 * 后者**必填**：`ad_detect.model` 没有代码默认值可退，缺文件、缺段、缺模型名
 * 都在这里被判为不可用。写坏同样拦住——判定走的就是那个端点，配错了每条待检
 * 消息都会换来一次请求失败。可省的只有 `ad_detect.base_url`（缺省走官方地址）。
 *
 * 只探 ad_detect 段：广告检测一个字段都不读 ai_agent，整份解析等于让那半边的
 * 任意笔误把广告检测判为不可用——而这份结论会被 app/featurePreflight.ts 在启动
 * 时读到，于是 Gemini 部署为了准备 OpenAI 兜底而写坏 ai_agent，代价是 bot 起不来。
 */
export function adDetectConfigReadiness(): ConfigReadiness {
  return cachedReadiness(adDetectConfigReadinessCache, [
    { file: "config/ad_samples.json", load: getAdSampleConfig },
    { file: "config/openai.json", load: loadAdDetectOpenAiConfig },
  ]);
}

/**
 * 日语翻译要读的服务账号密钥。这一份不像 config/*.json 有解析器，因此在这里
 * 就地做最小校验：能读、是 JSON 对象、带着 gRPC 客户端鉴权真正要用的那两个
 * 字段。只判「文件在不在」是不够的——空文件与占位文本同样能通过，然后每条
 * `/ja_copy` 都会退化成原文照发，而群里看不出与「翻译服务抖了一下」的区别。
 */
export function jaTranslateConfigReadiness(): ConfigReadiness {
  return cachedReadiness(jaTranslateConfigReadinessCache, [
    {
      file: "g-auth.json",
      load: (): void => {
        const parsed: unknown = JSON.parse(readFileSync(GOOGLE_AUTH_FILE_PATH, "utf8")) as unknown;
        if (!isPlainRecord(parsed)) {
          throw new Error("Invalid Google service account key: expected a JSON object");
        }
        for (const field of ["client_email", "private_key"] as const) {
          const value: unknown = parsed[field];
          if (typeof value !== "string" || value.trim().length === 0) {
            throw new Error(`Invalid Google service account key: ${field} must be a non-empty string`);
          }
        }
      },
    },
  ]);
}
