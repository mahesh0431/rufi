import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules/", "dist/", "src/agent/codex/protocol/"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A catch must handle the error or rethrow it with its cause; never swallow it.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CatchClause > BlockStatement[body.length=0]",
          message:
            "Handle the error or rethrow it with { cause }; a comment is not handling.",
        },
      ],
      "preserve-caught-error": ["error", { requireCatchParameter: true }],
      // Every case of a union is handled; a new case can't fall through silently.
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  prettier,
);
