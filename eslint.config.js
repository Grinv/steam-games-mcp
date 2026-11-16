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
  // The layering AGENTS.md describes, enforced. Clients fetch and read Steam
  // only through clients/endpoints.ts and lib/call.ts's primitives — a
  // hand-written catch there is how a cancel, a bug or a bad key got read as
  // an answer; and they touch no schemas or lib/result.ts (a client words only
  // the detail of an error it classifies).
  {
    files: ["src/clients/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CatchClause, CallExpression[callee.property.name='catch']",
          message:
            "Clients don't catch: declare Steam's answer in clients/endpoints.ts, or use " +
            "optional()/optionalParts()/orFailure() from lib/call.ts.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["zod", "**/*.schemas.ts"], message: "Schemas belong to format/." },
            {
              group: ["**/lib/result.ts"],
              message: "Agent-facing text is built in format/ and tools/.",
            },
          ],
        },
      ],
    },
  },
  // Formatters shape data; they don't fetch or know the transport.
  {
    files: ["src/format/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/clients/**", "**/lib/http.ts", "**/lib/cache.ts", "**/lib/endpoint.ts"],
              message: "format/ shapes data; fetching and transport belong to clients/ and lib/.",
            },
          ],
        },
      ],
    },
  },
  // Must be last: disables ESLint rules that conflict with Prettier.
  prettier,
);
