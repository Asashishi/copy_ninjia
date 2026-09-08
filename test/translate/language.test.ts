import { describe, expect, test } from "bun:test";
import { canCopyWithoutTranslation } from "../../packages/translate/language";
import type { TranslateLanguage } from "../../packages/types/translate";

describe("翻译前的正则判定", () => {
  test.each([
    ["こんにちは、世界！", "ja", true],
    ["カタカナ 123 🙂", "ja", true],
    ["你好，世界！", "cn", true],
    ["今天天气很好", "cn", true],
    ["这是一条中文消息，测试翻译额度", "cn", true],
    ["鹦鹉喜欢吃樱桃", "cn", true],
    ["Hello, world! 123 🙂", "en", true],
    ["世界", "ja", false],
    ["繁體中文的訊息", "cn", false],
    ["這是一條中文訊息，測試翻譯額度", "cn", false],
    ["鸚鵡喜歡吃櫻桃", "cn", false],
    ["こんにちは你好", "cn", false],
    ["Hello 世界", "en", false],
    ["Hello こんにちは", "ja", false],
    ["你好 hello", "cn", false],
    ["안녕하세요", "ja", false],
    ["Café français", "en", false],
    ["Привет", "en", false],
    ["Привет, мир! 123 🙂", "ru", true],
    ["Ёжик съел сыр. ЭТО ЁЖ!", "ru", true],
    ["Привіт, світе! 123 🙂", "uk", true],
    ["Єнот їсть ґрушу. Є І Ї Ґ", "uk", true],
    ["П'ять п’ять пʼять", "uk", true],
    ["Привіт", "ru", false],
    ["І Ї Є Ґ і ї є ґ", "ru", false],
    ["Ё Ъ Ы Э ё ъ ы э", "uk", false],
    ["Привет, мир! Hello", "ru", false],
    ["Привіт, світе! Hello", "uk", false],
    ["Привет 你好", "ru", false],
    ["Привіт こんにちは", "uk", false],
    ["Прывітанне ў Мінску", "ru", false],
    ["Прывітанне ў Мінску", "uk", false],
    ["Љубав", "ru", false],
    ["Љубав", "uk", false],
  ] as const)("%s → %s 的跳过判定为 %s", (text: string, language: TranslateLanguage, expected: boolean) => {
    expect(canCopyWithoutTranslation(text, language)).toBe(expected);
    expect(canCopyWithoutTranslation(text, language)).toBe(expected);
  });

  test("俄乌共用字母短句按字形判断，不能消除语种歧义", () => {
    for (const language of ["uk", "ru"] as const) {
      expect(canCopyWithoutTranslation("Мама тут", language)).toBe(true);
    }
  });

  test("中性内容对所有方向都不占额度", () => {
    for (const language of ["ja", "cn", "en", "uk", "ru"] as const) {
      for (const text of ["", "123！", "🙂 ❤️ 👩‍💻", "  \n"]) {
        expect(canCopyWithoutTranslation(text, language)).toBe(true);
      }
    }
  });
});
