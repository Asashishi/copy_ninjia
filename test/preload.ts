import { afterAll } from "bun:test";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
// 必须排在下面那条生产 import 之前：它负责在 consts/paths 求值之前注入两个
// 根目录（见 test/preloadEnv.ts 的说明）。
import { PREVIOUS_CONFIG_ROOT, PREVIOUS_DATA_ROOT, TEST_DATA_ROOT } from "./preloadEnv";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../packages/consts/environment";
import {
  adoptAdDetectAgentConfig,
  adoptAgentDeploymentConfig,
  parseAdDetectAgentConfig,
  parseAgentDeploymentConfig,
} from "../packages/config/agent";
import { adoptAdSampleConfig, parseAdSampleConfig } from "../packages/config/adSamples";
import { adoptMoodConfig, parseMoodConfig } from "../packages/config/mood";
import { adoptPersona } from "../packages/config/persona";
import { parseBotConfig } from "../packages/config/botInput";
import type { BotConfig } from "../packages/types/config";
import { adoptTimeZone } from "../packages/config/time";
import { botAtmosphereState } from "../packages/cache/main/atmosphere";
import { DEFAULT_AI_PERSONA } from "../packages/consts/aiChat/prompts/persona";
import { BOT_ATMOSPHERES, DEFAULT_BOT_ATMOSPHERE } from "../packages/consts/bot";
import { adoptStickerConfig, parseStickerConfig } from "../packages/config/stickers";
import { adoptCronConfig, parseCronConfig } from "../packages/config/cron";
import {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  translateConfigReadinessCache,
} from "../packages/cache/main/configReadiness";
import {
  IDENTITY_DATABASE_DIRECTORY_MODE,
  IDENTITY_DATABASE_FILE_MODE,
} from "../packages/consts/identityStorage";
import {
  DATABASE_DIR,
  IDENTITY_DATABASE_PATH,
  AD_SAMPLES_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  CRON_CONFIG_PATH,
  BOT_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
} from "../packages/consts/paths";
import { seedStorageDatabase } from "../scripts/fixtures/storageDatabase";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../packages/database/interact/connection";
import { storageMetadataRows } from "../packages/database/interact/initialization";
import { createStorageDatabase } from "../packages/database/interact/migration";
import type { StorageDatabase } from "../packages/types/storageDatabase";

// 部署配置快照只由主线程读盘：真实进程里主线程解析后，再经 AI Worker 的
// init/configReload 与 Anti-Raid Worker 的 agentConfig 消息投递给两条业务
// 线程（见 packages/config/agent.ts 的边界说明）。测试 isolate 收不到那两条
// 消息，这里把同一份 config_example/dynamic/agent.json adopt 进本 isolate 的
// holder，等价于「快照已经送到」。临时副本里的凭据是测试专用值；需要验证
// 「没配」的用例自行把 holder 置空。
// 顶层 await：Bun 的 preload 会等本模块的续体跑完再开始跑测试文件；
// preloadEnv.ts 必须同步，理由见那一份的头注。
const agentDocument = JSON.parse(
  await Bun.file(AGENT_CONFIG_PATH).text()
) as { agent: Record<string, unknown> };
adoptAgentDeploymentConfig(parseAgentDeploymentConfig(agentDocument.agent));
adoptAdDetectAgentConfig(parseAdDetectAgentConfig(agentDocument.agent.ad_detect));
adoptAdSampleConfig(parseAdSampleConfig(JSON.parse(await Bun.file(AD_SAMPLES_CONFIG_PATH).text())));
adoptMoodConfig(parseMoodConfig(JSON.parse(await Bun.file(MOOD_CONFIG_PATH).text())));
adoptStickerConfig(parseStickerConfig(JSON.parse(await Bun.file(STICKERS_CONFIG_PATH).text())));
// 人设与本进程通知风格成对接管：内置人设加 Bot 显式语气，缺省时使用默认风格。
// 启动总闸见到已接管的风格即短路，不读开发机工作树里的 prompt/persona.md 与 prompt/voice_tool.md；
// send_voice 说明 holder 保持 null，按 bot_language 取内置文案。
adoptPersona(DEFAULT_AI_PERSONA);
const botConfig: BotConfig = parseBotConfig(await Bun.file(BOT_CONFIG_PATH).json());
botAtmosphereState.current = BOT_ATMOSPHERES[botConfig.atmosphere ?? DEFAULT_BOT_ATMOSPHERE];
adoptTimeZone(botConfig.timeZone);

// 每个测试进程用独立数据根创建空库，时区标记取本 isolate 刚接管的配置时区；
// 生产运行期仍只接受迁移脚本建好的数据库。
mkdirSync(DATABASE_DIR, {
  recursive: true,
  mode: IDENTITY_DATABASE_DIRECTORY_MODE,
});
chmodSync(DATABASE_DIR, IDENTITY_DATABASE_DIRECTORY_MODE);
createStorageDatabase(IDENTITY_DATABASE_PATH);
const identityDatabase: StorageDatabase = openStorageDatabase({
  path: IDENTITY_DATABASE_PATH,
});
seedStorageDatabase(identityDatabase, {
  metadata: storageMetadataRows(botConfig.timeZone),
  whitelist: [],
  blocklist: [],
  removals: [],
});
closeStorageDatabase(identityDatabase);
chmodSync(IDENTITY_DATABASE_PATH, IDENTITY_DATABASE_FILE_MODE);

adoptCronConfig(parseCronConfig(JSON.parse(await Bun.file(CRON_CONFIG_PATH).text())));
aiChatConfigReadinessCache.current = { ok: true };
adDetectConfigReadinessCache.current = { ok: true };
translateConfigReadinessCache.current = { ok: true };

afterAll(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  if (PREVIOUS_DATA_ROOT === undefined) delete process.env[RUNTIME_DATA_ROOT_ENV];
  else process.env[RUNTIME_DATA_ROOT_ENV] = PREVIOUS_DATA_ROOT;
  if (PREVIOUS_CONFIG_ROOT === undefined) delete process.env[CONFIG_ROOT_ENV];
  else process.env[CONFIG_ROOT_ENV] = PREVIOUS_CONFIG_ROOT;
});
