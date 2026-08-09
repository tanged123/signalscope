import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "playwright-report/**", "test-results/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "AssignmentExpression[left.property.name='innerHTML'][right.type='TemplateLiteral'][right.expressions.length>0]",
          message:
            "Do not interpolate values into innerHTML (AGENTS.md): signal and source names are untrusted. Use textContent.",
        },
        {
          selector:
            "AssignmentExpression[left.property.name='innerHTML'][right.type='BinaryExpression']",
          message:
            "Do not concatenate values into innerHTML (AGENTS.md): signal and source names are untrusted. Use textContent.",
        },
      ],
    },
  },
  {
    files: ["tests/e2e/electron-native-export.spec.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
);
