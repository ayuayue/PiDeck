//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/desktop"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// view is the whole window.
func (a *app) view() core.Node {
	return core.View{Style: ui.FillRest, StyleFunc: func() core.Style { return core.Style{FontFamily: a.cx.Theme().Sans} }, Children: []core.Node{
		core.Dynamic(func(cx *core.Scope) core.Node {
			a.langRev.Get()
			// Appearance is read so a system light/dark flip rebuilds the
			// chrome too: its colors are taken when it is built.
			_ = cx.Env().Dark()
			return a.shell()
		}),
		a.paletteDialog(),
		a.targetDialog(),
		a.renameDialog(),
		a.fileOpDialog(),
		a.exportDialog(),
		a.trustDialog(),
		a.planAskDialog(),
		a.forkTreeDialog(),
		a.pluginMarketDialog(),
		a.pluginNewDialog(),
		a.promptStoreDialog(),
		a.skillStoreDialog(),
		a.mcpDialog(),
		a.imageDialog(),
		a.transcriptImageDialog(),
		a.trajectoryDialog(),
		a.delegationDialog(),
		a.filePreviewDialog(),
		a.visionDialog(),
		a.translationDialog(),
		a.promptTemplateDialog(),
		a.browserApprovalDialog(),
		a.settingsSyncDialog(),
		a.confirmDialog(),
		a.remoteQRDialog(),
		a.reviewPatchDialog(),
		a.gitDiffDialog(),
		a.gitNewBranchDialog(),
		a.gitStashDialog(),
		a.gitTagsDialog(),
		a.gitRemotesDialog(),
		a.gitConflictsDialog(),
		a.gitUnpushedDialog(),
		a.archiveDialog(),
		a.importDialog(),
		// The file browser opens on top of the import dialog, which asks for
		// one more file.
		a.pickerDialog(),
		a.outlineDialog(),
		a.authKeyDialog(),
		a.tdLoginDialog(),
		a.tdKeyDialog(),
		a.tdRechargeDialog(),
		a.supportDialog(),
		a.gitFileHistoryDialog(),
		a.gitBlameDialog(),
		a.terminalRenameDialog(),
		a.gotoLineDialog(),
		a.quickOpenDialog(),
		a.fileSearchDialog(),
		a.providerDialog(),
		a.promptDialog(),
		a.promptImportDialog(),
		a.parallelAskDialog(),
		a.shortcutsDialog(),
		a.searchDialog(),
		a.acpDialog(),
		a.acpPresetManagerDialog(),
		a.agentDialog(),
		a.announcementsDialog(),
		a.feedbackDialog(),
		a.taskFormDialog(),
		a.projectGroupDialog(),
		a.projectRemoveDialog(),
		a.sessionOrganizationPanel(),
		a.workspaceRenameDialog(),
		// Toasts sit at the top right, 16 under the header: the header's
		// own height is the inset, and ui.Toasts adds the margin.
		ui.Toasts{Toaster: a.toaster, Placement: ui.ToastTopEnd, Inset: ui.HeaderHeight, CloseLabel: apptext.T("关闭"), TestID: "toasts"},
	}}
}

// shell is the sidebar beside the chat, with the optional drawer.
func (a *app) shell() core.Node {
	return ui.SidebarShell{
		TestID:         "shell",
		Open:           a.sidebar.Get,
		OnOpenChange:   func(open bool) { a.sidebar.Set(open); a.remember() },
		ToggleLabel:    apptext.T("侧栏"),
		Width:          a.railWidth.Get,
		OnWidthChange:  a.setRailWidth,
		DefaultWidth:   292,
		MinWidth:       240,
		MaxWidth:       400,
		ResizeLabel:    apptext.T("调整侧栏宽度"),
		SidebarActions: []core.Node{a.railActions()},
		Sidebar:        []core.Node{a.rail()},
		SidebarFooter:  []core.Node{a.railFooter()},
		Header:         []core.Node{a.tabBar()},
		// The drawer's own header carries these while it shows, so they
		// stay at the window's edge instead of sliding with the content.
		Actions:            []core.Node{a.headActions(false)},
		Content:            []core.Node{a.workArea()},
		Right:              []core.Node{a.drawerPanel()},
		RightHeader:        []core.Node{a.headActions(true)},
		RightOpen:          a.drawer.Get,
		RightToggleLabel:   apptext.T("会话面板"),
		RightResizeLabel:   apptext.T("调整面板宽度"),
		RightWidth:         a.drawerWidth.Get,
		OnRightWidthChange: a.setDrawerWidth,
		RightDefaultWidth:  316,
		RightMinWidth:      260,
		RightMaxWidth:      460,
	}
}

// headActions are the content header's right end: the terminal, Git and
// the drawer's toggle. They move into the drawer's own header while it
// shows, so opening it no longer pushes them sideways.
func (a *app) headActions(inDrawer bool) core.Node {
	return core.Show{When: func() bool { return a.drawer.Get() == inDrawer }, Then: func(cx *core.Scope) core.Node {
		row := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}
		if inDrawer {
			// The drawer's header has no tab bar to push them along, and it
			// keeps clear of the window's controls as the content's does.
			row.FlexGrow, row.JustifyContent = 1, core.JustifyEnd
			row.Padding = core.Edges{Right: core.Insets(cx).Right + desktop.TitleBar(cx).Right}
		}
		return core.View{Style: row, Children: []core.Node{
			hint(apptext.T("浏览器"), ui.IconButton{Icon: lucide.Globe, Label: apptext.T("浏览器"), Size: 28, IconSize: 14, TestID: "browser-toggle",
				Selected: func() bool { return a.activePane.Get() == paneBrowser }, OnPress: func() { a.openPane(paneBrowser) }}),
			hint("终端", ui.IconButton{Icon: lucide.SquareTerminal, Label: apptext.T("终端"), Size: 28, IconSize: 14, TestID: "terminal-toggle",
				Selected: a.term.open.Get, OnPress: a.toggleTerminal}),
			hint("Git", ui.IconButton{Icon: lucide.GitBranch, Label: "Git", Size: 28, IconSize: 14, TestID: "git-toggle",
				Selected: func() bool { return a.drawer.Get() && a.drawerTab.Get() == "git" }, OnPress: a.openGit}),
			hint(apptext.T("会话面板"), ui.IconButton{Icon: lucide.PanelRight, Label: apptext.T("会话面板"), Size: 32, IconSize: 16.25,
				Selected: a.drawer.Get, TestID: "drawer-toggle", OnPress: a.toggleDrawer}),
		}}
	}}
}

// toggleDrawer shows or hides the session drawer, attaching Git when it
// opens on that tab.
func (a *app) toggleDrawer() {
	open := !a.drawer.GetUntracked()
	a.drawer.Set(open)
	if open && a.drawerTab.GetUntracked() == "git" {
		a.gitAttach()
	}
	a.remember()
}

// workArea is the chat, with the terminal panel under it when it shows.
func (a *app) workArea() core.Node {
	return base.ResizablePanelGroup{
		Axis:                 base.Vertical,
		TestID:               "work-area",
		HandleLabel:          apptext.T("调整终端高度"),
		Style:                core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0)},
		HandleStyleFunc:      ui.HandleLine(a.cx),
		HandleThumbStyle:     ui.HandleThumb(a.cx),
		HandleThumbStyleFunc: ui.HandleThumbColor(a.cx),
		Panels: []base.ResizablePanel{
			{MinSize: 220, Children: []core.Node{a.mainPane()}},
			{Visible: a.term.open.Get, Size: func() core.Points { return core.Points(a.term.height.Get()) },
				MinSize: 110, MaxSize: 640, OnResize: a.terminalResized, TestID: "terminal-panel",
				Children: []core.Node{a.terminalPanel()}},
		},
	}
}

// mainPane is the editor when a file is open, the chat otherwise; a split
// pane, when one shows, takes the whole area.
func (a *app) mainPane() core.Node {
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), MinHeight: core.Pt(0), AlignItems: core.AlignStretch}, Children: []core.Node{
		core.Show{When: a.browser.open.Get, Then: func(*core.Scope) core.Node { return a.browserPane() }},
		core.Show{When: func() bool { return a.activePane.Get() != paneBrowser }, Then: func(*core.Scope) core.Node {
			return core.Show{When: a.paneVisible, Then: func(*core.Scope) core.Node { return a.paneView() },
				Else: func(*core.Scope) core.Node { return a.sessionPane() }}
		}},
	}}
}

// sessionPane is the editor when a file is open, the chat otherwise.
func (a *app) sessionPane() core.Node {
	return core.Show{
		When: func() bool { return a.editor.open.Get() },
		Then: func(*core.Scope) core.Node { return a.editorPane() },
		Else: func(*core.Scope) core.Node { return a.chatPane() },
	}
}
