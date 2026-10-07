/**
 * `prompt_example/` 下的提示词示例能被启动总闸的同一读取器接受，并写全 send_voice 的执行约定。
 *
 * 部署方把示例复制成 `prompt/persona.md`、`prompt/voice_tool.md` 后，启动总闸按
 * `loadPromptFile` 严格读取；voice_tool.md 整份替换内置 send_voice 说明，额度指引、每轮条数与
 * text / tone 长度上限由文件自己写明，这里把这些取值与代码常量对拍。示例台词语言跟随
 * `config_example/dynamic/agent.json` 的 `agent.tts.bot_language`。
 */

import { describe, expect, test } from "bun:test";
import { basename, join, relative } from "node:path";
import { loadPromptFile } from "../../packages/config/promptFile";
import { MAX_VOICES_PER_REPLY, VOICE_TEXT_MAX_CHARS, VOICE_TONE_MAX_CHARS } from "../../packages/consts/aiChat/voiceMessage";
import { TOOL_STATUS_POINTER, VOICE_LANGUAGE_PROMPTS } from "../../packages/consts/aiChat/prompts/tools";
import { AGENT_CONFIG_PATH, CONFIG_ROOT, PERSONA_PATH, VOICE_TOOL_PROMPT_PATH } from "../../packages/consts/paths";
import { SEND_VOICE_TOOL } from "../../packages/consts/tools";
import { readJsonInput } from "../../packages/libs/inputValidation";
import type { TtsBotLanguage } from "../../packages/types/config";

const REPOSITORY_ROOT: string = join(import.meta.dir, "..", "..");
const PROMPT_EXAMPLE_ROOT: string = join(REPOSITORY_ROOT, "prompt_example");
const PERSONA_EXAMPLE_PATH: string = join(PROMPT_EXAMPLE_ROOT, basename(PERSONA_PATH));
const VOICE_TOOL_EXAMPLE_PATH: string = join(PROMPT_EXAMPLE_ROOT, basename(VOICE_TOOL_PROMPT_PATH));

describe("prompt_example 与启动读取器保持同步", () => {
  for (const examplePath of [PERSONA_EXAMPLE_PATH, VOICE_TOOL_EXAMPLE_PATH]) {
    test(`${basename(examplePath)} 能被 loadPromptFile 接受`, async () => {
      const content: string = await loadPromptFile(examplePath);
      expect(content).toBe((await Bun.file(examplePath).text()).trim());
    });
  }

  test("voice_tool.md 示例写明额度指引、每轮条数与 text / tone 长度上限", async () => {
    const content: string = await loadPromptFile(VOICE_TOOL_EXAMPLE_PATH);
    expect(content).toContain(`${TOOL_STATUS_POINTER}里 ${SEND_VOICE_TOOL} 那一行`);
    expect(content).toContain(`每轮最多 ${MAX_VOICES_PER_REPLY} 条`);
    expect(content).toContain(`emoji，不超过 ${VOICE_TEXT_MAX_CHARS} 字`);
    expect(content).toContain(`来定，不超过 ${VOICE_TONE_MAX_CHARS} 字`);
  });

  test("voice_tool.md 示例的台词语言与 config_example 的 bot_language 一致", async () => {
    const agentExamplePath: string = join(REPOSITORY_ROOT, "config_example", relative(CONFIG_ROOT, AGENT_CONFIG_PATH));
    const raw: Readonly<{ agent: Readonly<{ tts: Readonly<{ bot_language: TtsBotLanguage }> }> }> =
      await readJsonInput(agentExamplePath) as Readonly<{ agent: Readonly<{ tts: Readonly<{ bot_language: TtsBotLanguage }> }> }>;
    const builtIn: string = VOICE_LANGUAGE_PROMPTS[raw.agent.tts.bot_language].sendVoiceInstruction;
    const firstSentence: string = builtIn.slice(0, builtIn.indexOf("。") + 1);
    expect(firstSentence.length).toBeGreaterThan(1);
    expect((await loadPromptFile(VOICE_TOOL_EXAMPLE_PATH)).startsWith(firstSentence)).toBe(true);
  });
});
