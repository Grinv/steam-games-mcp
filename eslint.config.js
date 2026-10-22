import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// defineConfig types the config for tsc (eslint.config.js is in tsconfig.json
// via allowJs/checkJs) and replaces the deprecated tseslint.config().
export default defineConfig(
  { ignores: ["dist/", "coverage/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Must be last: disables ESLint rules that conflict with Prettier.
  prettier,
);
