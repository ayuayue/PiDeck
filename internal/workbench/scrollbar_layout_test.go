//go:build !js && !android && !ios

package workbench

import (
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestSettingsControlsLeaveScrollbarGutter(t *testing.T) {
	built, screen, _ := newAskApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.settingsTab.Set("general")
	})
	screen.WaitFor("id:language-select", 5*time.Second)
	page := screen.Find("id:settings-page").Bounds()
	for _, selector := range []string{"id:language-select", "id:close-to-tray"} {
		control := screen.Find(selector).Bounds()
		gap := page.Origin.X + page.Size.Width - control.Origin.X - control.Size.Width
		if gap < 14 {
			t.Errorf("%s leaves only %.1fpt at the scrollbar edge, want at least 14pt", selector, gap)
		}
	}
	shot(screen, "73-settings-scrollbar-gutter")
}

func TestProcessAndToolOutputLeaveScrollbarGutter(t *testing.T) {
	built, screen, s := newAskApp(t)
	const line = "工具输出的这一行需要一直保留到滚动条左侧。"
	onNativeUI(t, screen, built, func() {
		s.loaded.Set(true)
		s.readySig.Set(true)
		s.turns.Set([]turn{{ID: "gutter", Prompt: "检查滚动区域", Status: chat.Running, Start: built.cx.Now(), Tools: 1,
			Steps: []turnStep{{ID: "gutter-step", Tools: []toolRun{{CallID: "gutter-tool", Name: "read", Action: "读取",
				Detail: "scrollbar-demo.txt", Output: strings.Repeat(line+"\n", 40), Status: chat.Running, Start: built.cx.Now()}}}}}})
		s.runningSig.Set(true)
	})
	screen.WaitFor("id:tool-output", 5*time.Second)
	group := screen.Find("id:process-body").Bounds()
	row := screen.Find("label:读取 scrollbar-demo.txt").Bounds()
	if gap := group.Origin.X + group.Size.Width - row.Origin.X - row.Size.Width; gap < 14 {
		t.Errorf("tool row leaves %.1fpt at the group scrollbar, want at least 14pt", gap)
	}
	output := screen.Find("id:tool-output").Bounds()
	text := screen.Find("text:" + line).Bounds()
	if gap := output.Origin.X + output.Size.Width - text.Origin.X - text.Size.Width; gap < 14 {
		t.Errorf("output leaves %.1fpt at its scrollbar, want at least 14pt", gap)
	}
	shot(screen, "74-process-scrollbar-gutters")
}

func TestImageControlsLeaveScrollbarGutter(t *testing.T) {
	built, screen, _ := newAskApp(t)
	onNativeUI(t, screen, built, func() {
		built.imageBusy.Set(true)
		built.imageOpen.Set(true)
	})
	screen.WaitFor("id:image-prompt", 5*time.Second)
	body := screen.Find("id:image-scroll").Bounds()
	for _, selector := range []string{"id:image-prompt", "id:image-model", "id:image-ref-pick"} {
		control := screen.Find(selector).Bounds()
		if gap := body.Origin.X + body.Size.Width - control.Origin.X - control.Size.Width; gap < 14 {
			t.Errorf("%s leaves %.1fpt at the image scrollbar, want at least 14pt", selector, gap)
		}
	}
	shot(screen, "75-image-scrollbar-gutter")
}
