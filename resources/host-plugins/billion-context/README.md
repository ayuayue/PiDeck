# billion-context（PiDeck 内置示例插件）

查看并启停 [billion-context](https://www.npmjs.com/package/billion-context) 的本地代理（`bili`），
并用 PiDeck 的内置浏览器打开它的 Web 面板 `/__bili/`。

## 前置条件

billion-context 需要自行安装，PiDeck 不会替你装：

```bash
npm i -g billion-context
```

装好后本面板会显示「未运行」，点「启动」即可。

## 这个插件做了什么

| 按钮 | 行为 |
| --- | --- |
| 启动 | 主进程执行 `bili` 起一个常驻代理，轮询 `bili doctor --json` 直到报告进程存活（最多 20 秒） |
| 停止 | 按 `bili doctor --json` 报告的 pid 终止进程（外部 CLI 没有 `stop` 子命令，只能按 pid） |
| 打开面板 | 用 PiDeck 的内置浏览器打开 `http://127.0.0.1:<port>/__bili/` |
| ↻ | 重新查一次服务状态（查询期间图标转圈，因为要跑一次 `bili doctor`） |

多实例：billion-context 会有多个活实例（常驻代理 + pi 等 agent 自己拉起的 lane daemon，各有各的会话库）。检测到 ≥2 个实例时，面板会列出全部实例（来自 `bili doctor --json` 的进程表），每行一个「打开」按钮，开的是那个实例自己的面板。

「停止」**不保证停得住**：pi 用 billion-context 时，这个代理是 pi 自己的扩展持有的，进程一死就会被立刻重新拉起（实测约 2 秒后换一个新 pid 监听同一端口）。这种情况下面板会显示「已终止，但又被自动拉起」并给出新 pid，而不是假装停成功；要彻底停掉得先退出 pi。

端口不写死：以 `bili doctor --json` 的 `processes[].port` 为准（默认配置 8788，pi lane 自拉代理时常落在 28800）。

## 权限说明

清单里只声明了 `service.local`，并点名了 `billion-context`：

```json
"permissions": ["service.local"],
"services": ["billion-context"]
```

- 插件本身**没有**执行任意命令的能力。命令名、参数、端口都在 PiDeck 主进程的服务适配器里，插件只能点名服务 id。
- 未在 PiDeck 里实现适配器的服务，写进 `services` 也会被清单校验拒绝。
- 插件页面 CSP 是 `connect-src 'none'; frame-src 'none'`，所以它**不能**内嵌这个面板；「打开面板」是把 URL 交给 PiDeck 去开内置浏览器。

## 安全提醒

bili 的 Web 面板只监听 `127.0.0.1` 且**没有鉴权**。不要把这个端口暴露到公网或局域网。

## 面板形态

`pideck-plugin.json` 里声明的是 `"presentation": "popover"`：侧栏「定时任务」下方那一行点开就在旁边展开一个浮层，只有状态行和三个按钮，不占满屏幕。从设置页/命令面板这类没有锚点的入口打开时会退化成小对话框（同一份页面代码）。

## 改这个插件

这是普通宿主插件，直接改 `resources/host-plugins/billion-context/` 里的文件即可；改完回 PiDeck「PiDeck 插件」设置页点「重新扫描」。因为授权绑定整包代码指纹，内容一变就需要重新确认授权。

已经落位到 `userData/host-plugins/billion-context/` 的副本，只有在**内容仍等于上次落位时的指纹**（也就是没被手改过）时才会随新版 PiDeck 自动刷新；手改过的副本永不被覆盖。改坏了可以删掉 `userData` 里那个目录再重启，PiDeck 会重新落位一份。

（唯一例外：早期 PiDeck 版本落位的副本没有「落位记录」，那次升级只能靠 manifest 版本号判断是不是我们自己放的——版本不同就替换一次，之后又回到「手改过就不覆盖」。）

API 参考见 PiDeck 仓库的 `docs/host-plugin-dev-guide.md`。
