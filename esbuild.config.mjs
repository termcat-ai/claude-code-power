import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

// chokidar 本身是纯 JS，直接 bundle。
// fsevents 是 macOS 原生可选加速；chokidar 内部有 try/catch 降级到 fs.watch，
// 保持 external 即可 —— 运行时找不到也不会 crash。
const external = ['fsevents'];

async function build() {
  await esbuild.build({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    sourcemap: true,
    external,
  });

  // Ship manifest alongside built entry so plugin-manager can parse it.
  if (!fs.existsSync('dist')) fs.mkdirSync('dist', { recursive: true });
  fs.copyFileSync('package.json', path.join('dist', 'package.json'));

  console.log('[claude-code-power] build complete');
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
