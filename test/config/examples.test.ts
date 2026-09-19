/**
 * `config_example/*.json` 必须能被自己那份严格解析器接受。
 *
 * install.sh 的「准备配置目录」一步把这些示例逐份复制成部署方的初始
 * `config/<name>.json`（agent.json、g-auth.json 与 cron.json 除外：agent.json 含故意不可用的
 * 占位凭据，由问卷生成；g-auth.json 只示意服务账号密钥的结构，由部署方带外放入真实密钥；
 * cron.json 只示意定时任务的写法，会话 id 与地址都是假的，本地来源也不存在）。
 * 因此示例一旦与解析器脱节，新装的部署会在第一次启动就按「不为用户行为兜底」
 * 拒绝启动，而全套门禁不会有任何反应——这里把示例本身纳入门禁。
 *
 * telegram.json 是唯一的例外：它的示例 token 就是占位符，**必须**被拒绝。
 * 那条断言同时把占位符字面量与 `TELEGRAM_BOT_TOKEN_PLACEHOLDER` 常量对拍，
 * 免得两边各自漂移（install.sh 里还有第三份，由
 * test/scripts/installScript.test.ts 覆盖）。
 */

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { loadAdSampleConfig } from "../../packages/config/adSamples";
import { parseCronConfig } from "../../packages/config/cron";
import { parseGoogleServiceAccountKey } from "../../packages/config/googleAuth";
import { loadMoodConfig } from "../../packages/config/mood";
import { loadStickerConfig } from "../../packages/config/stickers";
import { parseTelegramConfig } from "../../packages/config/telegramInput";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../../packages/consts/telegram";
import { readJsonInput } from "../../packages/libs/inputValidation";
import type { CronConfig, CronTask } from "../../packages/types/cron";

const EXAMPLE_ROOT: string = join(import.meta.dir, "..", "..", "config_example");

function examplePath(name: string): string {
  return join(EXAMPLE_ROOT, name);
}

/** install.sh 原样复制的三份示例，各自走自己的 load*（含读盘与严格解析）。 */
const COPIED_EXAMPLES: readonly (readonly [string, (path: string) => Promise<unknown>])[] = [
  ["stickers.json", loadStickerConfig],
  ["mood.json", loadMoodConfig],
  ["ad_samples.json", loadAdSampleConfig],
];

describe("config_example 与解析器保持同步", () => {
  for (const [name, load] of COPIED_EXAMPLES) {
    test(`${name} 能被自己的解析器接受`, async () => {
      // 不断言具体内容：示例值本就允许改，要守住的是「改完仍然解析得动」。
      expect(await load(examplePath(name))).toBeDefined();
    });
  }

  test("telegram.json 恰好因为占位 token 被拒绝，且占位符与常量一致", async () => {
    const raw: unknown = await readJsonInput(examplePath("telegram.json"));
    expect(raw).toMatchObject({ bot_token: TELEGRAM_BOT_TOKEN_PLACEHOLDER });

    const path: string = examplePath("telegram.json");
    const parse = (): unknown => parseTelegramConfig(raw, path);
    expect(parse).toThrow(
      `${path}: $.bot_token must be a configured non-placeholder string`
    );
    // 拒绝理由必须只是占位 token：把它换成真值后同一份示例要能解析通过，
    // 否则示例的其余字段（键集合、super_admin_user_id 形态）已经与解析器脱节。
    expect(
      parseTelegramConfig(
        { ...(raw as Readonly<Record<string, unknown>>), bot_token: "123456789:example" },
        path
      )
    ).toEqual({ botToken: "123456789:example", superAdminUserId: 123456789 });
  });

  test("g-auth.json 示例恰好因为占位私钥被拒绝，换成真实 RSA 私钥后其余字段形态被接受", async () => {
    const path: string = examplePath("g-auth.json");
    const raw: Readonly<Record<string, unknown>> =
      await readJsonInput(path) as Readonly<Record<string, unknown>>;
    expect((): unknown => parseGoogleServiceAccountKey(raw, path)).toThrow(
      `${path}: $.private_key must be a parseable non-empty PEM private key.`
    );
    const privateKey: string = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    expect(parseGoogleServiceAccountKey({ ...raw, private_key: privateKey }, path)).toBeDefined();
  });

  test("cron.json 示例能被严格解析，并覆盖字段、动作与来源的全部写法", async () => {
    // 只做纯解析：本地来源是否存在要到加载时才核对，示例里的路径都是假的。
    const path: string = examplePath("cron.json");
    const config: CronConfig = parseCronConfig(await readJsonInput(path), path);
    expect(config.some((entry: CronTask): boolean => entry.messageThreadId !== undefined)).toBe(true);
    expect(config.some((entry: CronTask): boolean => entry.timeZone !== "Asia/Tokyo")).toBe(true);
    expect(config.some((entry: CronTask): boolean => entry.cron.startsWith("@"))).toBe(true);
    expect(config.some((entry: CronTask): boolean => entry.justOnce)).toBe(true);
    expect(config.some((entry: CronTask): boolean => entry.chatId === "all")).toBe(true);
    // 区间写法与单值写法（等于 1m-<值>）各一。
    expect(config.some((entry: CronTask): boolean => entry.randomInterval !== undefined && entry.randomInterval.minMs > 60_000)).toBe(true);
    expect(config.some((entry: CronTask): boolean => entry.randomInterval?.minMs === 60_000)).toBe(true);
    const sources: Set<string> = new Set<string>();
    for (const entry of config) {
      for (const action of entry.actions) {
        if (action.type === "send_message") sources.add("send_message");
        else if (action.source.kind === "random") sources.add(`${action.type}:random:${action.source.directory === null ? "default" : "directory"}`);
        else sources.add(`${action.type}:${action.source.kind}`);
      }
    }
    expect([...sources].sort()).toEqual([
      "send_file:path",
      "send_file:url",
      "send_image:path",
      "send_image:random:default",
      "send_image:random:directory",
      "send_image:url",
      "send_message",
    ]);
  });

  test("agent.json 示例的六项能力形状被解析器接受", async () => {
    // 六份占位凭据各自被拒绝这一点由 test/config/agent.test.ts 覆盖；这里只
    // 补它没覆盖的另一半——示例自身的键集合与字段形态仍然合法。
    const { parseAgentDeploymentConfig } = await import("../../packages/config/agent");
    const raw: Readonly<{ agent: Readonly<Record<string, unknown>> }> =
      await readJsonInput(examplePath("agent.json")) as Readonly<{
        agent: Readonly<Record<string, unknown>>;
      }>;
    const withRealKeys: Record<string, unknown> = {};
    for (const [capability, config] of Object.entries(raw.agent)) {
      withRealKeys[capability] = {
        ...(config as Readonly<Record<string, unknown>>),
        api_key: `real-${capability}-key`,
      };
    }
    expect(parseAgentDeploymentConfig(withRealKeys, "agent.json")).toBeDefined();
  });
});
