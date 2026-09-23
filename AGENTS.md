# 校验

默认跑 `npm run typecheck`（`tsc --noEmit`，覆盖 `src/**` + `forge.config.ts` + `vite.*.config.ts`，约 7s）。
满足下面白名单才跳过；拿不准就跑。

## 免校验

纯注释 / 文档 / UI 文案 / CSS / 常量数值，且不新增、不删除、不改任何 `.ts` 签名。

## 必须跑 typecheck

- 动了 `src/shared/`（`types.ts` / `channels.ts` / `api.ts` / `pin-layout.ts`）
- 动了 `src/global.d.ts`、`forge.config.ts`、`vite.*.config.ts`、`forge.env.d.ts`
- 新增 / 删除 / 重命名文件，或改了函数签名、IPC payload
- 加新的 renderer 入口

## 什么时候才需要打包校验

只有改动影响「怎么被打包」时才跑 `npm run package`：preload 路径、HTML 入口、资源文件、forge/vite 配置。
`npm run make` 不用于日常验证，且**不能与 `npm start` 并发**（dev watcher 会 fs.watch `out/`，Windows 上 EBUSY 直接把 Forge 打崩）。
