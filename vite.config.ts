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
  /* CHUNK CONTRACT. The boot graph is the shell: `main.ts`, the renderer, the rules, the router
     and the screens the first frame actually paints. Everything a tap reaches — the Command
     Center, the face-off cinematic, the nation board, the mind ladder, the squad desk — is a
     dynamic `import()` in the module that opens it, so Rollup emits it as its own chunk and the
     first frame never parses it.
     CSS follows the same split (`cssCodeSplit` is on by default): a lazy module's stylesheet
     leaves the main bundle and is injected with its chunk, which is why `vsclash.css` ships as
     `assets/vsclash-*.css` rather than inside `index.css`. Nothing here should be replaced with a
     `manualChunks` grouping: merging those chunks back would put the parse cost on the boot again,
     and a blind CSS purge would strip the class names the lazy screens build at runtime. */
  build: { target: 'es2020' },
});
