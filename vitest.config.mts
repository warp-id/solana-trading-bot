import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['*.ts', 'cache/**/*.ts', 'filters/**/*.ts', 'helpers/**/*.ts', 'listeners/**/*.ts', 'transactions/**/*.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: { lines: 90, statements: 90 },
    },
  },
});
