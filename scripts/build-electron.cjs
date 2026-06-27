/**
 * build-electron.cjs — esbuild bundler for the Kovix Electron app.
 *
 * Entry points:
 *   electron/main.ts    → dist/electron-main.js
 *   electron/preload.ts → dist/preload.js
 *
 * Externalizes: electron, Node built-ins, hnswlib-node.
 *
 * Supports --watch flag for development.
 */

const esbuild = require('esbuild');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const isWatch = process.argv.includes('--watch');

const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  external: [
    'electron',
    'hnswlib-node',
    // Node built-ins that shouldn't be bundled
    'child_process',
    'crypto',
    'fs',
    'http',
    'https',
    'net',
    'os',
    'path',
    'stream',
    'tls',
    'url',
    'util',
    'zlib',
  ],
  logLevel: 'info',
};

async function build() {
  try {
    if (isWatch) {
      const ctx1 = await esbuild.context({
        ...commonOptions,
        entryPoints: [path.join(rootDir, 'electron', 'main.ts')],
        outfile: path.join(rootDir, 'dist', 'electron-main.js'),
      });
      const ctx2 = await esbuild.context({
        ...commonOptions,
        entryPoints: [path.join(rootDir, 'electron', 'preload.ts')],
        outfile: path.join(rootDir, 'dist', 'preload.js'),
      });

      await Promise.all([ctx1.watch(), ctx2.watch()]);
      console.log('[build-electron] Watching for changes...');
    } else {
      await Promise.all([
        esbuild.build({
          ...commonOptions,
          entryPoints: [path.join(rootDir, 'electron', 'main.ts')],
          outfile: path.join(rootDir, 'dist', 'electron-main.js'),
        }),
        esbuild.build({
          ...commonOptions,
          entryPoints: [path.join(rootDir, 'electron', 'preload.ts')],
          outfile: path.join(rootDir, 'dist', 'preload.js'),
        }),
      ]);
      console.log('[build-electron] Build complete.');
    }
  } catch (err) {
    console.error('[build-electron] Build failed:', err);
    process.exit(1);
  }
}

build();
