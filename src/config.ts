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

/** 唯一免受 /copy 冷却限制、且可以使用 /kick 的用户 ID。 */
export const PRIVILEGED_USER_ID: number = Number(requireEnv("PRIVILEGED_USER_ID"));
