import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';

// get-windows / koffi 已在 vite.main.config 外部化（原生 .node 不能进
// bundle），打包时必须以文件形式随 app 发布 —— 这里从真实 node_modules
// 算出它们的运行时依赖闭包（get-windows 运行时要 require
// @mapbox/node-pre-gyp 定位 .node）。node-gyp / node-addon-api 只在
// 安装期编译用，不进包。
const INSTALL_ONLY_MODULES = new Set(['node-gyp', 'node-addon-api']);
const SCROLL_RUNTIME_MODULES = (() => {
  const wanted = new Set(['get-windows', 'koffi']);
  const queue = ['get-windows', 'koffi'];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    let pj: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      pj = require(path.join(process.cwd(), 'node_modules', name, 'package.json'));
    } catch {
      continue;
    }
    const deps = [
      ...Object.keys(pj.dependencies ?? {}),
      ...Object.keys(pj.optionalDependencies ?? {}),
    ];
    for (const dep of deps) {
      if (!wanted.has(dep) && !INSTALL_ONLY_MODULES.has(dep)) {
        wanted.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...wanted];
})();

/** 白名单模块的完整路径前缀（带尾斜杠） */
const RUNTIME_PREFIXES = SCROLL_RUNTIME_MODULES.map(
  (m) => `/node_modules/${m}/`,
);
/**
 * 是否属于运行时闭包：文件落在白名单模块内，**或是通往白名单模块的
 * 祖先目录**（`/node_modules`、`/node_modules/@koromix` 这类目录本身
 * 不在白名单前缀里，不判祖先的话整个目录在下钻前就被跳过）。
 */
function inRuntimeClosure(file: string): boolean {
  return RUNTIME_PREFIXES.some(
    (prefix) => file.startsWith(prefix) || prefix.startsWith(`${file}/`),
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    // 原生 .node 不能从 asar 内加载 —— 必须解包到 app.asar.unpacked
    // （get-windows 的 N-API 二进制 + koffi 的平台包 @koromix/koffi-*）
    asar: {
      unpack: '**/node_modules/{get-windows/lib/binding,@koromix}/**/*.node',
    },
    ignore: (file) => {
      if (!file) return false;
      // forge-vite 插件默认 ignore 掉 .vite 之外的一切（它期望依赖全部
      // 打进 bundle），接管后自行放行：.vite、包清单、运行时依赖闭包
      if (file.startsWith('/.vite') || file === '/package.json') return false;
      if (file === '/node_modules' || file.startsWith('/node_modules/')) {
        return !inRuntimeClosure(file);
      }
      return true;
    },
  },
  // onlyModules: [] = rebuild 阶段不重建任何模块。唯一的原生依赖
  // get-windows 是 N-API 预编译二进制（ABI 与 Electron 版本无关），
  // 无需重编；反而 @electron/rebuild 会把它误判成 node-gyp 模块
  // （node-pre-gyp 装在顶层没被识别），进而要求 VS 编译环境 —— 本机
  // 只有 VS 18，@electron/node-gyp 最高只认到 v17，直接编译失败。
  // 以后若新增真正需要重编译的原生依赖，把模块名加进数组即可。
  rebuildConfig: {
    onlyModules: [],
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          // 三个窗口共用同一份 preload
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
        {
          name: 'overlay',
          config: 'vite.overlay.config.ts',
        },
        {
          name: 'pin',
          config: 'vite.pin.config.ts',
        },
        {
          name: 'scroll',
          config: 'vite.scroll.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
