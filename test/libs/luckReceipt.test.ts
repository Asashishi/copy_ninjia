import { expect, test } from "bun:test";
import { stripLuckReceipt } from "../../src/libs/luckReceipt";

test("stripLuckReceipt 只移除末行的规范签名回执", () => {
  const receipt: string = `luck:${"a".repeat(22)}.${"b".repeat(22)}`;
  expect(stripLuckReceipt(`可读正文\n${receipt}`)).toBe("可读正文");
  expect(stripLuckReceipt(`正文 ${receipt}`)).toBe(`正文 ${receipt}`);
  expect(stripLuckReceipt("普通正文\nluck:伪造")).toBe("普通正文\nluck:伪造");
});
