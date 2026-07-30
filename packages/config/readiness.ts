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
 */

import { readFileSync } from "node:fs";
import { getAdSampleConfig } from "./adSamples";
import { getMoodConfig } from "./mood";
import { getReactionConfig } from "./reactions";
import { getStickerConfig } from "./stickers";
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
 * AI 闲聊要读的三份部署配置：贴纸白名单、反应词表、心情表。三份缺一不可
 * ——回复流水线在 Worker 里同步取用它们（ai/tools/stickers.ts、ai/reactions.ts、
 * ai/mood.ts），任一份解析失败都会让那条线程当场抛出而不是降级。
 */
export function aiChatConfigReadiness(): ConfigReadiness {
  return cachedReadiness(aiChatConfigReadinessCache, [
    { file: "config/stickers.json", load: getStickerConfig },
    { file: "config/reactions.json", load: getReactionConfig },
    { file: "config/mood.json", load: getMoodConfig },
  ]);
}

/** 广告检测要读的那一份：判定口径的示例清单。 */
export function adDetectConfigReadiness(): ConfigReadiness {
  return cachedReadiness(adDetectConfigReadinessCache, [
    { file: "config/ad_samples.json", load: getAdSampleConfig },
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
