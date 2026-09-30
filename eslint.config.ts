import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules/", "dist/", "coverage/"] },
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
      // An empty catch hides failures; errors must be handled or rethrown with a cause.
      "no-empty": ["error", { allowEmptyCatch: false }],
      "preserve-caught-error": "error",
    },
  },
  prettier,
);
