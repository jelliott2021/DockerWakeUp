// Root Jest configuration: one project per package so `npm test` at the repo
// root runs everything and produces a single coverage report.
const path = require("path");

/** Build a Jest project for one of the TypeScript packages in this repo. */
function project(name) {
  const rootDir = path.join(__dirname, name);
  return {
    displayName: name,
    rootDir,
    testEnvironment: "node",
    testMatch: ["<rootDir>/test/**/*.test.ts"],
    transform: {
      "^.+\\.ts$": ["ts-jest", { tsconfig: path.join(rootDir, "tsconfig.test.json") }],
    },
    clearMocks: true,
    restoreMocks: true,
  };
}

/** @type {import("jest").Config} */
module.exports = {
  projects: [project("wake-proxy"), project("proxy-generator")],
  testTimeout: 15000,
  collectCoverageFrom: [
    "wake-proxy/src/**/*.ts",
    "proxy-generator/src/**/*.ts",
    "proxy-generator/generate.ts",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text-summary", "text", "lcov"],
  // The bar every PR has to clear; see CONTRIBUTING.md
  coverageThreshold: {
    global: { statements: 100, branches: 95, functions: 100, lines: 100 },
  },
};
