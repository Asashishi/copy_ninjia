/**
 * Central place for values that must not be hardcoded in source: secrets and
 * per-deployment settings. Populated from environment variables (Bun loads
 * `.env` automatically), never from a checked-in default.
 */

function requireEnv(name: string): string {
  const value: string | undefined = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

export const BOT_TOKEN: string = requireEnv("TELEGRAM_BOT_TOKEN");

/** The only user ID exempt from the /copy cooldown and allowed to use /kick. */
export const PRIVILEGED_USER_ID: number = Number(requireEnv("PRIVILEGED_USER_ID"));
