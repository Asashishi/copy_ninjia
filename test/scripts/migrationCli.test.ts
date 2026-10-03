import { describe, expect, test } from "bun:test";
import { parseSourceOutputRoots } from "../../scripts/migrations/cli";

/** 冷迁移与停机清理 CLI 共用的 `--source-root`/`--output-root` 解析。 */
describe("parseSourceOutputRoots", () => {
  test("两项都给出时按任意顺序取值并去掉首尾空白", (): void => {
    expect(parseSourceOutputRoots(["--source-root", " /backup ", "--output-root", "/out"]))
      .toEqual({ sourceRoot: "/backup", outputRoot: "/out" });
    expect(parseSourceOutputRoots(["--output-root", "/out", "--source-root", "/backup"]))
      .toEqual({ sourceRoot: "/backup", outputRoot: "/out" });
  });

  test.each([
    [["--source-root", "/backup", "--extra", "x"]],
    [["--source-root", "/backup", "--source-root", "/other", "--output-root", "/out"]],
    [["--source-root", "--output-root", "/out"]],
    [["--source-root", "  ", "--output-root", "/out"]],
    [["--source-root"]],
    [["/backup"]],
  ])("未知、重复、缺值或空白值的选项按用法拒绝：%j", (args: string[]): void => {
    expect(() => parseSourceOutputRoots(args))
      .toThrow("arguments: $ must be --source-root <cold-backup> --output-root <new-directory>.");
  });

  test.each([[[]], [["--source-root", "/backup"]], [["--output-root", "/out"]]])("缺任一必填项时拒绝：%j", (args: string[]): void => {
    expect(() => parseSourceOutputRoots(args)).toThrow("arguments: $ must be both required path options.");
  });
});
