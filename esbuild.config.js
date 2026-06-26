// esbuild config — bundles src/extension.ts → dist/extension.js
// Per 02_ARCHITECTURE.md §5.6: esbuild (faster, simpler than webpack).
// The `vscode` module is marked external — it is provided by the VS Code
// extension host at runtime. All other deps are bundled into dist/extension.js.

const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !isWatch,
  logLevel: 'info',
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[esbuild] watching...');
  } else {
    await esbuild.build(buildOptions);
    console.log('[esbuild] build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
