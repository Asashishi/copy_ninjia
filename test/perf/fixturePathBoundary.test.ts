import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertUnlinkedFixtureParent,
  assertUnlinkedFixturePath,
  type FixturePathBoundary,
} from "../../scripts/fixtures/pathBoundary";

/**
 * 叶子校验器本身的边界。
 *
 * 根级软链接只能在自建的临时锚点下测：仓库的 `performance/` 是全量基准真实的
 * 落点，把它换成链接会影响同机器上正在跑的基准。这里的锚点、允许根和外部夹具
 * 全部由用例自己在系统临时目录里建出来，跑完整棵删掉。
 */
describe("脚本夹具的写入边界", () => {
  const subject: string = "Test fixture";

  let anchor: string;
  let root: string;
  let external: string;
  let boundary: FixturePathBoundary;

  beforeEach(async () => {
    anchor = mkdtempSync(join(tmpdir(), "fixture-boundary-anchor-"));
    root = join(anchor, "root");
    mkdirSync(root);
    external = mkdtempSync(join(tmpdir(), "fixture-boundary-external-"));
    await Bun.write(join(external, "sentinel"), "keep");
    boundary = { anchor, root, subject };
  });

  afterEach(() => {
    rmSync(anchor, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });

  test("根内的普通嵌套路径通过", () => {
    mkdirSync(join(root, "run-a"), { recursive: true });
    expect((): void => assertUnlinkedFixturePath(join(root, "run-a"), boundary)).not.toThrow();
    expect((): void => assertUnlinkedFixturePath(root, boundary)).not.toThrow();
  });

  test("尚不存在的子路径按缺失处理，不拒绝", () => {
    expect((): void => assertUnlinkedFixturePath(join(root, "absent", "deeper"), boundary))
      .not.toThrow();
  });

  test("允许根自身经软链接到达时拒绝", () => {
    const linkedRoot: string = join(anchor, "linked-root");
    symlinkSync(external, linkedRoot);
    const escaped: FixturePathBoundary = { anchor, root: linkedRoot, subject };

    expect((): void => assertUnlinkedFixturePath(join(linkedRoot, "run-a"), escaped))
      .toThrow("is a symbolic link");
  });

  test("中间分量是软链接时拒绝", () => {
    symlinkSync(external, join(root, "bridge"));
    expect((): void => assertUnlinkedFixturePath(join(root, "bridge", "victim"), boundary))
      .toThrow("is a symbolic link");
  });

  test("末端本身是软链接时，整段校验拒绝而父链校验放行", () => {
    const leaf: string = join(root, "leaf");
    symlinkSync(external, leaf);

    expect((): void => assertUnlinkedFixturePath(leaf, boundary)).toThrow("is a symbolic link");
    expect((): void => assertUnlinkedFixtureParent(leaf, boundary)).not.toThrow();
  });

  test("中间分量是普通文件时按 ENOTDIR 拒绝，不当作缺失", async () => {
    await Bun.write(join(root, "occupied"), "");
    expect((): void => assertUnlinkedFixturePath(join(root, "occupied", "child"), boundary))
      .toThrow("could not be inspected");
  });

  test("`..` 逃逸与兄弟前缀都被词法闸拒绝", () => {
    expect((): void => assertUnlinkedFixturePath(join(root, "..", "outside"), boundary))
      .toThrow("every path must live under");
    expect((): void => assertUnlinkedFixturePath(`${root}-other`, boundary))
      .toThrow("every path must live under");
    expect((): void => assertUnlinkedFixturePath(external, boundary))
      .toThrow("every path must live under");
  });

  test("父链校验不接受根自身，也不接受根之外的路径", () => {
    expect((): void => assertUnlinkedFixtureParent(root, boundary))
      .toThrow("every path must live under");
    expect((): void => assertUnlinkedFixtureParent(join(external, "sentinel"), boundary))
      .toThrow("every path must live under");
  });
});
