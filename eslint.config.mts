import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// The recommended config is what the community plugin scanner runs; it already
// exempts tests and build scripts from the rules that only matter in Obsidian.
export default defineConfig([
	globalIgnores(["node_modules", "dist", "main.js", "esbuild.config.mjs", "version-bump.mjs", "scripts"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*"],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		// node:test's test() returns a promise the runner tracks.
		files: ["test/**/*.ts"],
		rules: {"@typescript-eslint/no-floating-promises": "off"},
	},
]);
