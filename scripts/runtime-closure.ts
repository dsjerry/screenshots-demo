import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 打包时需要随 app 发布的 node_modules 目录（运行时依赖闭包）。
 *
 * 依赖按 Node 的规则解析：从依赖方所在目录开始，逐级向上查找 `node_modules/<name>`。
 * 嵌套安装的副本（例如 electron-snip 自带的 get-windows）因此也会被收集，
 * 不会因为「只看顶层」而漏掉它的依赖（曾因此出现打包版 Cannot find module 'consola/basic'）。
 */

/** 只在安装期编译用，不进包 */
const INSTALL_ONLY = new Set(['node-gyp', 'node-addon-api']);

/** 从 fromDir 出发按 Node 规则找到 name 的包目录；找不到返回 null。 */
export function resolvePackageDir(fromDir: string, name: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 从根模块出发做广度遍历，返回闭包内全部包目录（绝对路径，去重）。 */
export function runtimePackageDirs(projectRoot: string, roots: string[]): string[] {
  const queue: string[] = [];
  for (const name of roots) {
    const dir = resolvePackageDir(projectRoot, name);
    if (dir) queue.push(dir);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
    const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dep of [...Object.keys(pj.dependencies ?? {}), ...Object.keys(pj.optionalDependencies ?? {})]) {
      if (INSTALL_ONLY.has(dep)) continue;
      const depDir = resolvePackageDir(dir, dep);
      if (depDir) queue.push(depDir);
    }
  }
  return out;
}

/**
 * 转成打包器使用的路径前缀：相对项目根、以 `/` 开头并带尾斜杠，
 * 例如 `/node_modules/electron-snip/node_modules/get-windows/`。
 */
export function runtimePrefixes(projectRoot: string, roots: string[]): string[] {
  return runtimePackageDirs(projectRoot, roots)
    .map((dir) => path.relative(projectRoot, dir).split(path.sep).join('/'))
    .filter((rel) => rel !== '' && !rel.startsWith('..'))
    .map((rel) => `/${rel}/`);
}

/**
 * 是否属于运行时闭包：文件落在白名单目录内，**或是通往白名单目录的祖先目录**
 * （`/node_modules`、`/node_modules/electron-snip` 这类目录本身不在前缀里，
 * 不判祖先的话整个目录在下钻前就被跳过）。
 */
export function inRuntimeClosure(file: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => file.startsWith(prefix) || prefix.startsWith(`${file}/`));
}
