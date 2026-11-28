//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func (a *app) transcriptImageTile(img remotewire.Image) core.Node {
	preview := chat.AttachmentPreview{Label: firstNonEmpty(img.Name, apptext.T("图片")), Image: core.ImageSource{Data: img.Data}}
	if len(img.Data) == 0 {
		return preview
	}
	return core.View{Role: core.RoleButton, Label: apptext.T("查看图片"), TestID: "transcript-image-tile",
		Style: core.Style{FlexShrink: 0}, OnPress: func(core.PressEvent) {
			a.transcriptImage.Set(img)
			a.openPane(paneTranscriptImage)
		}, Children: []core.Node{preview}}
}

// transcriptImagePane shows a picture a tool returned, filling the work area,
// and offers its bytes to the platform's save dialog.
func (a *app) transcriptImagePane() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		img := a.transcriptImage.Get()
		if len(img.Data) == 0 {
			return core.View{Style: ui.FillRest}
		}
		return core.View{Style: core.Style{Direction: core.Column, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0)},
			Children: []core.Node{
				a.paneHeader(firstNonEmpty(img.Name, apptext.T("图片")), "图片预览",
					ui.Button{Text: apptext.T("另存图片…"), Icon: lucide.Download, Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "transcript-image-save", OnPress: func() {
							cx.SaveFile(core.SaveOptions{Name: "pideck-image" + imageFileExt(img.MimeType), MIME: img.MimeType, Data: img.Data},
								func(_ bool, _ string, err error) {
									if err != nil {
										a.toast(ui.ToastError, "保存图片失败", err.Error())
									}
								})
						}}),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Padding: core.Symmetric(10, 0)},
					Children: []core.Node{core.Image{Source: core.ImageSource{Data: img.Data}, ResizeMode: core.Contain,
						Label: apptext.T("图片"), TestID: "transcript-image-picture", Style: ui.FillRest}}},
			}}
	})
}

// imageFileExt names a saved picture after its type, for the save dialog.
func imageFileExt(mime string) string {
	switch mime {
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	}
	return ".png"
}
