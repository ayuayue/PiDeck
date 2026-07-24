# 开发与打包

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Electron 开发模式 |
| `npm run typecheck` | 运行 TypeScript 类型检查 |
| `npm run build` | 构建 Renderer、Main 和 Preload 产物 |
| `npm run pack` | 构建并生成未安装的应用目录 |
| `npm run dist` | 为当前平台打包 |
| `npm run dist:win` | 打包 Windows NSIS、portable、zip |
| `npm run dist:mac` | 打包 macOS dmg、zip |
| `npm run dist:linux` | 打包 Linux AppImage、deb、tar.gz |
| `npm run docs:dev` | 启动本站点开发服务 |
| `npm run docs:build` | 构建本站点 |
| `npm run docs:preview` | 预览本站点构建产物 |

## 桌面端打包范围

桌面端使用 `electron-builder`。当前 `package.json` 中的打包文件是白名单：

```json
"files": [
  "out/**/*",
  "package.json"
]
```

因此 `docs-site/`、`docs/`、README 和 GitHub Pages 配置不会进入最终桌面安装包，也不会增加桌面端包体大小。

## 官网与文档

本站点使用 VitePress，源码位于 `docs-site/`。GitHub Pages workflow 会在推送到 `main` 后构建 `docs-site/.vitepress/dist` 并发布。

站点已使用自定义域名 `https://pideck.caoayu.top`，Pages workflow 中设置：

```yaml
env:
  VITEPRESS_BASE: /
  DOCS_SITE_ORIGIN: https://pideck.caoayu.top
```

`docs-site/public/CNAME` 写入 `pideck.caoayu.top`，构建后进入产物，避免部署冲掉域名绑定。
若临时需要兼容旧地址 `https://ayuayue.github.io/PiDeck/`，可本地设置 `VITEPRESS_BASE=/PiDeck/`。
