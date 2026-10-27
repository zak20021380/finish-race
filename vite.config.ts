import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative asset paths: works on any static host or sub-path
  server: {
    host: true,
    allowedHosts: true, // lets tunnel hostnames (cloudflared / ngrok) through
    /* Local work runs two servers: Vite on 5173 and `wrangler dev` on 8787. Proxying the
       backend prefixes keeps every admin call same-origin, so the Command Center reaches
       the live Durable Object instead of falling into LOCAL MODE. */
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/admin': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true, changeOrigin: true },
    },
  },
  build: { target: 'es2020' },
});
