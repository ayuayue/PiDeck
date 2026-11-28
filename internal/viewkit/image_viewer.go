package viewkit

import (
	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// TranscriptImageDialog previews an attachment and offers the original bytes
// through the platform's save picker. Its caller owns loading and errors.
func TranscriptImageDialog(open func() bool, close func(), image func() ([]byte, string), onSaveError func(error)) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		data, mime := image()
		window := cx.Env().Window()
		var body core.Node = ui.Spinner{Label: apptext.T("正在加载图片…")}
		var footer []core.Node
		if len(data) > 0 {
			body = core.Image{Source: core.ImageSource{Data: data}, ResizeMode: core.Contain, Label: apptext.T("图片"),
				Style: core.Style{Width: core.Pct(100), Height: core.Pt(max(120, window.Height-208))}}
			footer = append(footer, ui.Button{Text: apptext.T("另存图片…"), Icon: lucide.Download, Variant: ui.ButtonSecondary,
				TestID: "transcript-image-save", OnPress: func() {
					cx.SaveFile(core.SaveOptions{Name: "pideck-image" + transcriptImageExtension(mime), MIME: mime, Data: data},
						func(_ bool, _ string, err error) {
							if err != nil && onSaveError != nil {
								onSaveError(err)
							}
						})
				}})
		}
		footer = append(footer, ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, TestID: "transcript-image-close", OnPress: close})
		return ui.Dialog{Open: open, OnOpenChange: func(on bool, _ base.Reason) {
			if !on {
				close()
			}
		}, Title: apptext.T("图片预览"), TestID: "transcript-image-viewer",
			Style: core.Style{Width: core.Pt(max(160, window.Width-80))}, Children: []core.Node{body}, Footer: footer}
	})
}

func transcriptImageExtension(mime string) string {
	switch mime {
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	default:
		return ".png"
	}
}
