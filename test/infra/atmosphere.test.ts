import { afterEach, expect, test } from "bun:test";
import { botAtmosphereState } from "../../packages/cache/main/atmosphere";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { botAtmosphere, chatAtmosphere } from "../../packages/infra/atmosphere";
import type { Atmosphere } from "../../packages/types/atmosphere";

// preload 已按部署缺省接管本进程风格；本文件临时改写 holder，跑完必须还原。
const PRELOADED_ATMOSPHERE: Atmosphere | null = botAtmosphereState.current;

afterEach(() => { botAtmosphereState.current = PRELOADED_ATMOSPHERE; });

test("主线程按启动总闸接管的本进程风格选文案，读取复用常量表", () => {
  for (const atmosphere of ["teasing", "plain"] as readonly Atmosphere[]) {
    botAtmosphereState.current = atmosphere;
    expect(botAtmosphere()).toBe(atmosphere);
    expect(chatAtmosphere()).toBe(ATMOSPHERE_TEXTS[atmosphere]);
  }
});

test("启动总闸完成前读取风格是接线错误，不回退到任何缺省风格", () => {
  botAtmosphereState.current = null;
  expect(() => chatAtmosphere()).toThrow("Bot atmosphere was not initialized by the deployment input preflight.");
});
