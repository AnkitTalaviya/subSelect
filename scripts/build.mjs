/**
 * SubSelect build.
 *
 * Three separate Rollup passes are required, not one:
 *  - MV3 content scripts are classic scripts, so the content bundle must be a single
 *    self-contained IIFE with no code splitting.
 *  - The service worker is built as an IIFE too, which avoids module-worker nuances.
 *  - The popup is an HTML entry and needs Vite's HTML pipeline.
 *
 * Rollup refuses IIFE output for multi-entry builds, hence one pass per entry.
 */
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes('--watch');

const alias = {
  '@shared': resolve(root, 'src/shared'),
  '@content': resolve(root, 'src/content'),
};

/** @type {import('vite').InlineConfig} */
const base = {
  root,
  configFile: false,
  resolve: { alias },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    target: 'chrome114',
    minify: 'esbuild',
    sourcemap: watch ? 'inline' : false,
    emptyOutDir: false,
    outDir: 'dist',
    ...(watch ? { watch: {} } : {}),
  },
};

/** A single-entry IIFE bundle (content script / service worker). */
function iifeBundle(name, entry) {
  return {
    ...base,
    publicDir: false,
    build: {
      ...base.build,
      rollupOptions: {
        input: resolve(root, entry),
        output: {
          format: 'iife',
          entryFileNames: `${name}.js`,
          assetFileNames: `${name}.[ext]`,
          inlineDynamicImports: true,
        },
      },
    },
  };
}

/** An extension page, built from its own root so it lands at dist/<name>.html. */
function htmlBundle(name) {
  return {
    ...base,
    root: resolve(root, `src/${name}`),
    // public/ is copied once, by the content pass, to avoid duplicate work.
    publicDir: false,
    build: {
      ...base.build,
      outDir: resolve(root, 'dist'),
      rollupOptions: {
        input: resolve(root, `src/${name}/${name}.html`),
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name].[ext]',
        },
      },
    },
  };
}

/** The content pass owns copying public/ (manifest, icons, content.css). */
const contentBundle = {
  ...iifeBundle('content', 'src/content/index.ts'),
  publicDir: resolve(root, 'public'),
};

const bundles = [
  htmlBundle('popup'),
  htmlBundle('options'),
  htmlBundle('vocabulary'),
  htmlBundle('welcome'),
  contentBundle,
  iifeBundle('service-worker', 'src/background/service-worker.ts'),
];

for (const config of bundles) {
  await build(config);
}

console.log(watch ? '\nSubSelect: watching for changes…' : '\nSubSelect: built to dist/');
