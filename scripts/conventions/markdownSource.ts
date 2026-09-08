/** 两个 Markdown 检查共用的正文预处理。 */

/**
 * 去掉 fenced code block 的内容，但保留换行与字符下标。
 *
 * 两个 Markdown 判据都要它：链接核对不能把示例里的 `](./foo)` 当成真链接，
 * 目录清单核对不能把代码块里的示例文件名当成真清单。用等长空格替换而不是删除，
 * 是为了让调用方按 `match.index` 反算出的行号仍与原文对齐。
 */
export function withoutMarkdownCodeFences(source: string): string {
  return source.replace(
    /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g,
    (block: string): string => block.replace(/[^\n]/g, " ")
  );
}
