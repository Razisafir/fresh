// esbuild config — bundles Kovix Electron app
// Updated for the Phase 0 pivot (D-015): entry point is now electron/main.ts
// instead of the old VS Code extension (src/extension.ts).
// The `vscode` module is no longer external — we're a standalone Electron app.
//
// Entry points:
//   electron/main.ts    → dist/electron-main.js
//   electron/preload.ts → dist/preload.js
//
// Externalizes: electron, Node built-ins, hnswlib-node.

const esbuild = require('esbuild');
const path = require('path');

const rootDir = __dirname;
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

async function main() {
  const builds = [
    {
      ...commonOptions,
      entryPoints: [path.join(rootDir, 'electron', 'main.ts')],
      outfile: path.join(rootDir, 'dist', 'electron-main.js'),
    },
    {
      ...commonOptions,
      entryPoints: [path.join(rootDir, 'electron', 'preload.ts')],
      outfile: path.join(rootDir, 'dist', 'preload.js'),
    },
  ];

  if (isWatch) {
    const contexts = await Promise.all(builds.map(b => esbuild.context(b)));
    await Promise.all(contexts.map(ctx => ctx.watch()));
    console.log('[esbuild] watching...');
  } else {
    await Promise.all(builds.map(b => esbuild.build(b)));
    console.log('[esbuild] build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
