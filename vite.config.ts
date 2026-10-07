import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative asset paths: works on any static host or sub-path
  server: {
    host: true,
    allowedHosts: true, // lets tunnel hostnames (cloudflared / ngrok) through
  },
  build: { target: 'es2020' },
});
