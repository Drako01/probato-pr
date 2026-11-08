import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // `pnpm run test:coverage` (or PROBATO_COVERAGE=1, used by CI so the suite runs once). Critical modules are gated
    // one by one by scripts/coverage-modules.mjs, so the global number cannot hide a weak module.
    coverage: {
      enabled: process.env.PROBATO_COVERAGE === '1',
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
