import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // docs-site/ is its own Astro project, with its own dependencies and build.
  { ignores: ["dist/", "coverage/", "node_modules/", "docs-site/"] },
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
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
