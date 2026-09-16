import { expect, test } from "bun:test";
import { collectFileLengthProblems } from "../../scripts/conventions/fileLength";

test.each(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "sh"])(
  "%s 文件超过 1000 行必须拆分",
  (extension: string): void => {
    const path: string = `scripts/source.${extension}`;
    expect(collectFileLengthProblems(path, "line\n".repeat(1_000))).toEqual([]);
    expect(collectFileLengthProblems(path, "line\r\n".repeat(999) + "tail")).toEqual([]);
    expect(collectFileLengthProblems(path, "line\n".repeat(1_000) + "tail")).toEqual([
      `${path} has 1001 lines; split source files exceeding 1000 lines`,
    ]);
  }
);

test("空源码与非源码文档不触发长度硬门禁", (): void => {
  expect(collectFileLengthProblems("empty.ts", "")).toEqual([]);
  expect(collectFileLengthProblems("guide.md", "line\n".repeat(1_001))).toEqual([]);
});
