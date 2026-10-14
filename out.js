import { defineConfig } from 'vite';

var vite_config = defineConfig({
    base: './', // relative asset paths: works on any static host or sub-path
    server: {
        host: true,
        allowedHosts: true, // lets tunnel hostnames (cloudflared / ngrok) through
    },
    build: { target: 'es2020' },
});

export { vite_config as default };
