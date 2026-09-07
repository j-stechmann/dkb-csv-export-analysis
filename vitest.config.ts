import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts", "app/api/**/*.ts"],
      // UI components (no DOM test env) and the one-off fixture generator
      exclude: ["lib/utils.ts", "scripts/**"],
      // gates for the tested core: lib data layer + API routes
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
})
