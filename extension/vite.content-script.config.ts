import { defineConfig } from 'vite';
import { resolve } from 'path';

// content-script/index.js is injected via chrome.scripting.executeScript({ files: [...] }),
// which always runs it as a classic (non-module) script — it cannot contain a top-level
// `import`. The main build (vite.config.ts) bundles popup/background/content-script
// together and, because content-script imports runtime code from shared/types.ts (also
// used by popup/background), Rollup's default ES output extracts that shared code into a
// separate chunk and leaves an `import` statement in content-script/index.js, which throws
// immediately when injected and silently breaks the whole content script. Building it here
// on its own with format: 'iife' forces everything (including shared/types.ts and jszip)
// to be inlined into a single self-contained file instead.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/content-script/index.ts'),
      output: {
        format: 'iife',
        entryFileNames: 'content-script/index.js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
