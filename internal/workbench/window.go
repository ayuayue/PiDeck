//go:build !js && !android && !ios

package workbench

// The window's place and size, remembered across runs. The size goes to the
// platform as the window opens, so it never jumps; a drag or a resize is
// written once it rests. Which settings page, which drawer tab and the rail's
// widths are remembered the same way, in the app's own config.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"example.com/pideck-lite/internal/crashlog"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/desktop"
)

// initialWindowFrame reads the window's last frame before the app starts, so
// it opens where it was instead of at the default size.
func InitialWindowFrame() (core.WindowFrame, bool) {
	dir := crashlog.DataDir()
	if dir == "" {
		return core.WindowFrame{}, false
	}
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return core.WindowFrame{}, false
	}
	var saved config
	if json.Unmarshal(raw, &saved) != nil {
		return core.WindowFrame{}, false
	}
	w := saved.Window
	if w.W < 640 || w.H < 480 {
		return core.WindowFrame{}, false
	}
	return core.WindowFrame{X: core.Points(w.X), Y: core.Points(w.Y),
		Width: core.Points(w.W), Height: core.Points(w.H), Move: true}, true
}

// watchWindow remembers the window's frame a moment after it rests, and
// restores a window that was maximized.
func (a *app) watchWindow() {
	if !desktop.IsAvailable(a.cx) {
		return
	}
	if a.cfg.Window.Maximized {
		desktop.ToggleMaximize(a.cx)
	}
	a.cx.Effect(func() {
		frame := a.cx.Env().WindowFrame()
		maximized := a.cx.Env().Maximized()
		if frame.Width < 200 || frame.Height < 200 {
			return
		}
		a.saveWindowFrame(frame, maximized)
	})
}

// saveWindowFrame stores a frame once the window stops moving. A maximized
// window keeps the size it had before, so restoring it later is not a jump
// back to a maximized-sized window.
func (a *app) saveWindowFrame(frame core.WindowFrame, maximized bool) {
	a.winSeq++
	seq := a.winSeq
	a.cx.AfterFunc(600*time.Millisecond, func() {
		if seq != a.winSeq || a.st == nil {
			return
		}
		next := a.cfg.Window
		next.Maximized = maximized
		if !maximized {
			next.X, next.Y = float64(frame.X), float64(frame.Y)
			next.W, next.H = float64(frame.Width), float64(frame.Height)
		}
		if next == a.cfg.Window {
			return
		}
		a.cfg.Window = next
		a.st.edit(func(c *config) { c.Window = next })
	})
}
