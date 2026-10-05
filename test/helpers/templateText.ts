/**
 * 断言「带一个插值参数的文案模板常量」时取其固定片段：用不会出现在文案里的哨兵渲染一次再切开。
 * 测试只断言常量里的固定部分，插值部分（标签、数量等）由各用例自己的夹具决定，不在测试里写死文案。
 */

import { expect } from "bun:test";

const TEMPLATE_SENTINEL: string = "\u0000";

/** 模板按插值位置切出的非空固定片段，按出现顺序。 */
export function templateParts(render: (value: string) => string): string[] {
  return render(TEMPLATE_SENTINEL)
    .split(TEMPLATE_SENTINEL)
    .filter((part: string): boolean => part.length > 0);
}

/** 模板里最长的固定片段；否定断言用它，避免「笨蛋，」这类短片段误中别的文案。 */
export function longestTemplatePart(render: (value: string) => string): string {
  let longest: string = "";
  for (const part of templateParts(render)) if (part.length > longest.length) longest = part;
  return longest;
}

/** 断言 text 按顺序包含模板的全部固定片段。 */
export function expectTemplateRendered(text: string, render: (value: string) => string): void {
  let cursor: number = 0;
  for (const part of templateParts(render)) {
    const index: number = text.indexOf(part, cursor);
    expect(index).toBeGreaterThanOrEqual(0);
    cursor = index + part.length;
  }
}
