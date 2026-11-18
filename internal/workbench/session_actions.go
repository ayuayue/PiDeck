//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"strings"

	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui"
)

// retry re-sends a failed turn's prompt as a new turn.
func (a *app) retry(s *session, t turn) {
	if s == nil {
		return
	}
	a.submit(s, t.Prompt, t.Images)
}

// resendTurn sends a turn's prompt again as a new turn.
func (a *app) resendTurn(s *session, t turn) {
	if s == nil || strings.TrimSpace(t.Prompt) == "" {
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
