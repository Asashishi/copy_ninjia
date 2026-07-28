/**
 * 集中存放不应硬编码在源码里的值：密钥和每次部署都不同的配置。
 * 从环境变量读取（Bun 会自动加载 `.env`），绝不使用写死在代码里的默认值。
 */

import { parseTelegramUserId, parseTelegramUserIdList } from "../libs/runtimeConfig";

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
 * （packages/workers/aiChatWorker.ts、packages/ai/gemini.ts）。与广告检测的
 * DEEPSEEK_API_KEY 职责不重叠，两条线各用各的凭据，互不回退。
 */
export const GEMINI_API_KEY: string = requireEnv("GEMINI_API_KEY");

/**
 * DeepSeek API 密钥（OpenAI 兼容接口），广告检测独占：入群守卫线程里的判定
 * （packages/workers/antiRaid/adDetect/）。AI 闲聊一律走 Gemini，不会用到它。
 *
 * 可选。广告检测是按群 opt-in、缺省关闭的附加功能，缺这把密钥不该让 copy、
 * 抽奖、入群验证、黑名单一起起不来。未配置时 /ad_detect enable 直接拒绝
 * （packages/commands/adDetect.ts），已经开着的群也不再投递待检消息
 * （packages/antiRaid/adDetect.ts 的 buildAdCandidate）。
 */
export const DEEPSEEK_API_KEY: string | undefined = optionalEnv("DEEPSEEK_API_KEY");

/**
 * 免受 /copy 冷却限制、可使用 /block，且可为其他机器人代点入群验证的
 * 用户 ID 白名单（逗号分割）；真人验证始终只能由本人点击。
 */
export const PRIVILEGED_USERS_ID: readonly number[] = parseTelegramUserIdList(requireEnv("PRIVILEGED_USERS_ID", true), "PRIVILEGED_USERS_ID");

/** 唯一可使用 /ai_chat、/ja_copy enable|disable、/init enable|disable、/ad_detect enable|disable 的用户 ID——独立一批权限，不走 PRIVILEGED_USERS_ID 白名单。 */
export const SUPER_ADMIN_USER_ID: number = ((): number => {
  const raw: string = requireEnv("SUPER_ADMIN_USER_ID");
  return parseTelegramUserId(raw, "SUPER_ADMIN_USER_ID");
})();
