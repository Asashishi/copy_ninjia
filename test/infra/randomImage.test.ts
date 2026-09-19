import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRandomImageDirectory, pickRandomImage } from "../../packages/infra/randomImage";
import { RANDOM_IMAGE_MAX_BYTES } from "../../packages/consts/randomImage";
import { STATE_FILE_PATH } from "../../packages/consts/paths";
import type { RandomImagePick } from "../../packages/types/randomImage";

const roots: string[] = [];

function temporaryRoot(): string {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-random-image-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ensureRandomImageDirectory", () => {
  test("目录不存在时逐级创建", async () => {
    const directory: string = join(temporaryRoot(), "nested", "images");
    await ensureRandomImageDirectory(directory);
    expect((await Bun.file(directory).stat()).isDirectory()).toBe(true);
  });

  test("已存在的目录与指向目录的符号链接原样放行", async () => {
    const root: string = temporaryRoot();
    const real: string = join(root, "real");
    mkdirSync(real);
    await Bun.write(join(real, "keep.png"), "x");
    const link: string = join(root, "link");
    symlinkSync(real, link);
    await ensureRandomImageDirectory(real);
    await ensureRandomImageDirectory(link);
    expect(await Bun.file(join(real, "keep.png")).text()).toBe("x");
  });

  test("路径是文件时拒绝，诊断写明 state 文件、字段与解析后的路径", async () => {
    const file: string = join(temporaryRoot(), "images");
    await Bun.write(file, "not a directory");
    await expect(ensureRandomImageDirectory(file)).rejects.toThrow(
      `${STATE_FILE_PATH}: state.global.assets.randomImageDir must be an existing or creatable directory (resolved to ${file}).`
    );
  });

  test("上级路径是文件时拒绝", async () => {
    const file: string = join(temporaryRoot(), "parent");
    await Bun.write(file, "x");
    await expect(ensureRandomImageDirectory(join(file, "images"))).rejects.toThrow(
      "state.global.assets.randomImageDir must be an existing or creatable directory"
    );
  });

  test("目录不存在且创建失败时拒绝（procfs 不允许建目录，root 也一样）", async () => {
    await expect(ensureRandomImageDirectory("/proc/copy-ninjia-random-image-test/images")).rejects.toThrow(
      "state.global.assets.randomImageDir must be an existing or creatable directory"
    );
  });
});

describe("pickRandomImage", () => {
  test("目录缺失或不是目录时报 missingDirectory", async () => {
    const root: string = temporaryRoot();
    expect(await pickRandomImage(join(root, "absent"))).toEqual({ status: "missingDirectory" });
    await Bun.write(join(root, "file"), "x");
    expect(await pickRandomImage(join(root, "file"))).toEqual({ status: "missingDirectory" });
  });

  test("只认非隐藏普通文件与白名单扩展名，其余一律不是候选", async () => {
    const root: string = temporaryRoot();
    await Bun.write(join(root, ".hidden.png"), "x");
    await Bun.write(join(root, "notes.txt"), "x");
    await Bun.write(join(root, "anim.gif"), "x");
    mkdirSync(join(root, "sub.png"));
    await Bun.write(join(root, "target.png"), "x");
    symlinkSync(join(root, "target.png"), join(root, "link.png"));
    await Bun.file(join(root, "target.png")).delete();
    expect(await pickRandomImage(root)).toEqual({ status: "empty" });
  });

  test("扩展名不分大小写，返回原文件名、对应 MIME 与字节", async () => {
    const root: string = temporaryRoot();
    await Bun.write(join(root, "Photo.WEBP"), new Uint8Array([1, 2, 3]));
    const pick: RandomImagePick = await pickRandomImage(root);
    expect(pick).toEqual({
      status: "ok",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/webp",
      fileName: "Photo.WEBP",
    });
  });

  test("按均匀随机下标选取候选", async () => {
    const root: string = temporaryRoot();
    for (const name of ["a.jpg", "b.jpeg", "c.png"]) await Bun.write(join(root, name), name);
    const random = spyOn(Math, "random");
    try {
      const picked: string[] = [];
      for (const value of [0, 0.5, 0.99]) {
        random.mockReturnValueOnce(value);
        const pick: RandomImagePick = await pickRandomImage(root);
        if (pick.status !== "ok") throw new Error(`unexpected ${pick.status}`);
        picked.push(new TextDecoder().decode(pick.bytes));
      }
      expect(new Set(picked).size).toBe(3);
    } finally {
      random.mockRestore();
    }
  });

  test("抽中的文件在读取前消失时从剩余候选重抽，抽完报 empty", async () => {
    const root: string = temporaryRoot();
    await Bun.write(join(root, "a.png"), "a");
    await Bun.write(join(root, "b.png"), "b");
    const random = spyOn(Math, "random").mockReturnValue(0);
    const realFile: typeof Bun.file = Bun.file;
    const gone: Error = Object.assign(new Error("gone"), { code: "ENOENT" });
    const file = spyOn(Bun, "file").mockImplementation(((path: string) => path.endsWith("a.png")
      ? { stat: async (): Promise<never> => { throw gone; } }
      : realFile(path)) as unknown as typeof Bun.file);
    try {
      const pick: RandomImagePick = await pickRandomImage(root);
      expect(pick).toMatchObject({ status: "ok", fileName: "b.png" });
      await Bun.write(join(root, "b.png"), "b");
      file.mockImplementation((() => ({ stat: async (): Promise<never> => { throw gone; } })) as unknown as typeof Bun.file);
      expect(await pickRandomImage(root)).toEqual({ status: "empty" });
    } finally {
      file.mockRestore();
      random.mockRestore();
    }
  });

  test("超过上限的文件只报超限，不读入内存", async () => {
    const root: string = temporaryRoot();
    await Bun.write(join(root, "huge.jpg"), new Uint8Array(RANDOM_IMAGE_MAX_BYTES + 1));
    const bytes = spyOn(Blob.prototype, "bytes");
    try {
      expect(await pickRandomImage(root)).toEqual({ status: "tooLarge", fileName: "huge.jpg" });
      expect(bytes).not.toHaveBeenCalled();
    } finally {
      bytes.mockRestore();
    }
  });
});
