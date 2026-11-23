//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// Keep the Electron reference's reading hierarchy and shared column in
// the rendered tree, including a long mixed-language reply and code.
func TestChatDesignReadingHierarchy(t *testing.T) {
	for _, size := range []float64{0, 20} {
		t.Run(map[float64]string{0: "default", 20: "large"}[size], func(t *testing.T) {
			_, screen, _ := chatDesignFixture(t, size)
			want := size
			if want == 0 {
				want = 16
			}
			if got := screen.SpanStyle("text:正文保持清晰，过程安静退后。").Font.Size; math.Abs(float64(got)-want) > 0.1 {
				t.Errorf("reply font = %v, want %v", got, want)
			}
			if got := screen.SpanStyle("text:正文保持清晰，过程安静退后。").Font.Family; !strings.Contains(got, "Microsoft YaHei UI") {
				t.Errorf("reply should inherit the effective CJK UI font, got %q", got)
			} else if runtime.GOOS == "windows" && !strings.HasPrefix(got, `"Microsoft YaHei UI"`) {
				t.Errorf("Windows should resolve a CJK UI face before Segoe UI, got %q", got)
			}
			if got := screen.Find("id:chat-prompt-text").TextStyle.Font.Size; math.Abs(float64(got)-want) > 0.1 {
				t.Errorf("prompt font = %v, want %v", got, want)
			}
			if !columnsMatchPercent(screen, 80) {
				t.Error("transcript and composer should share the reference's 80% default column")
			}
			bubble := screen.Find("id:chat-prompt-bubble").Bounds()
			stamp := screen.Find("id:chat-prompt-time").Bounds()
			if stamp.Origin.Y < bubble.Origin.Y+bubble.Size.Height {
				t.Errorf("prompt timestamp %v should sit below the bubble %v", stamp, bubble)
			}
			if h := screen.Find("id:composer-card").Frame.Size.Height; h < 112 {
				t.Errorf("composer height = %v, want at least 112", h)
			}
			shot(screen, "design-alignment/reading-"+t.Name()[len("TestChatDesignReadingHierarchy/"):])
		})
	}
}

func TestChatDesignCustomFontWins(t *testing.T) {
	a, screen, _ := chatDesignFixture(t, 0)
	screen.Post(func() {
		a.cfg.UIFont = "Consolas"
		a.cfg.MonoFont = "Courier New"
		a.applyTheme()
	})
	screen.Settle()
	if got := screen.SpanStyle("text:正文保持清晰，过程安静退后。").Font.Family; got != "Consolas" {
		t.Errorf("custom UI font = %q, want Consolas", got)
	}
	if got := screen.SpanStyle("text:session.ID").Font.Family; got != "Courier New" {
		t.Errorf("custom mono font = %q, want Courier New", got)
	}
}

func TestChatDesignEditPromptPreservesDraft(t *testing.T) {
	_, screen, sess := chatDesignFixture(t, 0)
	screen.Press("id:turn-edit-prompt")
	screen.WaitUntil(5*time.Second, func() bool {
		return screen.Find("id:composer").Text == "检查字体、间距与按钮的光学对齐。"
	})
	screen.Post(func() {
		if got := sess.draft.GetUntracked(); got != "检查字体、间距与按钮的光学对齐。" {
			t.Errorf("restored draft = %q", got)
		}
	})
	screen.Settle()
}

func TestChatDesignThemeAndNarrowScreens(t *testing.T) {
	a, screen, _ := chatDesignFixture(t, 0)
	shot(screen, "design-alignment/light")
	screen.Post(func() { a.theme.Set("dark"); a.applyTheme() })
	screen.Settle()
	shot(screen, "design-alignment/dark")
	screen.Resize(900, 720)
	screen.WaitFor("id:composer-card", 5*time.Second)
	card := screen.Find("id:composer-card").Bounds()
	input := screen.Find("id:composer").Bounds()
	if input.Origin.X < card.Origin.X || input.Origin.X+input.Size.Width > card.Origin.X+card.Size.Width+1 {
		t.Fatalf("input %v overflows card %v", input, card)
	}
	shot(screen, "design-alignment/narrow-dark")
}

func chatDesignFixture(t *testing.T, size float64) (*app, *nsgotest.App, *session) {
	t.Helper()
	home, project := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	raw, err := json.Marshal(config{Version: configVersion, Theme: "light", ChatFont: size,
		ScanPi: false, AutoModelCatalog: false, SidebarOpen: true,
		Workspaces: []workspaceCfg{{Path: project, Name: "Design reference", Expanded: true}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var a *app
	var sess *session
	// Closing the test window flushes the draft, so join writes after close.
	t.Cleanup(sessionDraftWrites.Wait)
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		sess = a.makeSession(sessionMeta{ID: "design-reference", Cwd: project, Title: "设计语言对齐"}, localTarget)
		sess.loaded.Set(true)
		sess.readySig.Set(true)
		now := cx.Now()
		sess.turns.Set([]turn{{ID: "design-answer", Prompt: "检查字体、间距与按钮的光学对齐。",
			Final:  "## 阅读与操作的层级\n\n正文保持清晰，过程安静退后。\n\nMixed text 与中文采用系统无衬线字体，只有 `session.ID` 和代码使用等宽字体。\n\n```go\nfunc main() {\n    fmt.Println(\"PiDeck\")\n}\n```",
			Status: chat.Completed, Model: "reference/model", Start: now.Add(-8 * time.Second), End: now}})
		a.activeID.Set(sess.ID)
		a.tabs.Set([]string{sess.ID})
		return a.view()
	}, nsgotest.Size(1320, 860), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	t.Cleanup(a.closeDiag)
	screen.WaitFor("text:正文保持清晰，过程安静退后。", 10*time.Second)
	return a, screen, sess
}
