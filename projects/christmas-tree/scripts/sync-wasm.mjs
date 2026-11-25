/**
 * Copies the MediaPipe wasm runtime out of node_modules into public/wasm.
 *
 * Why not just commit public/wasm? Because it is a byte-for-byte copy of an
 * installed npm package. Committing it means that bumping
 * @mediapipe/tasks-vision leaves a stale runtime in place, and a wasm runtime
 * that disagrees with its JS wrapper fails in obscure ways at load time.
 * Running this on postinstall keeps the two locked together by construction.
 *
 * The .task model files, by contrast, *are* committed: they are pinned by URL
 * to a specific model version, cannot drift against the npm package, and
 * keeping them in the repo means a fresh clone works with no network access.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const target = join(root, 'public', 'wasm');

if (!existsSync(source)) {
  console.error(
    '[sync-wasm] 找不到 %s\n' +
      '           先跑 npm install 安装 @mediapipe/tasks-vision，再重试。',
    source
  );
  process.exit(1);
}

// Replace wholesale rather than merging, so files dropped from a newer
// release of the package don't linger.
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

console.log('[sync-wasm] MediaPipe wasm 运行时已同步到 public/wasm');
