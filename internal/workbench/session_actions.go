//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// retry starts a branch at the old prompt, so the rejected answer does not
// feed back into the model. ACP agents without a branch API can resend.
func (a *app) retry(s *session, t turn) {
	if s == nil || t.running() || (strings.TrimSpace(t.Prompt) == "" && len(t.Images) == 0) {
		return
	}
	if canBranchTurn(s, t) {
		a.branchFromTurn(s, t.ID, true)
		return
	}
	a.resendTurn(s, t)
}

// resendTurn sends a turn's prompt again as a new turn.
func (a *app) resendTurn(s *session, t turn) {
	if s == nil || (strings.TrimSpace(t.Prompt) == "" && len(t.Images) == 0) {
		return
	}
	if s.busyNow() {
		a.toast(ui.ToastInfo, "还在运行", "等这一轮结束再重发。")
		return
	}
	a.submitTurn(s, t.Prompt, append([]remotewire.Image(nil), t.Images...), t.Plan)
}

// addImage attaches a pasted or dropped image.
func (a *app) addImage(s *session, img remotewire.Image) {
	if s == nil {
		return
	}
	s.images.Update(func(list []remotewire.Image) []remotewire.Image { return append(list, img) })
}

// dropImage takes one image back out of the composer.
func (a *app) dropImage(s *session, index int) {
	if s == nil {
		return
	}
	s.images.Update(func(list []remotewire.Image) []remotewire.Image {
		if index < 0 || index >= len(list) {
			return list
		}
		return append(append([]remotewire.Image(nil), list[:index]...), list[index+1:]...)
	})
}

// copyImage puts an image the composer holds on the clipboard.
func (a *app) copyImage(img remotewire.Image) {
	if len(img.Data) == 0 {
		return
	}
	a.cx.SetClipboardImage(img.Data)
	a.toast(ui.ToastSuccess, "已复制图片", firstNonEmpty(img.Name, apptext.T("图片")))
}

// saveImage writes an image the composer holds where the user picks.
func (a *app) saveImage(cx *core.Scope, img remotewire.Image) {
	if len(img.Data) == 0 {
		return
	}
	mime := img.MimeType
	if mime == "" {
		mime = "image/png"
	}
	cx.SaveFile(core.SaveOptions{Name: "pideck-image" + imageFileExt(mime), MIME: mime, Data: img.Data},
		func(_ bool, _ string, err error) {
			if err != nil {
				a.toast(ui.ToastError, "保存图片失败", err.Error())
			}
		})
}

// copyText puts text on the clipboard.
func (a *app) copyText(text, what string) {
	a.cx.SetClipboard(text)
	a.toast(ui.ToastSuccess, "已复制"+what, viewkit.FirstLine(text, 60))
}

// touch moves a session to the top of its folder and notes the time.
func (a *app) touch(s *session) {
	s.updated.Set(a.cx.Now())
	ws := a.workspaceFor(s.Target, s.WS)
	if ws == nil {
		return
	}
	ws.Sessions.Update(func(ss []*session) []*session {
		out := []*session{s}
		for _, x := range ss {
			if x != s {
				out = append(out, x)
			}
		}
		return out
	})
}

// openSessionEager starts a session's engine when its tab opens, and paints
// its transcript from the file in the meantime.
func (a *app) openSessionEager(s *session) {
	if s == nil {
		return
	}
	if !s.Target.remote() {
		a.files.watch(s.WS)
	}
	a.loadHistoryFromFile(s)
	a.ensureEngine(s, nil)
}
