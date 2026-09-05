import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const noUi = {
  group: ["**/ui", "**/ui/**"],
  message:
    "Application and rendering modules must not depend on UI composition.",
};
const noConcretePlane = {
  group: ["**/data-plane"],
  importNames: ["HttpPlane", "BakedPlane"],
  message: "Use the DataPlane capability contract, not a concrete transport.",
};

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
    files: ["src/ui/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [noConcretePlane],
        },
      ],
    },
  },
  {
    files: ["src/render/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            noUi,
            noConcretePlane,
            {
              group: [
                "**/workspace",
                "**/ingest",
                "**/preferences",
                "**/workspace-save",
              ],
              message:
                "Renderer modules consume prepared data, not workspace or persistence owners.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [noUi] }],
    },
  },
  {
    files: ["src/app/**/*.ts"],
    ignores: [
      "src/app/**/*.test.ts",
      "src/app/line2d-family.ts",
      "src/app/line-presentation-controller.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            noUi,
            {
              group: ["**/render/**", "@chartgpu/**"],
              message:
                "Only presentation composition connects application data to render adapters.",
            },
          ],
        },
      ],
    },
  },
);
