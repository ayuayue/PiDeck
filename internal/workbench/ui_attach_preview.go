//go:build !js && !android && !ios

package workbench

// One image the composer holds, enlarged: the picture fills the dialog, and
// its bytes go to the clipboard or to the platform's save dialog.

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// attachPreviewDialog enlarges one image of the input, with the same copy
// and save actions its menu offers.
func (a *app) attachPreviewDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		img := a.attachPreview.Get()
		window := cx.Env().Window()
		close := func() { a.attachPreview.Set(remotewire.Image{}) }
		var body core.Node
		if len(img.Data) > 0 {
			body = core.Image{Source: core.ImageSource{Data: img.Data}, ResizeMode: core.Contain,
				Label: firstNonEmpty(img.Name, apptext.T("图片")), TestID: "attach-image-picture",
				Style: core.Style{Width: core.Pct(100), Height: core.Pt(max(120, window.Height-260)), CornerRadius: 8}}
		}
		return ui.Dialog{
			Open: func() bool { return len(img.Data) > 0 },
			OnOpenChange: func(open bool, _ base.Reason) {
				if !open {
					close()
				}
			},
			Title:    apptext.T("图片预览"),
			TestID:   "attach-image-viewer",
			Style:    core.Style{Width: core.Pt(max(240, min(920, window.Width-120)))},
			Children: []core.Node{body},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("复制图片"), Icon: lucide.Copy, Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "attach-image-copy", OnPress: func() { a.copyImage(img) }},
				ui.Button{Text: apptext.T("另存图片…"), Icon: lucide.Download, Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "attach-image-save", OnPress: func() { a.saveImage(cx, img) }},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: close},
			},
		}
	})
}
