---
name: nsgo
description: 写或改 PiDeck V2 里的 NSGo 界面/测试代码前先读它：指向与 go.mod 版本匹配的官方 NSGo 技能（API 事实、组件、测试、打包），并说明本项目的规则优先。Use when touching core/base/ui elements, signals, styles, layout, nsgotest, nsgo.yaml, or go tool nsgo commands.
---

# NSGo：本项目入口

NSGo 的官方技能随依赖一起发布，**按当前 `go.mod` 锁定的版本读它**，不要凭记忆写 API（Go 少一个字段就编译不过）：

```sh
go list -m -f '{{.Dir}}' github.com/nsgo-dev/nsgo
# 本仓库当前是 .../go/pkg/mod/github.com/nsgo-dev/nsgo@v0.3.0
```

然后读这个目录下的：

- `skills/nsgo/SKILL.md` —— 应用作者视角的总纲（`go tool nsgo` 命令、`nsgotest`、打包、发布）。
- `skills/nsgo/references/authoring.md`、`components.md`、`testing.md`、`shipping.md` —— 细则。
- `examples/gallery` 与 `examples/hello` —— 每个元素/组件/服务的真实写法，照它写而不是另发明。

模块目录不在本地时先 `go mod download github.com/nsgo-dev/nsgo`。文档全文在 <https://nsgo.dev/llms-full.txt>，与本地版本可能有偏差，以模块源码为准。

## 项目规则优先

`AGENTS.md`（编译范围硬约束、验证分级、H1–H10）和 `ARCHITECTURE.md` 压过官方技能的任何建议：官方技能会建议 `go tool nsgo check`、全目标构建这类全量动作，本项目只跑与改动直接相关的窄验证（单包 `go test`、单个 `-target` 构建）。新增文案、配置项、命令、设置项照 AGENTS.md 的清单补齐。

## 边界

- 不修改模块缓存里的 nsgo（只读，且它不是本仓库的代码）；要反馈框架问题就另开 issue。
- 桌面能力只属于 `internal/workbench`，`internal/client` 不得触碰（H2/H4）。
