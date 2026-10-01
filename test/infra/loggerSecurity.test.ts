import { expect, spyOn, test } from "bun:test";
import { logger } from "../../packages/infra/logger";
import { restoreDefaultProfilePhoto } from "../../packages/infra/telegram/avatar/restore";
import { agentDeploymentConfigCache } from "../../packages/cache/perThread/config";
import { loggerSecretsMemo } from "../../packages/cache/perThread/logger";
import { parseAgentDeploymentConfig } from "../../packages/config/agent";
import { AVATAR_FETCH_MAX_ATTEMPTS } from "../../packages/consts/telegram";
import { REDACTED_SECRET } from "../../packages/consts/redaction";
import type { AgentDeploymentConfig } from "../../packages/types/config";
import type { LoggerSecretsSnapshot } from "../../packages/types/logger";

/** 严格解析含自定义鉴权头的测试配置；只替换线程内 holder，不写部署文件。 */
function credentialConfig(secret: string): AgentDeploymentConfig {
  const capability: Readonly<{
    provider: string; model: string; api_key: string; headers: Readonly<Record<string, string>>;
  }> = { provider: "google", model: "mock", api_key: "test-security-api-key", headers: { "x-upstream-auth": secret } };
  return parseAgentDeploymentConfig({ text: capability, summary: capability, media: capability });
}

test("头像下载异常的 path、message、stack、cause 与重定向 URL 均经过真实 logger 脱敏", async (): Promise<void> => {
  const url: string = "https://bucket.example/avatar.png?X-Amz-Signature=test-signature#test-fragment";
  const redirected: string = "https://test-user:test-password@cdn.example/avatar.png?X-Amz-Signature=test-redirect-signature";
  const cause: Error = Object.assign(new Error(`redirect ${redirected}`), { path: redirected });
  const error: TypeError & { path: string; code: string } = Object.assign(new TypeError(`fetch ${url} failed`, { cause }), {
    path: url, code: "ECONNRESET",
  });
  const consoleError = spyOn(console, "error").mockImplementation((): void => {});
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(error);
  try {
    await expect(restoreDefaultProfilePhoto({ kind: "url", url })).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(AVATAR_FETCH_MAX_ATTEMPTS);
    const serialized: string = JSON.stringify(consoleError.mock.calls);
    for (const secret of ["test-signature", "test-fragment", "test-redirect-signature", "test-user", "test-password"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(consoleError.mock.calls[0]![1]).toMatchObject({
      name: "TypeError", code: error.code, path: "https://bucket.example/avatar.png",
      cause: { path: "https://cdn.example/avatar.png" },
    });
    expect(error.path).toBe(url);
  } finally { fetchMock.mockRestore(); consoleError.mockRestore(); }
});

test("JSON 转义凭据覆盖真实 logger 的文本、Error、嵌套 cause、对象值与键", (): void => {
  const original: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
  const secret: string = 'test-"quoted"\\header-secret';
  const consoleError = spyOn(console, "error").mockImplementation((): void => {});
  agentDeploymentConfigCache.current = credentialConfig(secret);
  try {
    expect(new Headers({ "x-upstream-auth": secret }).get("x-upstream-auth")).toBe(secret);
    logger.error(`echo ${secret}`);
    logger.error(new Error(`echo ${secret}`, { cause: new Error(`cause ${secret}`) }));
    logger.error({ [secret]: secret, nested: { diagnostic: secret } });
    expect(consoleError.mock.calls[0]![0]).toBe(`echo ${REDACTED_SECRET}`);
    expect(consoleError.mock.calls[1]![0]).toMatchObject({
      message: `echo ${REDACTED_SECRET}`, cause: { message: `cause ${REDACTED_SECRET}` },
    });
    expect(consoleError.mock.calls[2]![0]).toEqual({
      [REDACTED_SECRET]: REDACTED_SECRET, nested: { diagnostic: REDACTED_SECRET },
    });
    const snapshot: LoggerSecretsSnapshot = loggerSecretsMemo.current!;
    logger.error("same config");
    expect(loggerSecretsMemo.current).toBe(snapshot);
    const assertReadonly: () => void = (): void => {
      // @ts-expect-error 凭据快照禁止调用方替换名单。
      snapshot.text = [];
      // @ts-expect-error JSON 转义片段禁止调用方追加。
      snapshot.json.push("unexpected");
      // @ts-expect-error 配置身份引用随快照整体替换，调用方不能就地改写。
      snapshot.telegram = null;
    };
    void assertReadonly;
  } finally { agentDeploymentConfigCache.current = original; consoleError.mockRestore(); }
});

test("已登记凭据在 URL 规范化前脱敏，原文与百分号编码均不进入输出", (): void => {
  const original: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
  const secret: string = "test-header-{credential}";
  const url: string = `https://bucket.example/${secret}?trace=mock`;
  const consoleError = spyOn(console, "error").mockImplementation((): void => {});
  agentDeploymentConfigCache.current = credentialConfig(secret);
  try {
    expect(new Headers({ "x-upstream-auth": secret }).get("x-upstream-auth")).toBe(secret);
    logger.error(url);
    logger.error({ diagnostic: url });
    logger.error(Object.assign(new Error(`fetch ${url}`), { path: url }));
    const serialized: string = JSON.stringify(consoleError.mock.calls);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(encodeURIComponent(secret));
    expect(consoleError.mock.calls[1]![0]).toEqual({ diagnostic: `https://bucket.example/${REDACTED_SECRET}` });
    expect(consoleError.mock.calls[2]![0]).toMatchObject({ path: `https://bucket.example/${REDACTED_SECRET}` });
  } finally { agentDeploymentConfigCache.current = original; consoleError.mockRestore(); }
});

test("合法 URL 路径含单引号时也完整移除预签名查询串", (): void => {
  const url: string = new URL("https://bucket.example/that's/avatar.png?X-Amz-Signature=test-quoted-path-signature").href;
  const consoleError = spyOn(console, "error").mockImplementation((): void => {});
  try {
    logger.error(Object.assign(new Error(`fetch ${url}`), { path: url }));
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("test-quoted-path-signature");
    expect(consoleError.mock.calls[0]![0]).toMatchObject({ path: "https://bucket.example/that's/avatar.png" });
  } finally { consoleError.mockRestore(); }
});

test("配置替换后的旧转义凭据继续脱敏，序列化重入使用各自的只读快照", (): void => {
  const original: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
  const oldSecret: string = 'test-old-"quoted"\\secret';
  const newSecret: string = 'test-new-"quoted"\\secret';
  const consoleError = spyOn(console, "error").mockImplementation((): void => {});
  const consoleInfo = spyOn(console, "info").mockImplementation((): void => {});
  agentDeploymentConfigCache.current = credentialConfig(oldSecret);
  try {
    logger.error("capture config");
    const value: { readonly diagnostic: string } = {
      get diagnostic(): string {
        agentDeploymentConfigCache.current = credentialConfig(newSecret);
        logger.info(`nested ${newSecret}`);
        return oldSecret;
      },
    };
    logger.error(value);
    expect(consoleInfo.mock.calls[0]![0]).toBe(`nested ${REDACTED_SECRET}`);
    expect(consoleError.mock.calls.at(-1)![0]).toEqual({ diagnostic: REDACTED_SECRET });
    logger.error(new Error(`retired ${oldSecret}; current ${newSecret}`));
    expect(consoleError.mock.calls.at(-1)![0]).toMatchObject({
      message: `retired ${REDACTED_SECRET}; current ${REDACTED_SECRET}`,
    });
  } finally { agentDeploymentConfigCache.current = original; consoleInfo.mockRestore(); consoleError.mockRestore(); }
});
