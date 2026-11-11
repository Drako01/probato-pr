import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    // Many suites spawn real `git` processes; on Windows process creation is slow and compounds under the parallel
    // pool, so healthy tests exceed 30 s. They pass in isolation: this is latency, not a logic failure.
    testTimeout: process.platform === 'win32' ? 120_000 : 30_000,
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
