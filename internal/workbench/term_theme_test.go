//go:build !js && !android && !ios

package workbench

// Checks the terminal takes its colors from the app's palette.

import (
	"testing"

	sgt "github.com/nsgo-dev/nsgo/base/terminal"
	"github.com/nsgo-dev/nsgo/core"
)

func TestTerminalThemeFollowsPalette(t *testing.T) {
	p := core.Palette{
		Background: core.RGB(0x101418), Text: core.RGB(0xeeeeee), TextMuted: core.RGB(0x888888),
		Accent: core.RGB(0x3366ff), Danger: core.RGB(0xff3344), Warning: core.RGB(0xffaa00),
		Success: core.RGB(0x22bb66), Selection: core.RGB(0x334455),
	}
	th := terminalTheme(p, true)
	if th.Background != p.Background || th.Foreground != p.Text {
		t.Fatalf("background/text = %v/%v", th.Background, th.Foreground)
	}
	if th.Cursor != p.Accent || th.Selection != p.Selection {
		t.Fatalf("cursor/selection = %v/%v", th.Cursor, th.Selection)
	}
	if th.Palette[1] != p.Danger || th.Palette[2] != p.Success || th.Palette[3] != p.Warning || th.Palette[4] != p.Accent {
		t.Fatalf("palette = %v", th.Palette)
	}
	if th.Palette[7] != p.Text || th.Palette[8] != p.TextMuted {
		t.Fatalf("text slots = %v/%v", th.Palette[7], th.Palette[8])
	}
	// The slots the palette has no role for keep the appearance's base.
	if th.Palette[5] != sgt.DarkTheme().Palette[5] {
		t.Fatalf("magenta = %v", th.Palette[5])
	}
	light := terminalTheme(p, false)
	if light.Palette[5] != sgt.LightTheme().Palette[5] {
		t.Fatalf("light magenta = %v", light.Palette[5])
	}
}
