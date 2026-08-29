import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  cleanupFixtures,
  createFixture,
  readText,
  runInstaller,
  systemdPrompt,
  validTelegram,
  writeText,
} from "./installIsolation/fixture";
import type {
  InstallerFixture,
  InstallerRunResult,
} from "./installIsolation/fixture";

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assertCondition(Object.is(actual, expected), message);
}

function assertContains(value: string, expected: string, message: string): void {
  assertCondition(value.includes(expected), message);
}

async function checkTelegramRollback(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  mkdirSync(fixture.configRoot);
  const telegramPath: string = join(fixture.configRoot, "telegram.json");
  const original: string = validTelegram();
  await writeText(telegramPath, original, 0o640);
  const result: InstallerRunResult = runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "y" },
    { prompt: "Telegram bot token", reply: "987654321:new_test_token", secret: true },
    { prompt: "超级管理员用户 ID", reply: "987654321" },
  ], {
    FAKE_BACKUP_PRESERVE_FAIL: "1",
    FAKE_TELEGRAM_VALIDATION_FAIL: "1",
  });

  assertCondition(result.exitCode !== 0, "Telegram 候选配置校验失败时安装器必须失败");
  assertEqual(await readText(telegramPath), original, "Telegram 原配置不得改变");
  assertEqual(statSync(telegramPath).mode & 0o777, 0o640, "Telegram 原权限不得改变");
  const backupDirectories: readonly string[] = readdirSync(fixture.backupRoot);
  assertEqual(backupDirectories.length, 1, "必须生成一份外部配置备份");
  const backupName: string | undefined = backupDirectories[0];
  assertCondition(backupName !== undefined, "外部配置备份目录缺失");
  const backupDirectory: string = join(fixture.backupRoot, backupName);
  assertEqual(
    await readText(join(backupDirectory, "original-0.json")),
    original,
    "外部备份内容必须与原配置一致"
  );
  const manifest: string = await readText(join(backupDirectory, "manifest.tsv"));
  assertContains(manifest, "config/telegram.json\tmode=640", "备份清单必须记录路径与权限");
  assertCondition(/sha256=[0-9a-f]{64}/.test(manifest), "备份清单必须记录 SHA-256");
  assertContains(await readText(fixture.callLog), "cp-preserve=failure", "属主保留失败分支必须实测");
  assertCondition(
    !readdirSync(fixture.configRoot).some(
      (name: string): boolean => name.includes(".install.")
    ),
    "校验失败后不得残留候选配置"
  );
}

async function checkStagingPermissionFailureCleanup(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  const result: InstallerRunResult = runInstaller(
    fixture,
    [],
    { FAKE_STAGING_CHMOD_FAIL: "1" }
  );
  assertCondition(result.exitCode !== 0, "候选文件权限收紧失败时安装器必须失败");
  assertCondition(
    readdirSync(fixture.configRoot).every((name: string): boolean => !name.includes(".install.")),
    "权限收紧失败也必须由 EXIT trap 清理候选文件"
  );
}

async function checkInterruptedResume(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  mkdirSync(fixture.configRoot);
  await writeText(join(fixture.configRoot, "telegram.json"), validTelegram(), 0o600);
  const interrupted: InstallerRunResult = runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "n" },
    { prompt: "现在配置 AI 能力", close: true },
  ]);
  assertCondition(interrupted.exitCode !== 0, "步骤 6 输入中断时安装器必须失败");
  assertCondition(
    !existsSync(join(fixture.configRoot, "agent.json")),
    "步骤 6 中断不得物化 agent 示例"
  );

  const resumed: InstallerRunResult = runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "n" },
    { prompt: "现在配置 AI 能力", reply: "n" },
    systemdPrompt(),
  ]);
  assertEqual(resumed.exitCode, 0, "中断后重跑并跳过 AI 配置必须成功");
  assertContains(resumed.output, "现在配置 AI 能力", "重跑必须进入 AI 配置步骤");
  assertCondition(
    !existsSync(join(fixture.configRoot, "agent.json")),
    "跳过 AI 配置不得物化 agent 示例"
  );
}

async function checkSuccessfulReplacement(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  mkdirSync(fixture.configRoot);
  const telegramPath: string = join(fixture.configRoot, "telegram.json");
  await writeText(telegramPath, validTelegram(), 0o640);
  const originalOwner: ReturnType<typeof statSync> = statSync(telegramPath);
  const replacementToken: string = "987654321:replacement_test_token";
  const result: InstallerRunResult = runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "y" },
    { prompt: "Telegram bot token", reply: replacementToken, secret: true },
    { prompt: "超级管理员用户 ID", reply: "987654321" },
    { prompt: "现在配置 AI 能力", reply: "n" },
    systemdPrompt(),
  ]);

  assertEqual(result.exitCode, 0, "Telegram 配置原子替换与后续核验必须成功");
  assertContains(await readText(telegramPath), replacementToken, "提交后必须读取到完整新配置");
  const replacementStats: ReturnType<typeof statSync> = statSync(telegramPath);
  assertEqual(replacementStats.mode & 0o777, 0o600, "新配置权限必须为 0600");
  assertEqual(replacementStats.uid, originalOwner.uid, "原子替换必须保持既有配置属主");
  assertEqual(replacementStats.gid, originalOwner.gid, "原子替换必须保持既有配置属组");
  const exampleMode: number = statSync(
    join(fixture.worktree, "config_example", "reactions.json")
  ).mode & 0o777;
  const deployedExampleMode: number = statSync(
    join(fixture.configRoot, "reactions.json")
  ).mode & 0o777;
  assertEqual(
    deployedExampleMode,
    exampleMode & (~0o022 & 0o777),
    "新建示例配置必须保持原有 cp 的权限语义"
  );
  assertCondition(!result.output.includes(replacementToken), "安装输出不得回显 Telegram token");
  const calls: string = await readText(fixture.callLog);
  const outbound: string = await readText(fixture.outboundLog);
  if (calls.includes("systemctl-secret-env=")) {
    assertContains(calls, "systemctl-secret-env=absent", "systemd 环境不得含 AI 凭据");
    assertContains(outbound, "systemctl:guarded:restart", "配置变化后必须重启既有服务");
    assertEqual(readdirSync(fixture.backupRoot).length, 0, "稳定性核验通过后必须清理外部备份");
  } else {
    assertContains(calls, "start-secret-env=absent", "前台启动环境不得含 AI 凭据");
    assertEqual(readdirSync(fixture.backupRoot).length, 1, "前台启动无法观察稳定性，必须保留备份");
  }
}

async function checkSymlinkTopologyPreserved(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  mkdirSync(fixture.configRoot);
  const linkedDirectory: string = join(fixture.root, "linked-config");
  mkdirSync(linkedDirectory);
  const realTelegramPath: string = join(linkedDirectory, "telegram.json");
  const telegramPath: string = join(fixture.configRoot, "telegram.json");
  await writeText(realTelegramPath, validTelegram(), 0o640);
  symlinkSync(realTelegramPath, telegramPath);
  const replacementToken: string = "987654321:symlink_test_token";
  const result: InstallerRunResult = runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "y" },
    { prompt: "Telegram bot token", reply: replacementToken, secret: true },
    { prompt: "超级管理员用户 ID", reply: "987654321" },
    { prompt: "现在配置 AI 能力", reply: "n" },
    systemdPrompt(),
  ]);

  assertEqual(result.exitCode, 0, "软链接配置的原子替换必须成功");
  assertCondition(lstatSync(telegramPath).isSymbolicLink(), "配置软链接拓扑不得被替换");
  assertContains(await readText(realTelegramPath), replacementToken, "软链接实际目标必须更新");
  assertEqual(statSync(realTelegramPath).mode & 0o777, 0o600, "软链接实际目标权限必须为 0600");
  assertCondition(
    !(await readText(fixture.outboundLog)).includes(":blocked"),
    "软链接实测不得调用真实外部命令"
  );
}

async function checkUnverifiedJournalBackupRetention(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  mkdirSync(fixture.configRoot);
  const telegramPath: string = join(fixture.configRoot, "telegram.json");
  await writeText(telegramPath, validTelegram(), 0o600);
  const result: InstallerRunResult = runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "y" },
    { prompt: "Telegram bot token", reply: "987654321:journal_test_token", secret: true },
    { prompt: "超级管理员用户 ID", reply: "987654321" },
    { prompt: "现在配置 AI 能力", reply: "n" },
    systemdPrompt(),
  ], { FAKE_JOURNAL_FAIL: "1" });

  assertEqual(result.exitCode, 0, "journal 不可读时服务状态核验仍按既有降级语义完成");
  const calls: string = await readText(fixture.callLog);
  if (calls.includes("systemctl-secret-env=")) {
    assertContains(result.output, "journal 未能核对", "journal 失败必须明确降级而非伪报成功");
  }
  assertEqual(readdirSync(fixture.backupRoot).length, 1, "journal 未确认时必须保留外部备份");
}

async function checkCredentialIsolation(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  mkdirSync(fixture.configRoot);
  await writeText(join(fixture.configRoot, "telegram.json"), validTelegram(), 0o600);
  const apiKey: string = "test key with spaces, quote-\" and 日本語";
  const result: InstallerRunResult = runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "n" },
    { prompt: "现在配置 AI 能力", reply: "y" },
    { prompt: "配置 ad_detect？", reply: "y" },
    { prompt: "ad_detect 的 provider", reply: "openai" },
    { prompt: "ad_detect 的 api_key", reply: apiKey, secret: true },
    { prompt: "ad_detect 的 model", reply: "mock-model" },
    { prompt: "ad_detect 的 base_url", reply: "" },
    { prompt: "配置 text？", reply: "n" },
    { prompt: "配置 summary？", reply: "n" },
    { prompt: "配置 media？", reply: "n" },
    { prompt: "配置 image？", reply: "n" },
    { prompt: "配置 song？", reply: "n" },
    systemdPrompt(),
  ]);

  assertEqual(result.exitCode, 0, "包含特殊字符的 AI 凭据必须完成配置");
  const agentConfig: string = await readText(join(fixture.configRoot, "agent.json"));
  assertContains(agentConfig, JSON.stringify(apiKey), "AI 凭据必须无损写入 JSON");
  const calls: string = await readText(fixture.callLog);
  assertContains(calls, "generator-secret-env=absent", "生成器环境不得继承 AI 凭据");
  assertContains(calls, "validation-secret-env=absent", "校验器环境不得继承 AI 凭据");
  if (calls.includes("systemctl-secret-env=")) {
    assertContains(calls, "systemctl-secret-env=absent", "systemd 环境不得继承 AI 凭据");
  } else {
    assertContains(calls, "start-secret-env=absent", "启动环境不得继承 AI 凭据");
  }
  assertCondition(!calls.includes("secret-env=present"), "任何后续子进程都不得继承 AI 凭据");
  assertCondition(!result.output.includes(apiKey), "安装输出不得回显 AI 凭据");
  assertCondition(
    !(await readText(fixture.outboundLog)).includes(":blocked"),
    "安装实测不得调用网络、包管理器或提权命令"
  );
}

async function checkFixtureRoots(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  for (const path of [
    fixture.worktree,
    fixture.configRoot,
    fixture.backupRoot,
    fixture.runtimeRoot,
    fixture.binRoot,
    fixture.callLog,
    fixture.outboundLog,
  ]) {
    assertCondition(path.startsWith(fixture.root + "/"), "夹具路径必须位于独立临时根");
  }
  assertCondition(
    basename(fixture.root).startsWith("copy-ninjia-install-test-"),
    "夹具必须使用专属临时根前缀"
  );
}

try {
  await checkStagingPermissionFailureCleanup();
  await checkTelegramRollback();
  await checkInterruptedResume();
  await checkSuccessfulReplacement();
  await checkSymlinkTopologyPreserved();
  await checkUnverifiedJournalBackupRetention();
  await checkCredentialIsolation();
  await checkFixtureRoots();
  console.log("Install isolation check passed.");
} finally {
  cleanupFixtures();
}
