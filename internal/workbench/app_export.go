//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"path/filepath"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

// exportHTML writes the session to an HTML file and offers to open it.
func (a *app) exportHTML(s *session) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		a.exportSession(s)
		return
	}
	a.ensureEngine(s, func() {
		c := s.engine
		go func() {
			var res struct {
				Path string `json:"path"`
			}
			err := c.call(map[string]any{"type": "export_html"}, &res, 60*time.Second)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "导出失败", err.Error())
					return
				}
				a.toastAction(ui.ToastSuccess, "已导出会话", res.Path, "打开", func() {
					a.cx.OpenURL(fileURL(res.Path), nil)
				})
			})
		}()
	})
}

// fileURL makes a file path an openable URL.
func fileURL(path string) string {
	p := filepath.ToSlash(path)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return "file://" + p
}
