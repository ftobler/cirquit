import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The site is deployed to GitHub Pages under a repository path, so the base is
// configurable: `BASE_PATH=/falstad-cirquit/ npm run build`.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    target: 'es2022',
    // wasm-pack output is already minified machine code; keeping it as a
    // separate asset lets the browser cache it independently of the app JS.
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
