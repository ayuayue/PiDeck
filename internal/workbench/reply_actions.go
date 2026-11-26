//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) copyReplyImage(reply *core.Ref) {
	a.cx.Capture(reply, func(png []byte, err error) {
		if err != nil {
			a.toast(ui.ToastError, "操作失败", err.Error())
			return
		}
		a.cx.SetClipboardImage(png)
		a.toast(ui.ToastSuccess, "已复制图片", "")
	})
}

func (a *app) shareReply(s *session, t turn) {
	if strings.TrimSpace(t.Final) == "" {
		return
	}
	data := exportData{Project: s.WS, Turns: []turn{{Final: t.Final}}}
	secrets := a.shareExportSecrets()
	go func() {
		shared := shareExport(data, secrets)
		a.cx.Post(func() {
			if len(shared.Turns) == 0 || shared.Turns[0].Final == "" {
				a.toast(ui.ToastInfo, "没有可分享的文字", "")
				return
			}
			a.cx.Share(core.ShareOptions{Text: shared.Turns[0].Final}, func(_ bool, err error) {
				if err != nil {
					a.toast(ui.ToastError, "操作失败", err.Error())
				}
			})
		})
	}()
}
