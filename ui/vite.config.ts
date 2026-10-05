import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// The Rust server (or `bun run mock`) listens here; the dev server proxies to it.
const SERVER = process.env.X1D4_SERVER || 'http://127.0.0.1:7878';

export default defineConfig({
  // Relative asset URLs so the bundle works however the server embeds it.
  base: './',
  plugins: [svelte()],
  server: {
    proxy: {
      '/api': { target: SERVER },
      '/ws': { target: SERVER, ws: true },
    },
  },
  // `vite preview` reuses server.proxy.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: false,
    // three.js is one lazy chunk (~575 kB) loaded only when Explore opens.
    chunkSizeWarningLimit: 700,
  },
});
