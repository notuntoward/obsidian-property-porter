import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // The real "obsidian" package is type-only with no runtime entry.
      // Redirect to our mock so imports resolve at test time.
      obsidian: path.resolve(__dirname, 'tests/__mocks__/obsidian.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    pool: 'vmThreads', // Vitest 4.x: only vm* pools properly collect tests
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'], // main.ts is too coupled to Obsidian API to unit test
    },
  },
});
