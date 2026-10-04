import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Default environment is node (parser tests). Tests that need a DOM or
// IndexedDB declare it per file with a docblock on line 1:
//   // @vitest-environment jsdom
// (`environmentMatchGlobs` is not honoured by vitest 5, verified in M2.)
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['tests/unit/setup.ts'],
  },
});
