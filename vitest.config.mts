import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // The real "obsidian" package is type-only with no runtime entry.
      // Redirect to our mock so imports resolve at test time.
      obsidian: path.resolve(import.meta.dirname, 'tests/__mocks__/obsidian.ts'),
      // commons/* sub-paths resolve to their source index files for tests.
      'commons/workspace': path.resolve(import.meta.dirname, '../obsidian-commons/src/workspace/index.ts'),
      'commons/windows': path.resolve(import.meta.dirname, '../obsidian-commons/src/windows/index.ts'),
      'commons/modal': path.resolve(import.meta.dirname, '../obsidian-commons/src/modal/index.ts'),
      'commons/properties/values': path.resolve(import.meta.dirname, '../obsidian-commons/src/properties/values.ts'),
      'commons/properties': path.resolve(import.meta.dirname, '../obsidian-commons/src/properties/index.ts'),
      'commons/search': path.resolve(import.meta.dirname, '../obsidian-commons/src/search/index.ts'),
      'commons/geometry': path.resolve(import.meta.dirname, '../obsidian-commons/src/geometry/index.ts'),
      'commons/os': path.resolve(import.meta.dirname, '../obsidian-commons/src/os/index.ts'),
      'commons/testing': path.resolve(import.meta.dirname, '../obsidian-commons/src/testing/index.ts'),
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
    },
  },
});
