import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
    environmentMatchGlobs: [
      ['tests/unit/**/*.test.tsx', 'jsdom'],
      ['tests/unit/storage*.test.ts', 'jsdom'],
      ['tests/unit/import*.test.ts', 'jsdom'],
      ['tests/unit/export*.test.ts', 'jsdom'],
      ['tests/unit/store*.test.ts', 'jsdom'],
    ],
    setupFiles: ['tests/unit/setup.ts'],
  },
});
