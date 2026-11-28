package client

// Patches in the client's dialogs: the same diff view the desktop draws, in
// the phone's reading size, with the room a wide window has.

import (
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	uidiff "github.com/nsgo-dev/nsgo/ui/diff"
)

// patchBodyHeight is how tall a patch gets: most of a phone's screen, never
// more than the room its surface gives it.
func patchBodyHeight(cx *core.Scope, max core.Points) core.Length {
	return core.Pt(core.Points(min(max, cx.Env().Window().Height*0.62)))
}

// patchBody is one patch as the desktop draws it: unified, wrapped, its
// added and deleted lines tinted and numbered, and its hunks opening in
// place. A dialog has no height of its own, so the view is given one.
func patchBody(patch func() string, testID string, max core.Points) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		return uidiff.View{
			Patch: patch, Unified: true, Selectable: true, SoftWrap: true, TestID: testID,
			FontFamily: viewkit.MonoFont(), FontSize: 11.5, LineHeight: 17,
			Style: core.Style{Height: patchBodyHeight(cx, max)},
		}
	})
}

// patchSheetWidth is a patch dialog's width: the phone's sheet, or a pane of
// the desktop's size once the window is wide enough to keep the rail beside
// the page. Lines and hunk headers need it.
func patchSheetWidth(cx *core.Scope) core.Length {
	if railBeside(cx) {
		return core.Pt(880)
	}
	return core.Pt(sheetWidth)
}
