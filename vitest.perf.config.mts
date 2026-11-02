import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/perf/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    fileParallelism: false,
  },
});
