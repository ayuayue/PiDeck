//go:build !js && !android && !ios

package workbench

// The desktop pet: a small floating window that shows what the agents are
// doing, and takes a click to bring the workbench back.

import (
	"time"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/desktop"
	"github.com/nsgo-dev/nsgo/ui"
)

// petMood is what the pet shows.
type petMood int

const (
	petIdle petMood = iota
	petBusy
	petFailed
)

// petState counts the sessions by what they are doing.
func (a *app) petState() (petMood, int) {
	statuses := make([]sessionStatus, 0, len(a.all))
	for _, s := range a.all {
		statuses = append(statuses, s.status.GetUntracked())
	}
	return petMoodOf(statuses)
}

// petMoodOf folds session states into the pet's face.
func petMoodOf(statuses []sessionStatus) (petMood, int) {
	running, failed := 0, 0
	for _, st := range statuses {
		switch st {
		case statusRunning, statusStarting, statusWaiting:
			running++
		case statusFailed:
			failed++
		}
	}
	if running > 0 {
		return petBusy, running
	}
	if failed > 0 {
		return petFailed, failed
	}
	return petIdle, 0
}

// setupPet opens the pet window when the setting is on.
func (a *app) setupPet() {
	if !desktop.IsAvailable(a.cx) || !a.cfg.PetEnabled {
		return
	}
	if a.petWin != nil && !a.petWin.Closed() {
		return
	}
	win := desktop.OpenWindow(a.cx, desktop.WindowOptions{
		Title: "PiDeck 宠物", Width: 160, Height: 186, Key: "pet",
		Frame:       core.WindowFrame{X: 40, Y: 80, Width: 160, Height: 186, Move: true},
		Constraints: core.WindowConstraints{NoResize: true, NoMaximize: true},
	}, func(cx *core.Scope) core.Node {
		// The content's scope is the pet window's: raise it here.
		desktop.SetWindowLevel(cx, core.WindowLevelFloating)
		return a.petView(cx)
	})
	if win == nil {
		return
	}
	a.petWin = win
	win.OnClosing(a.cx, func(c *core.WindowClosing) {
		c.Cancel()
		win.Hide()
		a.cfg.PetEnabled = false
		if a.st != nil {
			a.st.edit(func(cfg *config) { cfg.PetEnabled = false })
		}
		a.toast(ui.ToastInfo, "桌面宠物已关闭", "可以在 设置 → 通用 → 桌面 里再打开。")
	})
}

// togglePet opens or closes the pet window.
func (a *app) togglePet(on bool) {
	a.cfg.PetEnabled = on
	a.bumpSettings()
	if a.st != nil {
		a.st.edit(func(c *config) { c.PetEnabled = on })
	}
	if on {
		a.setupPet()
		return
	}
	if a.petWin != nil {
		a.petWin.Close()
		a.petWin = nil
	}
}

// petView draws the pet and what it says.
func (a *app) petView(cx *core.Scope) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.clock.Get()
		colors := ui.ColorsOf(cx)
		mood, n := a.petState()
		body := colors.Muted()
		label := apptext.T("待命")
		switch mood {
		case petBusy:
			body = colors.Accent()
			label = apptext.T("%d 个会话运行中", n)
		case petFailed:
			body = colors.Danger()
			label = apptext.T("%d 个会话出错", n)
		}
		eye := func() core.Node {
			if mood == petIdle {
				return core.View{Style: core.Style{Width: core.Pt(10), Height: core.Pt(3), CornerRadius: 2,
					Background: colors.Background()}}
			}
			return core.View{Style: core.Style{Width: core.Pt(8), Height: core.Pt(8), CornerRadius: 4,
				Background: colors.Background()}}
		}
		face := core.View{StyleFunc: func() core.Style {
			st := core.Style{Width: core.Pt(98), Height: core.Pt(84), CornerRadius: 28, Background: body,
				AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 10}
			if mood == petBusy && !ui.ReduceMotion(cx) {
				st.Animation = core.KeyframeAnimation{Keyframes: core.KeyframesPulse, Duration: 1200 * time.Millisecond}
			}
			return st
		}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 18}, Children: []core.Node{eye(), eye()}},
			core.View{Style: core.Style{Width: core.Pt(18), Height: core.Pt(3), CornerRadius: 2, Background: colors.Background()}},
		}}
		return core.View{
			OnPress: func(core.PressEvent) { a.showMainWindow() },
			Role:    core.RoleButton, Label: label, TestID: "pet",
			StyleFunc: func() core.Style {
				return core.Style{FlexGrow: 1, Direction: core.Column, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
					Gap: 8, Background: colors.Background(), Hover: &core.Style{Background: colors.Hover()}}
			},
			Children: []core.Node{
				face,
				core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
			},
		}
	})
}
