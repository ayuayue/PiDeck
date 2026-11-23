//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) pluginArchiveSection() core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		const page = 20
		window := core.NewSignal(cx, page)
		return core.Dynamic(func(*core.Scope) core.Node {
			archive := a.pluginArchive.Get()
			if archive.err != nil {
				return setGroup("已卸载的插件", setRow("无法读取已卸载的插件", pluginFileError(archive.err), nil))
			}
			if len(archive.items) == 0 {
				return nil
			}
			end := min(len(archive.items), window.Get())
			rows := make([]core.Node, 0, end+2)
			rows = append(rows, setRow("可以恢复到原位置", "插件设置和启停状态会保留。", nil))
			for _, item := range archive.items[:end] {
				title := item.label
				if item.version != "" {
					title += "  " + item.version
				}
				detail := item.name + " · " + item.archivedAt.Local().Format("2006-01-02 15:04")
				if item.problem != "" {
					detail = viewkit.FirstLine(item.problem, 120)
				}
				rows = append(rows, setRow(title, detail, ui.Button{
					Text: apptext.T("恢复插件"), Size: ui.SizeSmall, Variant: ui.ButtonGhost,
					TestID: archivedPluginTestID(item), Disabled: a.pluginFileBusy.Get,
					OnPress: func() { a.reinstallArchivedPlugin(item) },
				}))
			}
			if end < len(archive.items) {
				rows = append(rows, ui.Button{Text: apptext.T("加载更多"), Size: ui.SizeSmall, Variant: ui.ButtonGhost,
					TestID: "plugin-archive-more", OnPress: func() { window.Update(func(n int) int { return n + page }) }})
			}
			return setGroup("已卸载的插件", rows...)
		})
	})
}
