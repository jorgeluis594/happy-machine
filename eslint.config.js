import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [
      ".agents/**",
      ".claude/**",
      ".happy-machine/**",
      ".happy-memory/**",
      ".superpowers/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
    ],
  },
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended],
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
