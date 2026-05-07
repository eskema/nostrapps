import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    cors: true,
    // Vite 5.4+ blocks unknown Host headers in dev to mitigate DNS rebinding.
    // Our per-napp origins land at `<id>.napps.localhost:5173`, which isn't
    // in the implicit allow-list. The leading dot makes this a wildcard.
    allowedHosts: ['.localhost'],
  },
  preview: {
    allowedHosts: ['.localhost'],
  },
  optimizeDeps: {
    exclude: ['@nostr/gadgets/redstore'],
  },
});
