import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, readdirSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { imageFixture } from "../helpers/image";
import { prepareRandomImageNameMigration } from "../../scripts/migrateRandomImageNames";
import type { RandomImageNameMigrationResult } from "../../scripts/migrateRandomImageNames";
import { TEST_DATA_ROOT } from "../preloadEnv";

let root: string;
let source: string;
let JPEG: Uint8Array;
let PNG: Uint8Array;
let WEBP: Uint8Array;

/** 内容摘要就是产物文件名的主干。 */
function contentName(bytes: Uint8Array, extension: string): string {
  return `${Bun.SHA256.hash(bytes, "hex")}${extension}`;
}

function output(name: string = "output"): string {
  return join(root, name);
}

beforeEach(async () => {
  root = await mkdtemp(join(TEST_DATA_ROOT, "random-image-name-migration-"));
  source = join(root, "images");
  await mkdir(source, { recursive: true });
  JPEG = await new Bun.Image(imageFixture(4, 4)).jpeg().bytes();
  PNG = await new Bun.Image(imageFixture(5, 5)).png().bytes();
  WEBP = await new Bun.Image(imageFixture(6, 6)).webp().bytes();
});
afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});

test("旧文件名一律改成内容 SHA-256，扩展名按文件头重判，源目录不变", async () => {
  // 三种历史形态：带 file_unique_id 的、只有 uuidv7 的、部署方手工放进来的。
  await Bun.write(join(source, "0199ffff-ffff-7fff-bfff-ffffffffffff-AQADabc.jpg"), JPEG);
  await Bun.write(join(source, "0199ffff-ffff-7fff-bfff-fffffffffffe.jpeg"), PNG);
  await Bun.write(join(source, "manual.webp"), WEBP);
  const before: readonly string[] = readdirSync(source).sort();

  const result: RandomImageNameMigrationResult =
    await prepareRandomImageNameMigration({ sourceDirectory: source, outputDirectory: output() });

  expect(readdirSync(output()).sort()).toEqual([
    "ready.json", contentName(JPEG, ".jpg"), contentName(PNG, ".png"), contentName(WEBP, ".webp"),
  ].sort());
  expect(result.renamed).toBe(3);
  expect(result.alreadyNamed).toBe(0);
  expect(result.deduplicated).toBe(0);
  expect(result.duplicates).toEqual([]);
  // `.jpeg` 的那份其实是 PNG 字节：扩展名按文件头重判，不沿用原来的。
  expect(result.outputFiles.map((file): string => file.name)).toContain(contentName(PNG, ".png"));
  expect(readdirSync(source).sort()).toEqual([...before]);
});

test("字节完全相同的多张图合并成一份，明细写进 ready.json", async () => {
  for (const name of ["a.jpg", "b.jpg", "c.jpg"]) await Bun.write(join(source, name), JPEG);
  await Bun.write(join(source, "other.png"), PNG);

  const result: RandomImageNameMigrationResult =
    await prepareRandomImageNameMigration({ sourceDirectory: source, outputDirectory: output() });

  expect(readdirSync(output()).sort()).toEqual(["ready.json", contentName(JPEG, ".jpg"), contentName(PNG, ".png")].sort());
  expect(result.deduplicated).toBe(2);
  expect(result.duplicates).toEqual([
    { kept: "a.jpg", dropped: ["b.jpg", "c.jpg"], fileName: contentName(JPEG, ".jpg") },
  ]);
  const ready = await Bun.file(join(output(), "ready.json")).json();
  expect(ready.duplicates).toEqual(result.duplicates);
});

test("已经是目标形态的文件原样带过来，只计入 alreadyNamed", async () => {
  await Bun.write(join(source, contentName(JPEG, ".jpg")), JPEG);
  await Bun.write(join(source, "old.png"), PNG);

  const result: RandomImageNameMigrationResult =
    await prepareRandomImageNameMigration({ sourceDirectory: source, outputDirectory: output() });

  expect(result.alreadyNamed).toBe(1);
  expect(result.renamed).toBe(1);
});

test("重跑是幂等的：对产物再跑一次不改任何名字", async () => {
  await Bun.write(join(source, "old.jpg"), JPEG);
  const first: RandomImageNameMigrationResult =
    await prepareRandomImageNameMigration({ sourceDirectory: source, outputDirectory: output("first") });
  // ready.json 是校验清单、不是图库候选；把产物当成新的源之前先挪走。
  await rm(join(first.outputDirectory, "ready.json"));

  const second: RandomImageNameMigrationResult =
    await prepareRandomImageNameMigration({ sourceDirectory: first.outputDirectory, outputDirectory: output("second") });

  expect(second.renamed).toBe(0);
  expect(second.alreadyNamed).toBe(1);
  expect(readdirSync(output("second")).sort()).toEqual(["ready.json", contentName(JPEG, ".jpg")].sort());
});

test("源目录里混进不是图库候选的东西时整次拒绝，不留产物", async () => {
  await Bun.write(join(source, "ok.jpg"), JPEG);
  await Bun.write(join(source, "notes.txt"), "x");
  await Bun.write(join(source, ".h_image-add-leftover.jpg"), JPEG);
  await mkdir(join(source, "nested"));
  symlinkSync(join(source, "ok.jpg"), join(source, "link.jpg"));

  await expect(prepareRandomImageNameMigration({ sourceDirectory: source, outputDirectory: output() }))
    .rejects.toThrow(/only random image files/);
  expect(readdirSync(root).sort()).toEqual(["images"]);
});

test("内容不是 jpeg、png、webp 时拒绝，绝不沿用原扩展名猜", async () => {
  await Bun.write(join(source, "ok.jpg"), JPEG);
  await Bun.write(join(source, "fake.png"), new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]));

  await expect(prepareRandomImageNameMigration({ sourceDirectory: source, outputDirectory: output() }))
    .rejects.toThrow(/jpeg, png or webp content/);
  // 中断现场保留：incomplete.json 还在，没有 ready.json。
  expect(readdirSync(output()).includes("ready.json")).toBeFalse();
  expect(readdirSync(output()).includes("incomplete.json")).toBeTrue();
});

test("产物目录与源目录互相包含时拒绝", async () => {
  await Bun.write(join(source, "ok.jpg"), JPEG);
  for (const directory of [join(source, "out"), root]) {
    await expect(prepareRandomImageNameMigration({ sourceDirectory: source, outputDirectory: directory }))
      .rejects.toThrow(/outside the source image library/);
  }
});

test("产物目录已存在时拒绝，不覆盖任何既有目录", async () => {
  await Bun.write(join(source, "ok.jpg"), JPEG);
  await mkdir(output());

  await expect(prepareRandomImageNameMigration({ sourceDirectory: source, outputDirectory: output() }))
    .rejects.toMatchObject({ code: "EEXIST" });
});

test("清单记录源文件的哈希与权限元数据，供运维恢复属主和模式", async () => {
  await Bun.write(join(source, "old.jpg"), JPEG);
  chmodSync(join(source, "old.jpg"), 0o640);

  const result: RandomImageNameMigrationResult =
    await prepareRandomImageNameMigration({ sourceDirectory: source, outputDirectory: output() });

  expect(result.sourceFiles).toEqual([{
    name: "old.jpg",
    sha256: Bun.SHA256.hash(JPEG, "hex"),
    mode: 0o640,
    uid: expect.any(Number) as unknown as number,
    gid: expect.any(Number) as unknown as number,
  }]);
});

test("复制期间源目录被改动时拒绝发布 ready.json", async () => {
  await Bun.write(join(source, "old.jpg"), JPEG);
  const original = Bun.write;
  const spy = spyOn(Bun, "write").mockImplementation((async (destination: never, input: never): Promise<number> => {
    const bytes: number = await original(destination, input);
    // 第一次复制刚落地就动源目录，模拟运维没有真正停服。
    spy.mockRestore();
    await original(join(source, "late.png") as never, PNG as never);
    return bytes;
  }) as never);
  try {
    await expect(prepareRandomImageNameMigration({ sourceDirectory: source, outputDirectory: output() }))
      .rejects.toThrow(/unchanged cold backup/);
  } finally {
    spy.mockRestore();
  }
  expect(readdirSync(output()).includes("ready.json")).toBeFalse();
});
