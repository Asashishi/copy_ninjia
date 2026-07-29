/**
 * 按功能聚合的部署配置可用性判定。这些结论替代了原来在 ApplicationLifecycle
 * 里统一预热的那四次调用：坏掉的文件只能关掉自己那个功能，不能拦住启动。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigReadiness } from "../../packages/types/config";

const authFilePath: string = join(mkdtempSync(join(tmpdir(), "copy-ninjia-readiness-")), "g-auth.json");

let stickerFailure: string | null = null;
let reactionFailure: string | null = null;
let moodFailure: string | null = null;
let adSampleFailure: string | null = null;

function loaderOf(failure: () => string | null): () => object {
  return (): object => {
    const message: string | null = failure();
    if (message !== null) throw new Error(message);
    return {};
  };
}

mock.module("../../packages/consts/paths", () => ({ GOOGLE_AUTH_FILE_PATH: authFilePath }));
mock.module("../../packages/config/stickers", () => ({ getStickerConfig: loaderOf((): string | null => stickerFailure) }));
mock.module("../../packages/config/reactions", () => ({ getReactionConfig: loaderOf((): string | null => reactionFailure) }));
mock.module("../../packages/config/mood", () => ({ getMoodConfig: loaderOf((): string | null => moodFailure) }));
mock.module("../../packages/config/adSamples", () => ({ getAdSampleConfig: loaderOf((): string | null => adSampleFailure) }));

const { adDetectConfigReadiness, aiChatConfigReadiness, jaTranslateConfigReadiness } =
  await import("../../packages/config/readiness");
const {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  jaTranslateConfigReadinessCache,
} = await import("../../packages/cache/config");

function writeAuthFile(content: string): void {
  writeFileSync(authFilePath, content, "utf8");
}

beforeEach(() => {
  stickerFailure = null;
  reactionFailure = null;
  moodFailure = null;
  adSampleFailure = null;
  aiChatConfigReadinessCache.current = null;
  adDetectConfigReadinessCache.current = null;
  jaTranslateConfigReadinessCache.current = null;
  writeAuthFile(JSON.stringify({ client_email: "bot@example.iam.gserviceaccount.com", private_key: "-----BEGIN-----" }));
});

describe("deployment config readiness", () => {
  test("三份都读得动时 AI 闲聊放行；广告示例独立成一份结论", () => {
    expect(aiChatConfigReadiness()).toEqual({ ok: true });
    expect(adDetectConfigReadiness()).toEqual({ ok: true });
  });

  test("AI 闲聊按声明顺序报第一份坏掉的文件，诊断带上解析器原话", () => {
    reactionFailure = "Invalid reactions config: boom";
    moodFailure = "Invalid mood config: also broken";

    const verdict: ConfigReadiness = aiChatConfigReadiness();
    if (verdict.ok) throw new Error("expected a failure verdict");
    // 一次只点名一份：三份一起报，运维照着改完第一份还是开不起来，
    // 反而看不出到底轮到哪一份了。
    expect(verdict.failure.file).toBe("config/reactions.json");
    expect(verdict.failure.reason).toBe("Invalid reactions config: boom");
  });

  test("某个功能的配置坏掉不影响另一个功能的结论", () => {
    adSampleFailure = "Invalid ad samples config: boom";

    expect(aiChatConfigReadiness()).toEqual({ ok: true });
    expect(adDetectConfigReadiness().ok).toBe(false);
  });

  test("失败结论也进缓存：门禁挂在每条群消息上，不能每次重新读盘", () => {
    stickerFailure = "Invalid stickers config: boom";
    expect(aiChatConfigReadiness().ok).toBe(false);

    // 文件修好了也要重启才生效，与底层 loader 的单例缓存同一口径（拒绝文案
    // 里点明了「修好再重启」）。
    stickerFailure = null;
    expect(aiChatConfigReadiness().ok).toBe(false);
  });

  test("服务账号密钥：缺文件、非对象、字段空缺都算不可用", () => {
    writeAuthFile("{ not json");
    expect(jaTranslateConfigReadiness().ok).toBe(false);

    jaTranslateConfigReadinessCache.current = null;
    writeAuthFile(JSON.stringify(["client_email"]));
    const notObject: ConfigReadiness = jaTranslateConfigReadiness();
    if (notObject.ok) throw new Error("expected a failure verdict");
    expect(notObject.failure.file).toBe("g-auth.json");
    expect(notObject.failure.reason).toContain("expected a JSON object");

    // 只判「文件在不在」不够：占位内容同样能通过，然后每条 /ja_copy 都静默
    // 退化成原文照发，群里看不出与「翻译服务抖了一下」的区别。
    jaTranslateConfigReadinessCache.current = null;
    writeAuthFile(JSON.stringify({ client_email: "bot@example.com", private_key: "   " }));
    const blankKey: ConfigReadiness = jaTranslateConfigReadiness();
    if (blankKey.ok) throw new Error("expected a failure verdict");
    expect(blankKey.failure.reason).toContain("private_key");
  });
});
