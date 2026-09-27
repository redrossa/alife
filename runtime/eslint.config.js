import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "spikes/"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["describe", "it", "suite", "test"] },
          ],
        },
      ],
    },
  },
  {
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Frozen Phase 4 acceptance test (hash-pinned, not editable here). It was written before
    // `resumeRun` existed, so its `candidate!` was needed then; with the export in place the
    // assertion is merely redundant. Pending the verifier's contract review of that line.
    files: ["test/unit/phase4-resume.acceptance.test.ts"],
    rules: { "@typescript-eslint/no-unnecessary-type-assertion": "off" },
  },
);
