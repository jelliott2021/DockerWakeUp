// ESLint flat config for the whole repository (both packages and the root
// test tooling). Type-aware rules are deliberately not enabled to keep
// `npm run lint` fast; `npm run typecheck` covers the type system.
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const globals = require("globals");

module.exports = tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "coverage/",
      "playwright-report/",
      "test-results/",
      "brag-output/",
      "nginx-generator/",
      "caddy-generator/",
      "wake-proxy/tmp/",
      "proxy-generator/confs/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain CommonJS scripts (config files, the test mock backend)
    files: ["**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  },
  {
    files: ["**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
