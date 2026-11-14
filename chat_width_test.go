package main

// Checks the chat's reading width: its bounds, its storage, and the
// settings slider that sets it.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/nsgotest"
)

func TestChatWidthNormalized(t *testing.T) {
	c := &config{ChatWidth: 300}
	if !normalizeConfig(c) {
		t.Fatal("a width under the minimum should be corrected")
	}
	if c.ChatWidth != chatWidthMin {
		t.Fatalf("narrow width normalized to %d, want %d", c.ChatWidth, chatWidthMin)
	}
	c = &config{ChatWidth: 2000}
	if !normalizeConfig(c) {
		t.Fatal("a width over the maximum should be corrected")
	}
	if c.ChatWidth != chatWidthMax {
		t.Fatalf("wide width normalized to %d, want %d", c.ChatWidth, chatWidthMax)
	}
	c = &config{ChatWidth: 640}
	if normalizeConfig(c) {
		t.Fatal("a width in range should be left alone")
	}
	if c.ChatWidth != 640 {
		t.Fatalf("width in range changed to %d", c.ChatWidth)
	}
}

func TestChatWidthPersists(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) { c.ChatWidth = 600 })
	again, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.config().ChatWidth; got != 600 {
		t.Fatalf("stored width %d, want 600", got)
	}
}

func TestChatWidthSlider(t *testing.T) {
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
	app.Type("id:settings-search", "宽度")
	app.WaitFor("id:settings-hit-general-0", 5*time.Second)
	app.Press("id:settings-hit-general-0")
	app.WaitFor("id:chat-width", 5*time.Second)
	app.WaitFor("text:720 pt", 5*time.Second)

	app.Drag("id:chat-width-thumb", core.Point{X: -60})
	var stored int
	app.WaitUntil(5*time.Second, func() bool {
		raw, err := os.ReadFile(filepath.Join(home, "config.json"))
		if err != nil {
			return false
		}
		var c config
		if json.Unmarshal(raw, &c) != nil {
			return false
		}
		stored = c.ChatWidth
		return stored >= chatWidthMin && stored < chatWidthMax
	})

	app.Key("escape")
	app.WaitForGone("id:settings", 5*time.Second)
	app.WaitUntil(5*time.Second, func() bool {
		cols := app.Query("id:composer-column")
		if len(cols) != 1 {
			return false
		}
		return math.Abs(float64(cols[0].Frame.Size.Width)-float64(stored)) <= 1
	})
}
