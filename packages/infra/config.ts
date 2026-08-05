/**
 * 集中存放不应硬编码在源码里的值：密钥和每次部署都不同的配置。
 * 从环境变量读取（Bun 会自动加载 `.env`），绝不使用写死在代码里的默认值。
 */

import { parseTelegramUserId } from "../libs/runtimeConfig";

/**
 * 读取必需的环境变量。返回的是 trim 之后的值——校验和取用必须是同一个字符串：
 * systemd 单元或 CRLF 编辑过的 .env 会让值尾部带空格/`\r`，那样既通过了非空
 * 校验，又会被原样拼进请求 URL（token 尾部一个 `%0D` 就是全部 Telegram 调用
 * 静默 404），报错还指向远端而不是这里。
 */
function requireEnv(name: string, allowEmpty: boolean = false): string {
  const value: string | undefined = process.env[name];
  if (value === undefined || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value.trim();
}

/**
 * 读取可选的环境变量。trim 规则与 requireEnv 完全一致；未配置或只有空白时
 * 返回 undefined，由调用方自己决定降级路径——一把只服务于某个可选功能的密钥
 * 缺失，只该关掉那个功能，不该在模块求值期把整个进程拦在启动之前。
 */
function optionalEnv(name: string): string | undefined {
  const trimmed: string = (process.env[name] ?? "").trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export const BOT_TOKEN: string = requireEnv("TELEGRAM_BOT_TOKEN");

/**
 * Google Gemini API 密钥，AI 闲聊 agent 独占：回复生成、图片理解、记忆压缩
 * （packages/workers/aiChatWorker.ts、packages/aiChat/gemini/）。与广告检测的
 * AD_DETECT_DEEPSEEK_API_KEY 职责不重叠，两条线各用各的凭据，互不回退。
 *
 * 变量名以所服务的功能（`/ai_chat`）打头而不是以供应商打头：读 `.env` 的人
 * 关心的是「缺这一把会瘸哪个功能」，而不是「这把 key 是谁家发的」——同一家
 * 供应商日后完全可能同时服务两个功能，那时按供应商命名就再也分不开了。
 *
 * 可选。AI 闲聊是按群 opt-in、缺省关闭的附加功能，缺这把密钥不该让 copy、
 * 抽奖、入群验证、黑名单一起起不来（理由同下方 DeepSeek 那把，见
 * docs/04-invariants.md）。未配置时 /ai_chat enable 与 /switch_mood 直接拒绝、
 * AI Worker 根本不启动，已经开着的群也不再投喂消息与触发
 * （packages/aiChat/availability.ts 是唯一判定入口）。
 */
export const AI_CHAT_GEMINI_API_KEY: string | undefined = optionalEnv("AI_CHAT_GEMINI_API_KEY");

/**
 * OpenAI API 密钥，AI 闲聊 agent 的降级供应商：两家实现包提供同一份能力
 * （回复生成、图片理解、记忆压缩、生图），选取见 packages/aiChat/provider.ts。
 *
 * 默认仍走 Gemini：只有 AI_CHAT_GEMINI_API_KEY 缺席时才轮到这一把。两把都配
 * 齐时 OpenAI 那份原样闲置，不做运行时故障切换（理由见 aiChat/provider.ts）。
 *
 * 可选，且与 Gemini 那把是「或」的关系——两把都没有才算 AI 闲聊未配置
 * （packages/aiChat/availability.ts 是唯一判定入口）。
 *
 * 与广告检测的 AD_DETECT_DEEPSEEK_API_KEY 职责不重叠：那把也是 OpenAI 兼容
 * 接口，但服务的是入群守卫线程里的广告判定，两条线各用各的凭据，互不回退。
 *
 * env 里只留凭据：端点与模型是「这次部署连哪儿、用哪个」的运维配置，放在
 * config/openai.json（见 packages/config/openai.ts），两者的备份、权限与轮换
 * 节奏都不一样。
 */
export const AI_CHAT_OPENAI_API_KEY: string | undefined = optionalEnv("AI_CHAT_OPENAI_API_KEY");

/**
 * DeepSeek API 密钥（OpenAI 兼容接口），广告检测独占：入群守卫线程里的判定
 * （packages/workers/antiRaid/adDetect/）。AI 闲聊一律走 Gemini，不会用到它。
 * 变量名同样以功能（`/ad_detect`）打头，理由见上方那把。
 *
 * 可选。广告检测是按群 opt-in、缺省关闭的附加功能，缺这把密钥不该让 copy、
 * 抽奖、入群验证、黑名单一起起不来。未配置时 /ad_detect enable 直接拒绝
 * （packages/commands/adDetect.ts），已经开着的群也不再投递待检消息
 * （packages/antiRaid/adCandidate.ts 的 buildAdCandidate）。
 */
export const AD_DETECT_DEEPSEEK_API_KEY: string | undefined = optionalEnv("AD_DETECT_DEEPSEEK_API_KEY");

/**
 * 超级管理员用户 ID。这个身份本身即持有 config/whitelist.json 能授予的全部
 * 逐项权限，**不必也不应**在那份文件里另配条目——覆盖只发生在读取侧、永不
 * 落盘（见 packages/config/whitelist.ts 的 getEffectiveWhitelistPermissions）。
 * 其余身份的白名单成员关系与逐项权限才由 config/whitelist.json 管理。
 */
export const SUPER_ADMIN_USER_ID: number = ((): number => {
  const raw: string = requireEnv("SUPER_ADMIN_USER_ID");
  return parseTelegramUserId(raw, "SUPER_ADMIN_USER_ID");
})();
