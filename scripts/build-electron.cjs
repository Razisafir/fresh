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
const fs = require('fs');

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

    // Copy Monaco editor files to renderer/monaco/ for the editor component.
    copyMonacoFiles();
  } catch (err) {
    console.error('[build-electron] Build failed:', err);
    process.exit(1);
  }
}

/**
 * Copy Monaco editor dist files to renderer/monaco/vs/ so the renderer
 * can load them via <script> tags. This is the simplest approach for
 * Electron — no bundling, just serve the files directly.
 */
function copyMonacoFiles() {
  const src = path.join(rootDir, 'node_modules', 'monaco-editor', 'min', 'vs');
  const dest = path.join(rootDir, 'renderer', 'monaco', 'vs');

  if (fs.existsSync(dest)) {
    // Quick check: if the dest already exists and the loader.js is present, skip.
    if (fs.existsSync(path.join(dest, 'loader.js'))) {
      console.log('[build-electron] Monaco files already present, skipping copy.');
      return;
    }
  }

  console.log('[build-electron] Copying Monaco editor files...');
  copyDirSync(src, dest);
  console.log('[build-electron] Monaco files copied to renderer/monaco/vs/');
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

build();
