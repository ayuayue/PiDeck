//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func (a *app) transcriptImageTile(img remotewire.Image) core.Node {
	preview := chat.AttachmentPreview{Label: firstNonEmpty(img.Name, apptext.T("图片")), Image: core.ImageSource{Data: img.Data}}
	if len(img.Data) == 0 {
		return preview
	}
	return core.View{Role: core.RoleButton, Label: apptext.T("查看图片"), TestID: "transcript-image-tile",
		Style: core.Style{FlexShrink: 0}, OnPress: func(core.PressEvent) { a.transcriptImage.Set(img) }, Children: []core.Node{preview}}
}

func (a *app) transcriptImageDialog() core.Node {
	return viewkit.TranscriptImageDialog(func() bool { return len(a.transcriptImage.Get().Data) > 0 },
		func() { a.transcriptImage.Set(remotewire.Image{}) }, func() ([]byte, string) {
			img := a.transcriptImage.Get()
			return img.Data, img.MimeType
		},
		func(err error) { a.toast(ui.ToastError, "保存图片失败", err.Error()) })
}
