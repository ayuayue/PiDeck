package client

// The phone build: it connects to a desktop PiDeck Lite server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_LITE_MOBILE=1 for a preview on a desktop).

import (
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// view is the whole phone screen, with the drawer and the sheets over it.
func (a *mobileApp) view() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.language.Get()
		return core.View{Style: ui.FillRest, StyleFunc: func() core.Style { return core.Style{FontFamily: cx.Theme().Sans} }, Children: []core.Node{
			core.Dynamic(func(cx *core.Scope) core.Node {
				if a.connected.Get() {
					return a.shell(cx)
				}
				return a.connectView(cx)
			}),
			a.drawer(),
			a.actionSheet(),
			a.renameSheet(),
			a.deleteSheet(),
			a.newSessionSheet(),
			a.optionsSheet(),
			a.composerPlusSheet(),
			a.noticePill(),
			a.addProjectSheet(),
			a.removeProjectSheet(),
			a.projectSheet(),
			a.settingsSheet(),
			a.searchSheet(),
			a.agentsSheet(),
			a.tasksSheet(),
			a.favoritesSheet(),
			a.favoriteTextSheet(),
			a.transcriptImageDialog(),
			a.reviewSheet(),
			a.reviewDetailSheet(),
			a.reviewPatchSheet(),
			a.gitSheet(),
			a.gitDiffSheet(),
			a.gitBranchesSheet(),
			a.filesSheet(),
			a.fileSheet(),
		}}
	})
}
