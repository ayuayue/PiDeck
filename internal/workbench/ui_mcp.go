//go:build !js && !android && !ios

package workbench

// The MCP settings: list, add and remove servers through pi's own CLI, so
// pi keeps ownership of mcp.json and the connections.

import (
	"fmt"
	"path/filepath"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// loadMCPServers asks pi for its servers; force rereads an already loaded
// list.
func (a *app) loadMCPServers(force bool) {
	if a.mcpBusy.GetUntracked() || (a.mcpLoaded && !force) {
		return
	}
	a.mcpBusy.Set(true)
	a.mcpErr.Set("")
	pi := a.piPath()
	dir := ""
	if ws := a.activeWorkspace(); ws != nil && !ws.Target.remote() && a.projectTrusted(ws) {
		dir = ws.Path
	}
	go func() {
		list, err := readMCPServers(pi, dir)
		a.cx.Post(func() {
			a.mcpBusy.Set(false)
			a.mcpLoaded = true
			if err != nil {
				a.mcpErr.Set(err.Error())
				return
			}
			a.mcpServers.Set(list)
		})
	}()
}

// openMCPAdd shows the add dialog with empty fields.
func (a *app) openMCPAdd() {
	a.mcpName.Set("")
	a.mcpURL.Set("")
	a.mcpCommand.Set("")
	a.mcpDesc.Set("")
	a.mcpLocal.Set(false)
	a.mcpAddErr.Set("")
	a.mcpAddBusy.Set(false)
	a.mcpAddOpen.Set(true)
}

// addMCPServer runs pi mcp add for the dialog's fields.
func (a *app) addMCPServer() {
	if a.mcpAddBusy.GetUntracked() {
		return
	}
	args, err := mcpAddArgs(a.mcpName.GetUntracked(), a.mcpCommand.GetUntracked(),
		a.mcpURL.GetUntracked(), a.mcpDesc.GetUntracked(), a.mcpLocal.GetUntracked())
	if err != nil {
		a.mcpAddErr.Set(err.Error())
		return
	}
	a.mcpAddBusy.Set(true)
	a.mcpAddErr.Set("")
	pi := a.piPath()
	dir := ""
	if a.mcpLocal.GetUntracked() {
		ws := a.activeWorkspace()
		if ws == nil || ws.Target.remote() || !a.projectTrusted(ws) {
			a.mcpAddBusy.Set(false)
			a.mcpAddErr.Set(apptext.T("请选择已信任的本机项目。"))
			return
		}
		dir = ws.Path
	}
	go func() {
		err := runMCP(pi, dir, args...)
		a.cx.Post(func() {
			a.mcpAddBusy.Set(false)
			if err != nil {
				a.mcpAddErr.Set(err.Error())
				return
			}
			a.mcpAddOpen.Set(false)
			a.toast(ui.ToastSuccess, "已添加 MCP 服务器", a.mcpName.GetUntracked())
			a.loadMCPServers(true)
		})
	}()
}

// removeMCPServer asks, then runs pi mcp remove.
func (a *app) removeMCPServer(s mcpServer) {
	a.askConfirm("移除 MCP 服务器", "「"+s.Name+"」会从 mcp.json 里删除，pi 也会断开它。", "移除", func() {
		pi := a.piPath()
		dir := ""
		if s.Scope != "global" {
			dir = s.project
			if ws := a.workspaceOf(dir); ws == nil || !a.projectTrusted(ws) {
				a.toast(ui.ToastWarning, "请选择已信任的本机项目。", "")
				return
			}
		}
		go func() {
			err := runMCP(pi, dir, mcpRemoveArgs(s.Name, s.Scope != "global")...)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "移除失败", err.Error())
					return
				}
				a.toast(ui.ToastSuccess, "已移除 "+s.Name, "")
				a.loadMCPServers(true)
			})
		}()
	})
}

func (a *app) mcpAuthorize(s mcpServer, action string) {
	local := s.Scope != "global"
	if local {
		if ws := a.workspaceOf(s.project); ws == nil || !a.projectTrusted(ws) {
			a.toast(ui.ToastWarning, "请选择已信任的本机项目。", "")
			return
		}
	}
	args, err := mcpAuthArgs(action, s.Name, local)
	if err != nil {
		a.toast(ui.ToastError, "配置失败", err.Error())
		return
	}
	dir := loginDir()
	if local {
		dir = s.project
	}
	a.term.open.Set(true)
	a.remember()
	a.term.newCommandTab(dir, localTarget, "MCP · "+s.Name, piTerminalCommand(a.piPath(), args...), func() { a.loadMCPServers(true) })
}

// settingsMCP lists the servers with add and remove.
func (a *app) settingsMCP() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		list := a.mcpServers.Get()
		busy := a.mcpBusy.Get()
		var rows []core.Node
		for i, s := range list {
			srv := s
			stateColor := colors.Muted
			switch srv.State {
			case "connected":
				stateColor = colors.Up
			case "failed", "error":
				stateColor = colors.Danger
			}
			help := srv.Transport
			if len(srv.Tools) > 0 {
				help += fmt.Sprintf(" · %d 个工具", len(srv.Tools))
			}
			if srv.Exposure != "" {
				help += " · " + srv.Exposure
			}
			if srv.Error != "" {
				help += " · " + srv.Error
			}
			if !srv.Enabled {
				help = "已停用 · " + help
			}
			controls := []core.Node{
				ui.Text(srv.State, 10.5, ui.Medium, stateColor),
				a.pressIcon(lucide.Trash, "移除 "+srv.Name, 24, 12, nil, func() { a.removeMCPServer(srv) },
					fmt.Sprintf("mcp-remove-%d", i)),
			}
			if srv.Transport == "http" || srv.Transport == "streamable-http" {
				controls = append(controls,
					ui.IconButton{Icon: lucide.LogIn, Label: apptext.T("登录"), TestID: "mcp-login-" + srv.Name, OnPress: func() { a.mcpAuthorize(srv, "login") }},
					ui.IconButton{Icon: lucide.LogOut, Label: apptext.T("登出"), TestID: "mcp-logout-" + srv.Name, OnPress: func() { a.mcpAuthorize(srv, "logout") }})
			}
			control := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: controls}
			rows = append(rows, setRow(srv.Name+" · "+srv.Scope, help, control))
			if i < len(list)-1 {
				rows = append(rows, setDivider())
			}
		}
		if len(rows) == 0 {
			rows = append(rows, setRow("还没有 MCP 服务器", "添加一个 HTTP 地址或启动命令，pi 会连接它。", nil))
		}
		return a.scrollStashFor("settingsMCP:1").bind(cx, core.Scroll{TestID: "settings-page", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 4}, Children: []core.Node{
				setGroup("智能体记忆", setRow("会话记忆工具", "让已信任的本机 pi 会话搜索历史和读写项目记忆。开启后重启 Agent 生效。",
					ui.Switch{Label: apptext.T("会话记忆工具"), TestID: "memory-tools-toggle", Checked: func() bool { return a.cfg.MemoryTools }, OnChange: func(on bool) {
						a.cfg.MemoryTools = on
						a.st.edit(func(c *config) { c.MemoryTools = on })
						a.bumpSettings()
					}}),
					ui.Button{Text: apptext.T("管理记忆"), TestID: "memory-manage", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.openPane(paneMemory) }}),
				setGroup("服务器", rows...),
				core.Text{Content: apptext.T("列表来自 pi mcp list；服务器配置由 pi 保存在 mcp.json 里。"),
					Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Faint)},
				core.Show{When: func() bool { return a.mcpErr.Get() != "" }, Then: func(cx *core.Scope) core.Node {
					return core.Text{Content: a.mcpErr.Get(), MaxLines: 3, Style: core.Style{FontSize: 11, LineHeight: 16},
						StyleFunc: ui.Colored(colors.Danger)}
				}},
				core.View{Style: core.Style{Direction: core.Row, Gap: 8, Margin: core.Edges{Top: 4}}, Children: []core.Node{
					ui.Button{Text: apptext.T("添加服务器"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "mcp-add",
						OnPress: a.openMCPAdd},
					ui.Button{Text: apptext.T("刷新"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						Disabled: func() bool { return busy }, OnPress: func() { a.loadMCPServers(true) }},
					ui.Button{Text: apptext.T("编辑 mcp.json"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "mcp-edit-json",
						OnPress: func() { a.openPiConfigFile("mcp.json") }},
					core.Show{When: func() bool {
						ws := a.activeWorkspace()
						return ws != nil && !ws.Target.remote() && a.projectTrusted(ws)
					},
						Then: func(*core.Scope) core.Node {
							return ui.Button{Text: apptext.T("编辑项目 MCP 配置"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "mcp-edit-project-json", OnPress: func() {
								if ws := a.activeWorkspace(); ws != nil && !ws.Target.remote() && a.projectTrusted(ws) {
									a.openEditorFile(ws.Path, filepath.Join(ws.Path, ".pi", "mcp.json"))
								}
							}}
						}},
				}},
			}},
		}})
	})
}

// mcpDialog adds one server.
func (a *app) mcpDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		busy := a.mcpAddBusy.Get()
		field := func(label, placeholder, testID string, value *core.Signal[string]) core.Node {
			return core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text(label, 10.5, ui.Medium, colors.Muted),
				core.Input{Value: value.Get, OnChange: value.Set, Placeholder: placeholder, Label: label, TestID: testID,
					Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), FontSize: 12, FontFamily: viewkit.MonoFont(), Color: colors.Text(),
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 7}},
			}}
		}
		var status core.Node
		if a.mcpAddErr.Get() != "" {
			status = core.Text{Content: a.mcpAddErr.Get(), MaxLines: 3, Style: core.Style{FontSize: 11, LineHeight: 16},
				StyleFunc: ui.Colored(colors.Danger)}
		}
		return ui.Dialog{
			Open:         a.mcpAddOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.mcpAddOpen.Set(open) },
			Title:        apptext.T("添加 MCP 服务器"),
			TestID:       "mcp-dialog",
			Style:        core.Style{Width: a.dialogWidth()},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				field("名字", "server-name", "mcp-name", a.mcpName),
				field("URL（HTTP）", "https://…/mcp", "mcp-url", a.mcpURL),
				field("命令与参数", "npx -y some-mcp-server", "mcp-command", a.mcpCommand),
				field("说明", "这个服务器提供什么", "mcp-desc", a.mcpDesc),
				core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
					ui.Text(apptext.T("范围"), 10.5, ui.Medium, colors.Muted),
					choiceChips([]choice[bool]{{Value: false, Label: apptext.T("全局")}, {Value: true, Label: apptext.T("本项目")}},
						func() bool { return a.mcpLocal.Get() }, func(v bool) { a.mcpLocal.Set(v) }),
				}},
				core.Text{Content: apptext.T("URL 与命令二选一；命令和参数用空格分隔。"), Style: core.Style{FontSize: 11},
					StyleFunc: ui.Colored(colors.Faint)},
				status,
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "mcp-cancel",
					OnPress: func() { a.mcpAddOpen.Set(false) }},
				ui.Button{Text: apptext.T("添加"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mcp-add-go",
					Disabled: func() bool { return busy }, OnPress: a.addMCPServer},
			},
		}
	})
}
