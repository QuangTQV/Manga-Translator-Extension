import { defineConfig } from 'vite';
import { resolve } from 'path';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import * as fs from 'fs';
import * as path from 'path';

function copyManifestPlugin() {
  return {
    name: 'copy-manifest',
    closeBundle() {
      const distDir = path.resolve(__dirname, 'dist');
      const manifestSrc = path.resolve(__dirname, 'manifest.json');
      const manifestDest = path.resolve(distDir, 'manifest.json');

      if (fs.existsSync(manifestSrc)) {
        fs.copyFileSync(manifestSrc, manifestDest);
      }

      // Every HTML page (popup, Live AI viewer) is emitted under dist/src/<page>/
      // by Vite; move each to dist/<page>/ and fix its asset paths so it works
      // from chrome-extension://<id>/<page>/index.html.
      for (const page of ['popup', 'live-ai']) {
        const pageHtml = path.resolve(distDir, 'src', page, 'index.html');
        const pageDir = path.resolve(distDir, page);
        const pageHtmlOut = path.resolve(pageDir, 'index.html');
        const pageJs = path.resolve(distDir, 'src', page, 'index.js');
        const pageJsOut = path.resolve(pageDir, 'index.js');

        if (fs.existsSync(pageHtml)) {
          fs.mkdirSync(pageDir, { recursive: true });
          fs.renameSync(pageHtml, pageHtmlOut);
        }
        if (fs.existsSync(pageJs)) {
          fs.mkdirSync(pageDir, { recursive: true });
          fs.renameSync(pageJs, pageJsOut);
        }

        if (fs.existsSync(pageHtmlOut)) {
          let html = fs.readFileSync(pageHtmlOut, 'utf-8');
          html = html.replace(/href="\/assets\//g, 'href="../assets/');
          html = html.replace(/src="\/assets\//g, 'src="../assets/');
          html = html.replace(new RegExp(`src="/${page}/`, 'g'), 'src="./');
          html = html.replace(new RegExp(`src="\\.\\./src/${page}/([^"]+)"`, 'g'), `src="../${page}/$1"`);
          fs.writeFileSync(pageHtmlOut, html);
        }
      }

      const srcDir = path.resolve(distDir, 'src');
      if (fs.existsSync(srcDir)) {
        try {
          fs.rmSync(srcDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }

      console.log('Manifest copied and extension artifacts normalized.');
    },
  };
}

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        'live-ai': resolve(__dirname, 'src/live-ai/index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') return 'background/index.js';
          if (chunkInfo.name === 'popup') return 'popup/index.js';
          if (chunkInfo.name === 'live-ai') return 'live-ai/index.js';
          return 'assets/[name]-[hash].js';
        },
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  plugins: [
    copyManifestPlugin(),
    viteStaticCopy({
      targets: [
        {
          src: [
            'public/icons/icon16.png',
            'public/icons/icon32.png',
            'public/icons/icon48.png',
            'public/icons/icon128.png',
          ],
          dest: 'icons',
        },
        {
          src: 'public/_locales',
          dest: '.',
        },
      ],
    }),
  ],
});
