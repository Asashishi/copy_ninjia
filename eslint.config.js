import eslint from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**", "out/**"],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    files: ["**/*.js"],
    extends: [eslint.configs.recommended],
  },
  {
    files: ["index.ts", "src/**/*.ts"],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 生产代码普遍把泛型写在显式类型标注上，例如 `const cache: Map<K, V> = new Map()`。
      "@typescript-eslint/consistent-generic-constructors": ["error", "type-annotation"],
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        // 字符串等原始值常把空值作为有效的回退信号，保留现有的 `||` 语义。
        { ignorePrimitives: true },
      ],
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      "@typescript-eslint/unified-signatures": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
    ],
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "separate-type-imports", prefer: "type-imports" },
      ],
      // 项目有意为简单局部变量也写明类型，作为相邻状态和常量的可读性提示。
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.{js,ts}"],
    plugins: {
      "@stylistic": stylistic,
    },
    rules: {
      "@stylistic/array-bracket-spacing": ["error", "never"],
      "@stylistic/arrow-parens": ["error", "always"],
      "@stylistic/block-spacing": ["error", "always"],
      "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: true }],
      "@stylistic/comma-dangle": [
        "error",
        {
          arrays: "always-multiline",
          exports: "always-multiline",
          functions: "never",
          imports: "always-multiline",
          objects: "always-multiline",
        },
      ],
      "@stylistic/comma-spacing": ["error", { before: false, after: true }],
      "@stylistic/computed-property-spacing": ["error", "never"],
      "@stylistic/eol-last": ["error", "always"],
      "@stylistic/function-call-spacing": ["error", "never"],
      // 多行三元表达式沿用仓库现有的平铺对齐，其余语法仍检查两空格缩进。
      "@stylistic/indent": ["error", 2, { SwitchCase: 1, ignoredNodes: ["ConditionalExpression"] }],
      "@stylistic/key-spacing": ["error", { beforeColon: false, afterColon: true }],
      "@stylistic/keyword-spacing": ["error", { before: true, after: true }],
      "@stylistic/no-mixed-spaces-and-tabs": "error",
      "@stylistic/no-multi-spaces": "error",
      "@stylistic/no-multiple-empty-lines": ["error", { max: 1, maxBOF: 0, maxEOF: 0 }],
      "@stylistic/no-trailing-spaces": "error",
      "@stylistic/object-curly-spacing": ["error", "always"],
      "@stylistic/operator-linebreak": [
        "error",
        "after",
        { overrides: { "?": "before", ":": "before", "|": "before" } },
      ],
      "@stylistic/quotes": ["error", "double", { avoidEscape: true, allowTemplateLiterals: "always" }],
      "@stylistic/rest-spread-spacing": ["error", "never"],
      "@stylistic/semi": ["error", "always"],
      "@stylistic/space-before-blocks": ["error", "always"],
      "@stylistic/space-before-function-paren": [
        "error",
        { anonymous: "never", asyncArrow: "always", named: "never" },
      ],
      "@stylistic/space-in-parens": ["error", "never"],
      "@stylistic/space-infix-ops": "error",
      "@stylistic/space-unary-ops": "error",
      "@stylistic/switch-colon-spacing": ["error", { before: false, after: true }],
      "@stylistic/template-curly-spacing": ["error", "never"],
      "@stylistic/type-annotation-spacing": "error",
      "curly": ["error", "multi-line"],
      "default-case-last": "error",
      "eqeqeq": ["error", "always"],
      "max-params": ["error", 3],
      "no-else-return": ["error", { allowElseIf: true }],
      "no-lonely-if": "error",
      "no-useless-return": "error",
      "object-shorthand": [
        "error",
        "always",
        { avoidExplicitReturnArrows: true, methodsIgnorePattern: ".*" },
      ],
      "prefer-object-spread": "error",
      "yoda": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // 测试夹具需要轻量搭建第三方 API 形状，并大量使用空函数作为 mock。
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  }
);
