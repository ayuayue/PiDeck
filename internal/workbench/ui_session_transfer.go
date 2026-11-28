//go:build !js && !android && !ios

package workbench

import (
	"fmt"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func transferTitle(s sessionTransferState) string {
	if s.Kind == "legacy" {
		switch s.Status {
		case "completed":
			return apptext.T("旧版数据迁移完成")
		case "failed":
			return apptext.T("旧版数据迁移未完成")
		default:
			return apptext.T("正在后台迁移旧版数据")
		}
	}
	if s.Status == "completed" {
		return apptext.T("目录会话导入完成")
	}
	if s.Status == "failed" {
		return apptext.T("数据导入未完成")
	}
	return apptext.T("正在导入目录中的会话")
}

func transferProgressText(s sessionTransferState) string {
	switch s.Status {
	case "checking", "scanning":
		return apptext.T("正在查找会话和聊天文件…")
	case "saving":
		return apptext.T("正在保存迁移结果…")
	default:
		return fmt.Sprintf(apptext.T("已处理 %d / %d 个文件"), s.Done, s.Total)
	}
}

func (a *app) transferProgress(testID string) core.Node {
	return ui.Progress{TestID: testID, LabelFunc: func() string { return transferProgressText(a.transfer.Get()) },
		Indeterminate: func() bool {
			s := a.transfer.Get()
			return s.Total == 0 || s.Status == "scanning" || s.Status == "saving" || s.Status == "checking"
		},
		Value: func() float32 {
			s := a.transfer.Get()
			if s.Total == 0 {
				return 0
			}
			return float32(s.Done) * 100 / float32(s.Total)
		}}
}

// A compact persistent banner leaves the workbench usable while copying.
func (a *app) sessionTransferBanner() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		if a.transfer == nil {
			return core.View{}
		}
		s := a.transfer.Get()
		if !s.Visible {
			return core.View{}
		}
		colors := ui.ColorsOf(cx)
		children := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.IconOf(lucide.FolderInput, 14, colors.Muted),
				core.Text{Content: transferTitle(s), Style: core.Style{FontSize: viewkit.PanelCaptionSize, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Text)},
				ui.Button{Text: apptext.T("查看详情"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "session-transfer-details", OnPress: func() { a.transferOpen.Set(true) }},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "session-transfer-hide", OnPress: func() { s := a.transfer.GetUntracked(); s.Visible = false; a.transfer.Set(s) }},
			}},
		}
		if s.running() {
			children = append(children, a.transferProgress("session-transfer-banner-progress"), core.Text{Content: transferProgressText(s), Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)})
		}
		return core.View{TestID: "session-transfer-banner", Style: core.Style{Padding: core.Symmetric(8, viewkit.PanelInset), Gap: 5, Background: colors.Inset()}, Children: children}
	})
}

func (a *app) sessionTransferDialog() core.Node {
	if a.transfer == nil {
		return core.View{}
	}
	return ui.Dialog{Open: a.transferOpen.Get, OnOpenChange: func(open bool, _ base.Reason) { a.transferOpen.Set(open) },
		TitleFunc: func() string { return transferTitle(a.transfer.Get()) }, TestID: "session-transfer-dialog",
		Style:    core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(600)},
		Children: []core.Node{a.sessionTransferBody()}, Footer: []core.Node{a.sessionTransferFooter()}}
}

func (a *app) sessionTransferBody() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		if a.transfer == nil {
			return core.View{}
		}
		s := a.transfer.Get()
		colors := ui.ColorsOf(cx)
		children := []core.Node{
			core.Text{Content: apptext.T("迁移在后台进行，可以关闭此窗口继续使用。旧文件会保留，已有数据不会被覆盖。"), Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: viewkit.PanelLineHeight}, StyleFunc: ui.Colored(colors.Muted)},
		}
		if s.Kind == "legacy" {
			children = append(children, core.Text{Content: apptext.T("本次迁移包含本机 pi 会话、项目、标题、置顶和聊天文件；收藏、分组、ACP、DSH 及插件暂不自动转换。"), Style: core.Style{FontSize: 11, LineHeight: 18}, StyleFunc: ui.Colored(colors.Muted)})
		}
		if s.Source != "" {
			children = append(children, core.Text{Content: s.Source, TestID: "session-transfer-source", Style: core.Style{FontSize: 11, LineHeight: 17, FontFamily: viewkit.MonoFont()}, StyleFunc: ui.Colored(colors.Muted)})
		}
		if s.running() {
			children = append(children, a.transferProgress("session-transfer-progress"), core.Text{Content: transferProgressText(s), Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)})
		} else {
			children = append(children, core.Text{Content: a.transferSummary(s), TestID: "session-transfer-summary", Style: core.Style{FontSize: 12, LineHeight: 19}, StyleFunc: ui.Colored(colors.Text)})
		}
		if s.Error != "" {
			children = append(children, core.Text{Content: s.Error, TestID: "session-transfer-error", Style: core.Style{FontSize: 11, LineHeight: 18}, StyleFunc: ui.Colored(colors.Danger)})
		}
		if s.Status == "failed" || s.Kind == "directory" {
			children = append(children, core.Text{Content: apptext.T("手动恢复：设置 → 数据管理 → 从目录导入会话，选择旧会话目录。会递归导入 pi 的 .jsonl 文件，并跳过已导入的会话；其他 Agent 的记录请使用「导入会话」。"), TestID: "session-transfer-help", Style: core.Style{FontSize: 11.5, LineHeight: 19}, StyleFunc: ui.Colored(colors.Muted)},
				core.Text{Content: apptext.T("pi 默认会话目录为 ~/.pi/agent/sessions；使用过自定义 sessionDir 时，请选择对应目录。聊天工作目录里的普通文件可手动复制到新版本的 chat 目录。"), Style: core.Style{FontSize: 11, LineHeight: 18}, StyleFunc: ui.Colored(colors.Muted)})
		}
		return core.Scroll{Style: core.Style{MaxHeight: core.Pt(420)}, Children: []core.Node{
			core.View{Style: core.Style{Gap: 12, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: children}}}
	})
}

func (a *app) sessionTransferFooter() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		s := a.transfer.Get()
		footer := []core.Node{}
		if s.Status == "failed" && s.Kind == "legacy" {
			footer = append(footer, ui.Button{Text: apptext.T("重试迁移"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "legacy-migration-retry", OnPress: func() { a.launchLegacyMigration(true) }})
		}
		if !s.running() {
			footer = append(footer, ui.Button{Text: apptext.T("从目录导入会话"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "session-transfer-import-directory", OnPress: a.pickSessionDirectory})
		}
		footer = append(footer, ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.transferOpen.Set(false) }})
		return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: footer}
	})
}

func (a *app) sessionTransferSettings() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		if a.transfer == nil || a.transfer.Get().Kind == "" {
			return core.View{}
		}
		s := a.transfer.Get()
		return setRow("迁移与导入状态", transferTitle(s), ui.Button{Text: apptext.T("查看详情"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			TestID: "data-transfer-status", OnPress: func() { a.transferOpen.Set(true) }})
	})
}
