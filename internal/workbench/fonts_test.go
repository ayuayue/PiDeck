//go:build !js && !android && !ios

package workbench

// Checks the text sizes the appearance settings store and apply.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestTextSizesNormalized checks out-of-range sizes fall back to the
// defaults instead of breaking the layout.
func TestTextSizesNormalized(t *testing.T) {
	c := &config{ChatFont: 5, ChatLine: 3, InputFont: 40}
	if !normalizeConfig(c) {
		t.Fatal("out-of-range text sizes should be corrected")
	}
	if c.ChatFont != 0 || c.ChatLine != 0 || c.InputFont != 0 {
		t.Fatalf("normalized to %+v, want the defaults", c)
	}
	c = &config{ChatFont: 15, ChatLine: 1.8, InputFont: 14}
	if normalizeConfig(c) {
		t.Fatal("sizes in range should be left alone")
	}
	if c.ChatFont != 15 || c.ChatLine != 1.8 || c.InputFont != 14 {
		t.Fatalf("sizes in range changed to %+v", c)
	}
}

// TestProcessSizesDerived checks the process layer follows the reading
// size, floored and capped so it stays under the fold row.
func TestProcessSizesDerived(t *testing.T) {
	cases := []struct{ chat, row, detail core.Points }{
		{11, 12.5, 11.5},
		{15, 13, 11.5},
		{16, 13.5, 12},
		{19, 13.5, 12.5},
		{20, 13.5, 12.5},
	}
	for _, c := range cases {
		if got := readingRowSize(c.chat); got != c.row {
			t.Errorf("readingRowSize(%v) = %v, want %v", c.chat, got, c.row)
		}
		if got := readingDetailSize(c.chat); got != c.detail {
			t.Errorf("readingDetailSize(%v) = %v, want %v", c.chat, got, c.detail)
		}
	}
}

// TestChatFontSetting picks a reading size from the appearance page and
// checks it is stored and applied.
func TestChatFontSetting(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Cleanup(closeAllPi)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.WaitFor("id:welcome-chat", 10*time.Second)
	app.Press("id:welcome-chat")
	app.WaitFor("id:composer-column", 10*time.Second)
	app.Press("label:设置")
	app.WaitFor("id:settings-search", 5*time.Second)
	app.Type("id:settings-search", "聊天字号")
	app.WaitFor("id:settings-hit-look-0", 5*time.Second)
	app.Press("id:settings-hit-look-0")
	app.WaitFor("text:特大", 5*time.Second)
	app.Press("text:特大")
	app.WaitUntil(5*time.Second, func() bool {
		raw, err := os.ReadFile(filepath.Join(home, "config.json"))
		if err != nil {
			return false
		}
		var c config
		if json.Unmarshal(raw, &c) != nil {
			return false
		}
		return c.ChatFont == 19
	})
	// The reading surface picks the size up at once: the composer's line
	// height grows with it.
	// A missing pi can leave an error toast, which takes Escape before the
	// pane does. Close settings through its own action.
	app.Press("id:settings-done")
	app.WaitForGone("id:settings", 5*time.Second)
	app.WaitFor("id:composer", 5*time.Second)
}
