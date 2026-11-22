import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // docs-site/ is its own Astro project, with its own dependencies and build.
  { ignores: ["dist/", "coverage/", "node_modules/", "docs-site/", ".claude/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The templates' chant.config.ts imports @intentius/sql-yodeler, which is this repository: tsconfig.templates.json maps it to ./src.
    files: ["templates/*/chant.config.ts"],
    languageOptions: { parserOptions: { projectService: false, project: "./tsconfig.templates.json", tsconfigRootDir: import.meta.dirname } },
  },
  {
    // Plain Node scripts run by npm run build; not part of any tsconfig.
    files: ["eslint.config.js", "scripts/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["scripts/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
);
