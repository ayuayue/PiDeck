//go:build !js && !android && !ios

package workbench

// Split panes: the settings, the task list, the agents and the favorites
// are pages in the work area, opened as tabs beside the sessions instead
// of dialogs over the window. A pane is the work area's second kind of
// tab: its own list, one showing at a time. Picking a session puts the
// work area back on that session and leaves the pane's tab where it is,
// the way a second document stays open.

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// The panes, by id.
const (
	paneSettings      = "settings"
	paneTasks         = "tasks"
	paneAgents        = "agents"
	paneFavorites     = "favorites"
	paneReview        = "review"
	paneBrowser       = "browser"
	paneMemory        = "memory"
	paneNotifications = "notifications"
	paneVideo         = "video"
	// File content opens to the right of the conversation: previews,
	// patches, and the commits and lines behind a path.
	panePreview     = "preview"
	paneDiff        = "diff"
	paneFileHistory = "file-history"
	paneBlame       = "blame"
	paneReviewPatch = "review-patch"
	// A conversation's own material: a tool result's picture, the turn's
	// trajectory and the agents it handed work to.
	paneTranscriptImage = "transcript-image"
	paneTrajectory      = "trajectory"
	paneDelegation      = "delegation"
)

// paneDef is one split pane: its tab, whether it is open, and its page.
type paneDef struct {
	ID   string
	Icon func() *core.SVG
	// Label names the tab; Open and Set are the pane's own signal.
	Label  string
	Open   func() bool
	Set    func(bool)
	TestID string
	Body   func() core.Node
}

// panes are the split panes, in tab order.
func (a *app) panes() []paneDef {
	return []paneDef{
		{ID: paneSettings, Label: "设置", Icon: lucide.Settings, Open: a.settings.Get, Set: a.settings.Set,
			TestID: "settings", Body: a.settingsPane},
		{ID: paneTasks, Label: "定时任务", Icon: lucide.CalendarClock, Open: a.taskOpen.Get, Set: a.taskOpen.Set,
			TestID: "tasks-dialog", Body: a.tasksPane},
		{ID: paneAgents, Label: "智能体", Icon: lucide.Bot, Open: a.agentManageOpen.Get, Set: a.agentManageOpen.Set,
			TestID: "agent-manager", Body: a.agentsPane},
		{ID: paneFavorites, Label: "收藏夹", Icon: lucide.Star, Open: a.favOpen.Get, Set: a.favOpen.Set,
			TestID: "favorites-dialog", Body: a.favoritesPane},
		{ID: paneReview, Label: "评审", Icon: lucide.GitPullRequest, Open: a.reviewOpen.Get, Set: a.reviewOpen.Set,
			TestID: "review-pane", Body: a.reviewPane},
		{ID: paneBrowser, Label: "浏览器", Icon: lucide.Globe, Open: a.browser.open.Get, Set: a.browser.open.Set},
		{ID: paneMemory, Label: "智能体记忆", Icon: lucide.BookOpen, Open: a.memory.open.Get, Set: a.memory.open.Set,
			TestID: "memory-pane", Body: a.memoryPane},
		{ID: paneNotifications, Label: "通知历史", Icon: lucide.Bell, Open: a.notifications.open.Get, Set: a.notifications.open.Set,
			TestID: "notifications-pane", Body: a.notificationHistoryPane},
		{ID: paneVideo, Label: "视频生成", Icon: lucide.Video, Open: a.video.open.Get, Set: a.video.open.Set, TestID: "video-pane", Body: a.videoPane},
		// A preview has no tab of its own until a file opens in it, and its
		// close gives the file back: the audio it plays stops there too.
		{ID: panePreview, Label: "文件预览", Icon: lucide.Eye, Open: func() bool { return a.preview.Get() != nil },
			Set: func(open bool) {
				if !open {
					a.closeFilePreview()
				}
			},
			TestID: "file-preview", Body: a.previewPane},
		{ID: paneDiff, Label: "改动", Icon: lucide.FileDiff, Open: a.gitDiffOpen.Get, Set: a.gitDiffOpen.Set,
			TestID: "git-diff", Body: a.diffPane},
		{ID: paneFileHistory, Label: "文件历史", Icon: lucide.Clock, Open: a.gitFileHistoryOpen.Get,
			Set: a.gitFileHistoryOpen.Set, TestID: "git-file-history-dialog", Body: a.fileHistoryPane},
		{ID: paneBlame, Label: "追溯", Icon: lucide.UserRoundSearch, Open: a.gitBlameOpen.Get,
			Set: a.gitBlameOpen.Set, TestID: "git-blame", Body: a.blamePane},
		{ID: paneReviewPatch, Label: "补丁", Icon: lucide.FileDiff, Open: a.review.patchOpen.Get,
			Set: a.review.patchOpen.Set, TestID: "review-patch-dialog", Body: a.reviewPatchPane},
		{ID: paneTranscriptImage, Label: "图片", Icon: lucide.Image, Open: func() bool { return len(a.transcriptImage.Get().Data) > 0 },
			Set: func(open bool) {
				if !open {
					a.transcriptImage.Set(remotewire.Image{})
				}
			},
			TestID: "transcript-image-viewer", Body: a.transcriptImagePane},
		{ID: paneTrajectory, Label: "轨迹", Icon: lucide.Compass, Open: func() bool { return a.trajectory.Get() != nil },
			Set: func(open bool) {
				if !open {
					a.trajectory.Set(nil)
				}
			},
			TestID: "trajectory-dialog", Body: a.trajectoryPane},
		{ID: paneDelegation, Label: "子代理", Icon: lucide.Bot, Open: func() bool { return a.delegationSession.Get() != nil },
			Set: func(open bool) {
				if !open {
					a.delegationSession.Set(nil)
				}
			},
			TestID: "delegate-history", Body: a.delegationPane},
	}
}

// pane looks a split pane up by id.
func (a *app) pane(id string) (paneDef, bool) {
	for _, p := range a.panes() {
		if p.ID == id {
			return p, true
		}
	}
	return paneDef{}, false
}

// openPane shows a pane in the work area, opening its tab if it was not
// already, and puts the file editor away as picking a session does.
func (a *app) openPane(id string) {
	p, ok := a.pane(id)
	if !ok {
		return
	}
	if !isFilePane(id) {
		a.retireSessionPrewarm(a.active())
	}
	if a.editor != nil {
		a.editor.open.Set(false)
	}
	p.Set(true)
	a.activePane.Set(id)
	a.revealTab(paneTabKey(id))
	if id == paneReview {
		a.reviewAttach()
	}
}

// closePane closes a pane's tab and, while it shows, gives the work area
// back to the active session.
func (a *app) closePane(id string) {
	p, ok := a.pane(id)
	if !ok {
		return
	}
	p.Set(false)
	a.forgetTab(paneTabKey(id))
	if id == paneSettings {
		// The page's search starts empty next time, as the dialog's did.
		a.settingsQuery.Set("")
	}
	if id == paneBrowser {
		a.revokeBrowser()
		a.browser.source.Set(core.WebSource{})
		a.browser.nav.Set(core.WebNavigation{})
		a.browser.address.Set("")
		a.browser.err.Set("")
	}
	if a.activePane.GetUntracked() == id {
		a.activePane.Set("")
	}
}

// bindPaneEscape closes the pane that shows on Escape. It is a back
// handler, so an overlay or a modal opened from the pane takes Escape
// first, as it did when these pages were dialogs.
func (a *app) bindPaneEscape() {
	a.cx.OnBackPress(func() bool {
		if !a.paneVisible() {
			return false
		}
		a.closePane(a.activePane.GetUntracked())
		return true
	})
}

// isFilePane identifies content that shares the editor's right-hand split.
func isFilePane(id string) bool {
	switch id {
	case panePreview, paneDiff, paneFileHistory, paneBlame, paneReviewPatch, paneTranscriptImage:
		return true
	}
	return false
}

// filePaneVisible reports whether the conversation has file content beside it.
func (a *app) filePaneVisible() bool {
	return a.editor.open.Get() || (isFilePane(a.activePane.Get()) && a.paneVisible())
}

// paneVisible reports whether the active pane is open.
func (a *app) paneVisible() bool {
	id := a.activePane.Get()
	if id == "" {
		return false
	}
	p, ok := a.pane(id)
	return ok && p.Open()
}

// activePaneID is the pane showing now, "" when none is.
func (a *app) activePaneID() string {
	if !a.paneVisible() {
		return ""
	}
	return a.activePane.GetUntracked()
}

// openPaneIDs are the panes whose tabs show, in tab order.
func (a *app) openPaneIDs() []string {
	var ids []string
	for _, p := range a.panes() {
		if p.Open() {
			ids = append(ids, p.ID)
		}
	}
	return ids
}

// paneView is whichever pane shows, filling the work area. It follows
// the active pane: switching tabs swaps the page without a frame of the
// session behind it.
//
// Settings gets the work area's full measure: provider rows and
// configuration controls need room for their labels, status and actions
// together, and a page that follows the conversation's reading width
// leaves them half empty. The other panes follow the chat column, except
// the ones showing content a conversation column is too narrow for.
func (a *app) paneView() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.langRev.Get()
		colors := ui.ColorsOf(cx)
		p, ok := a.pane(a.activePane.Get())
		if !ok || !p.Open() {
			return core.View{Style: ui.FillRest}
		}
		padding := core.Edges{Left: 20, Right: 20}
		var maxWidth core.Length
		switch p.ID {
		case paneSettings:
			// The settings page takes the work area whole, its rail included:
			// provider rows and their actions need the room. It also reads no
			// reading width, so the width slider does not rebuild the page it
			// is on while it moves.
			padding = core.Edges{}
		case paneDelegation:
			maxWidth = core.Pt(760)
		case paneDiff, panePreview, paneFileHistory, paneBlame, paneReviewPatch, paneTranscriptImage:
			// File content uses the right-hand split's whole width.
			padding = core.Edges{}
		case paneTrajectory:
			maxWidth = core.Pt(1100)
		default:
			maxWidth = core.Pct(float32(a.chatWidthPct()))
		}
		return core.View{TestID: p.TestID, StyleFunc: func() core.Style {
			return core.Style{Direction: core.Column, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0),
				AlignItems: core.AlignCenter, Padding: padding,
				Background: colors.Background()}
		}, Children: []core.Node{
			core.View{TestID: "pane-column", StyleFunc: func() core.Style {
				return core.Style{Direction: core.Column, Width: core.Pct(100), MaxWidth: maxWidth,
					FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0)}
			}, Children: []core.Node{p.Body()}},
		}}
	})
}

// paneTabKey is a pane tab's ref key, apart from a session's id.
func paneTabKey(id string) string { return "pane:" + id }

// paneTab is one pane's tab: its icon and name, and a close button.
func (a *app) paneTab(def paneDef) core.Node {
	colors := ui.ColorsOf(a.cx)
	active := func() bool { return a.activePane.Get() == def.ID }
	label := apptext.T(def.Label)
	return core.View{
		TestID:  "pane-tab-" + def.ID,
		Ref:     a.tabRef(paneTabKey(def.ID)),
		OnPress: func(core.PressEvent) { a.openPane(def.ID) },
		Role:    core.RoleTab, Label: label,
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(28), MaxWidth: core.Pt(200),
				Padding: core.Edges{Left: 9, Right: 5}, CornerRadius: 7, BorderWidth: 1, BorderColor: core.Transparent,
				Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			if active() {
				st.Background = colors.Surface()
				st.BorderColor = colors.Border()
				st.Hover = &core.Style{Background: colors.Surface()}
			}
			return st
		},
		Children: []core.Node{
			ui.IconOf(def.Icon, 12, func() core.Color {
				if active() {
					return colors.Text()
				}
				return colors.Muted()
			}),
			core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
			core.View{TestID: "pane-tab-close-" + def.ID, OnPress: func(core.PressEvent) { a.closePane(def.ID) },
				Role: core.RoleButton, Label: apptext.T("关闭标签页"),
				StyleFunc: func() core.Style {
					return core.Style{Width: core.Pt(18), Height: core.Pt(18), CornerRadius: 5, AlignItems: core.AlignCenter,
						JustifyContent: core.JustifyCenter, Transition: viewkit.PressMotion,
						Hover: &core.Style{Background: colors.Pressed()}, Active: &core.Style{Background: colors.Pressed()}}
				}, Children: []core.Node{ui.Icon(lucide.X, 11, colors.Faint)}},
		},
	}
}

// paneHeader is a pane's head: what the page is, a line on what it does,
// and the page's own actions at its end.
func (a *app) paneHeader(title, summary string, actions ...core.Node) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.langRev.Get()
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12, Height: core.Pt(56),
			Padding: core.Edges{Left: 20, Right: 16}, FlexShrink: 0,
			Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}, Children: []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
				ui.Text(apptext.T(title), 14, ui.Semibold, colors.Text),
				core.Text{Content: apptext.T(summary), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
			}},
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, FlexShrink: 0},
				Children: actions},
		}}
	})
}
