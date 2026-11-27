//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) shareReply(s *session, t turn, includeProcess bool) {
	a.prepareReplyShare(s, t, includeProcess, func(text string) {
		a.cx.Share(core.ShareOptions{Text: text}, a.replyShareDone)
	})
}

func (a *app) prepareReplyShare(s *session, t turn, includeProcess bool, done func(string)) {
	text := replyMarkdown(t, includeProcess)
	if strings.TrimSpace(text) == "" {
		return
	}
	data := exportData{Project: s.WS, Turns: []turn{{Final: text}}}
	secrets := a.shareExportSecrets()
	go func() {
		shared := shareExport(data, secrets)
		a.cx.Post(func() {
			if len(shared.Turns) == 0 || shared.Turns[0].Final == "" {
				a.toast(ui.ToastInfo, "没有可分享的文字", "")
				return
			}
			done(shared.Turns[0].Final)
		})
	}()
}

func (a *app) replyShareDone(_ bool, err error) {
	if err != nil {
		a.toast(ui.ToastError, "操作失败", err.Error())
	}
}
