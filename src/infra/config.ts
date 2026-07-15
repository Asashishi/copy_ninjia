/**
 * 集中存放不应硬编码在源码里的值：密钥和每次部署都不同的配置。
 * 从环境变量读取（Bun 会自动加载 `.env`），绝不使用写死在代码里的默认值。
 */

function requireEnv(name: string): string {
  const value: string | undefined = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

export const BOT_TOKEN: string = requireEnv("TELEGRAM_BOT_TOKEN");

/** xAI (Grok) API 密钥，供 AI 闲聊回复/图片理解功能（src/workers/aiChatWorker.ts、src/ai/）调用。 */
export const XAI_API_KEY: string = requireEnv("XAI_API_KEY");

/** 免受 /copy 冷却限制、且可以使用 /kick 的用户 ID 白名单（逗号分割）。 */
export const PRIVILEGED_USERS_ID: number[] = requireEnv("PRIVILEGED_USERS_ID")
  .split(",")
  .map((part: string) => part.trim())
  .filter((part: string) => part.length > 0)
  .map((part: string) => {
    const id: number = Number(part);
    if (!Number.isInteger(id)) {
      throw new Error(`Invalid user ID in PRIVILEGED_USERS_ID: "${part}" (see .env.example)`);
    }
    return id;
  });

/** 唯一可使用 /ai_chat、/ja_copy enable|disable、/init enable|disable 的用户 ID——独立一批权限，不走 PRIVILEGED_USERS_ID 白名单。 */
export const SUPER_ADMIN_USER_ID: number = (() => {
  const raw: string = requireEnv("SUPER_ADMIN_USER_ID");
  const id: number = Number(raw);
  if (!Number.isInteger(id)) {
    throw new Error(`Invalid user ID in SUPER_ADMIN_USER_ID: "${raw}" (see .env.example)`);
  }
  return id;
})();
