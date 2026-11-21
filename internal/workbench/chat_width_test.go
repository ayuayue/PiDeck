//go:build !js && !android && !ios

package workbench

// Checks the chat's reading width: its percentage bounds, the migration
// from the old point width, its storage, and the settings slider.

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestChatWidthPctNormalized(t *testing.T) {
	c := &config{ChatWidthPct: 30}
	if !normalizeConfig(c) {
		t.Fatal("a percentage under the minimum should be corrected")
	}
	if c.ChatWidthPct != 0 {
		t.Fatalf("narrow percentage normalized to %d, want unset", c.ChatWidthPct)
	}
	c = &config{ChatWidthPct: 200}
	if !normalizeConfig(c) {
		t.Fatal("a percentage over the maximum should be corrected")
	}
	if c.ChatWidthPct != 0 {
		t.Fatalf("wide percentage normalized to %d, want unset", c.ChatWidthPct)
	}
	c = &config{ChatWidthPct: 70}
	if normalizeConfig(c) {
		t.Fatal("a percentage in range should be left alone")
	}
	if c.ChatWidthPct != 70 {
		t.Fatalf("percentage in range changed to %d", c.ChatWidthPct)
	}
}

func TestChatWidthPctMigratesLegacyPoints(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want int
	}{
		{"narrow end", `{"version":2,"chatWidth":520}`, 50},
		{"kit default", `{"version":2,"chatWidth":720}`, 67},
		{"wide end", `{"version":2,"chatWidth":1000}`, 90},
		{"below range", `{"version":2,"chatWidth":300}`, 50},
		{"above range", `{"version":2,"chatWidth":2000}`, 90},
		{"unset stays unset", `{"version":2}`, 0},
		{"stray points on a current file", `{"version":3,"chatWidth":700}`, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var c config
			if err := json.Unmarshal([]byte(tc.raw), &c); err != nil {
				t.Fatal(err)
			}
			if !migrateConfig(&c, []byte(tc.raw)) {
				t.Fatal("an older config should be migrated")
			}
			if c.ChatWidthPct != tc.want {
				t.Fatalf("percent = %d, want %d", c.ChatWidthPct, tc.want)
			}
			if c.ChatWidth != 0 {
				t.Fatalf("legacy width %d left in the config", c.ChatWidth)
			}
			if c.Version != configVersion {
				t.Fatalf("version = %d, want %d", c.Version, configVersion)
			}
		})
	}
}

func TestChatWidthPctMigrationRewritesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"version":2,"chatWidth":1000}`), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := st.config().ChatWidthPct; got != 90 {
		t.Fatalf("loaded percent %d, want 90", got)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]any
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if _, ok := saved["chatWidth"]; ok {
		t.Fatalf("legacy chatWidth still written: %s", raw)
	}
	if saved["chatWidthPct"] != float64(90) {
		t.Fatalf("stored percent = %v, want 90", saved["chatWidthPct"])
	}
}

func TestChatWidthPctPersists(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) { c.ChatWidthPct = 70 })
	again, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.config().ChatWidthPct; got != 70 {
		t.Fatalf("stored percent %d, want 70", got)
	}
}

func TestChatWidthPctSlider(t *testing.T) {
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
	openChatWidthSettings(app)
	app.WaitFor("text:80%", 5*time.Second)

	app.Drag("id:chat-width-thumb", core.Point{X: -60})
	stored := 0
	app.WaitUntil(5*time.Second, func() bool {
		raw, err := os.ReadFile(filepath.Join(home, "config.json"))
		if err != nil {
			return false
		}
		var c config
		if json.Unmarshal(raw, &c) != nil {
			return false
		}
		stored = c.ChatWidthPct
		return stored >= chatWidthPctMin && stored < chatWidthPctDefault
	})

	// A missing pi can leave an error toast, which takes Escape before the
	// pane does. Close settings through its own action.
	app.Press("id:settings-done")
	app.WaitForGone("id:settings", 5*time.Second)

	app.WaitUntil(5*time.Second, func() bool {
		return columnsMatchPercent(app, stored)
	})

	// The slider reads the stored value back when the page reopens.
	openChatWidthSettings(app)
	app.WaitFor(fmt.Sprintf("text:%d%%", stored), 5*time.Second)
}

// TestChatWidthStripsShareTheComposerColumn checks the stack above the
// composer takes its width from the column alone: the to-do strip and the
// input are as wide as the column, with no bound of their own.
func TestChatWidthStripsShareTheComposerColumn(t *testing.T) {
	built, screen, s := newAskApp(t)
	built.chatWidthPctSig.Set(70)
	s.todos.Set([]todoItem{
		{Text: "先读现有实现", Status: "completed"},
		{Text: "写测试", Status: "in_progress"},
	})
	screen.Advance(80 * time.Millisecond)
	screen.WaitFor("id:todo-bar", 5*time.Second)

	col := screen.Find("id:composer-column")
	want := float64(col.Frame.Size.Width)
	for _, sel := range []string{"id:todo-bar", "id:composer-card"} {
		got := screen.Find(sel)
		if diff := math.Abs(float64(got.Frame.Size.Width) - want); diff > 1 {
			t.Fatalf("%s is %.1f wide, want the column's %.1f (off by %.1f)",
				sel, got.Frame.Size.Width, want, diff)
		}
	}
	// The input fills the card inside its 1-point border, so it is 2
	// points narrower: the border is not a second width source.
	if got := screen.Find("id:composer"); math.Abs(float64(got.Frame.Size.Width)-want) > 2 {
		t.Fatalf("id:composer is %.1f wide, want the column's %.1f less its border",
			got.Frame.Size.Width, want)
	}
}

// TestPaneWidthSharesTheChatColumn checks the tab pages take their width
// from the chat's setting too: the settings page and the tasks page are
// as wide as the composer column, so switching tabs does not jump.
func TestPaneWidthSharesTheChatColumn(t *testing.T) {
	built, screen, _ := newAskApp(t)
	built.chatWidthPctSig.Set(70)
	screen.Advance(80 * time.Millisecond)
	screen.WaitFor("id:composer-column", 5*time.Second)
	want := float64(screen.Find("id:composer-column").Frame.Size.Width)

	check := func(name string) {
		t.Helper()
		screen.WaitFor("id:pane-column", 5*time.Second)
		got := float64(screen.Find("id:pane-column").Frame.Size.Width)
		if diff := math.Abs(got - want); diff > 2 {
			t.Fatalf("%s pane column is %.1f wide, want the composer column's %.1f (off by %.1f)",
				name, got, want, diff)
		}
	}

	built.openSettingsPane()
	screen.Advance(80 * time.Millisecond)
	check("settings")

	built.openTaskDialog()
	screen.Advance(80 * time.Millisecond)
	check("tasks")
}

// TestDialogWidthSharesTheChatColumn checks a modal takes the same share
// of the window as the chat column: the task form follows the setting
// instead of keeping a fixed 780 points.
func TestDialogWidthSharesTheChatColumn(t *testing.T) {
	built, screen, _ := newAskApp(t)
	const windowWidth = 1280
	built.chatWidthPctSig.Set(70)
	built.openTaskForm()
	screen.Advance(80 * time.Millisecond)
	screen.WaitFor("id:task-form", 5*time.Second)

	at := func(pct int) float64 {
		t.Helper()
		want := windowWidth * float64(pct) / 100
		got := float64(screen.Find("id:task-form").Frame.Size.Width)
		if diff := math.Abs(got - want); diff > 2 {
			t.Fatalf("task form at %d%% is %.1f wide, want %.1f of the window (off by %.1f)",
				pct, got, want, diff)
		}
		return got
	}
	narrow := at(70)

	built.chatWidthPctSig.Set(80)
	screen.Advance(80 * time.Millisecond)
	wider := at(80)
	if wider <= narrow {
		t.Fatalf("task form at 80%% is %.1f wide, not wider than %.1f at 70%%", wider, narrow)
	}
}

// openChatWidthSettings finds the width row through the settings search.
func openChatWidthSettings(app *nsgotest.App) {
	app.Press("label:设置")
	app.WaitFor("id:settings-search", 5*time.Second)
	app.Type("id:settings-search", "宽度")
	app.WaitFor("id:settings-hit-general-0", 5*time.Second)
	app.Press("id:settings-hit-general-0")
	app.WaitFor("id:chat-width", 5*time.Second)
}

// columnsMatchPercent reports whether both columns take the configured
// share of the chat area, which pads 20 points on each side. The
// transcript column is measured mounted: an empty session leaves it no
// height, so a visible query would not find it.
func columnsMatchPercent(app *nsgotest.App, pct int) bool {
	pane := app.Query("id:transcript")
	cols := app.QueryMounted("id:transcript-column")
	composer := app.Query("id:composer-column")
	if len(pane) != 1 || len(cols) != 1 || len(composer) != 1 {
		return false
	}
	available := float64(pane[0].Frame.Size.Width) - 40
	want := available * float64(pct) / 100
	for _, got := range []float64{float64(cols[0].Frame.Size.Width), float64(composer[0].Frame.Size.Width)} {
		if math.Abs(got-want) > 2 {
			return false
		}
	}
	return true
}
