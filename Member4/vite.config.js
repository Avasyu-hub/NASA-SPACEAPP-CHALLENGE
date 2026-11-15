import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  // Allow imports from ../web/src/core (M1 missionLogic.js), ../Member2/src (M2 ray-cast) and ../docs.
  server: { fs: { allow: ['..'] } },
  build: {
    rollupOptions: {
      // index.html = LunaWise app (dashboard + Moon + digital twin); twin.html = M4's full twin UI.
      input: { main: resolve(__dirname, 'index.html'), twin: resolve(__dirname, 'twin.html') },
    },
  },
});
