import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';
import { inRuntimeClosure, runtimePrefixes } from './scripts/runtime-closure';

// 原生模块已在 vite.main.config 外部化，打包时必须以文件形式随 app 发布。
// 闭包按 Node 规则逐级解析（见 scripts/runtime-closure.ts），嵌套安装的副本也会收集。
const RUNTIME_PREFIXES = runtimePrefixes(__dirname, ['get-windows', 'koffi', 'electron-liquid-glass', 'electron-snip']);

const config: ForgeConfig = {
  packagerConfig: {
    // Squirrel 安装包的 nuspec 必需 authors；exe 元数据里的产品名
    executableName: 'screenshots',
    icon: path.join(__dirname, 'resources/icons/app'),
    // 托盘运行时读的应用图标 PNG 与单色模板字形（白/黑）；探针同理 ——
    // 都经 extraResource 直达 Contents/Resources，dev 下走仓库路径。
    // 源码与构建脚本在 repo 的 resources/ 下，被 ignore 排除、不进 asar。
    extraResource: [
      './resources/icons/app.png',
      './resources/icons/app-template.png',
      './resources/icons/app-template-inverse.png',
    ],
    // 原生 .node 不能从 asar 内加载 —— 必须解包到 app.asar.unpacked
    // （get-windows / koffi / Liquid Glass 的 N-API 二进制）
    asar: {
      unpack: '**/node_modules/{get-windows/lib/binding,@koromix,electron-liquid-glass}/**/*.node',
    },
    ignore: (file) => {
      if (!file) return false;
      // forge-vite 插件默认 ignore 掉 .vite 之外的一切（它期望依赖全部
      // 打进 bundle），接管后自行放行：.vite、包清单、运行时依赖闭包
      if (file.startsWith('/.vite') || file === '/package.json') return false;
      if (file === '/node_modules' || file.startsWith('/node_modules/')) {
        return !inRuntimeClosure(file, RUNTIME_PREFIXES);
      }
      return true;
    },
  },
  // onlyModules: [] = rebuild 阶段不重建任何模块。原生依赖均为 N-API
  // 预编译二进制（ABI 与 Electron 版本无关），
  // 无需重编；反而 @electron/rebuild 会把它误判成 node-gyp 模块
  // （node-pre-gyp 装在顶层没被识别），进而要求 VS 编译环境 —— 本机
  // 只有 VS 18，@electron/node-gyp 最高只认到 v17，直接编译失败。
  // 以后若新增真正需要重编译的原生依赖，把模块名加进数组即可。
  rebuildConfig: {
    onlyModules: [],
  },
  makers: [new MakerSquirrel({}), new MakerZIP({}, ['darwin']), new MakerRpm({}), new MakerDeb({})],
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
          name: 'scroll',
          config: 'vite.scroll.config.ts',
        },
        {
          name: 'history',
          config: 'vite.history.config.ts',
        },
        {
          name: 'record',
          config: 'vite.record.config.ts',
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
