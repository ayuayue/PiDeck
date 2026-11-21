//go:build !js && !android && !ios

package workbench

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
)

func TestTrustNotice(t *testing.T) {
	// Exercise the states and both input methods in one window, keeping
	// the composer and its draft alive throughout the trust workflow.
	a, screen, sess := chatDesignFixture(t, 0)
	for _, tc := range []struct {
		name, theme, language string
		width                 core.Points
	}{
		{"light", "light", "zh-CN", 1320},
		{"dark", "dark", "zh-CN", 1320},
		{"narrow", "light", "zh-CN", 760},
		{"narrow-french", "dark", "fr-FR", 760},
	} {
		t.Run("layout/"+tc.name, func(t *testing.T) {
			screen.Post(func() {
				a.theme.Set(tc.theme)
				a.applyTheme()
				a.setLanguage(tc.language)
			})
			screen.Resize(tc.width, 860)
			screen.WaitFor("id:trust-bar", 5*time.Second)
			notice := screen.Find("id:trust-bar").Bounds()
			card := screen.Find("id:composer-card").Bounds()
			if gap := card.Origin.Y - notice.Origin.Y - notice.Size.Height; gap < 6 {
				t.Fatalf("trust notice touches the composer: gap = %v, want at least 6", gap)
			}
			message := screen.Find("id:trust-message")
			if got := message.TextStyle.Font.Size; got < 12 {
				t.Errorf("notice font = %v, want at least 12", got)
			}
			text := message.Bounds()
			button := screen.Find("id:trust-project").Bounds()
			if text.Origin.X+text.Size.Width > button.Origin.X+1 {
				t.Errorf("notice text %v overlaps action %v", text, button)
			}
			if button.Origin.X+button.Size.Width > notice.Origin.X+notice.Size.Width+1 ||
				text.Origin.Y+text.Size.Height > notice.Origin.Y+notice.Size.Height+1 {
				t.Errorf("notice %v clips text %v or action %v", notice, text, button)
			}
			if top := screen.Find("id:trust-bar").Style.Borders.Top; top != 0 {
				t.Errorf("notice retains a banner divider: top border = %v", top)
			}
			shot(screen, "trust-notice/"+tc.name)
		})
	}
	screen.Post(func() {
		a.setLanguage("zh-CN")
		a.theme.Set("light")
		a.applyTheme()
	})
	screen.Resize(1320, 860)
	for _, keyboard := range []bool{false, true} {
		name := "pointer"
		if keyboard {
			name = "keyboard"
		}
		t.Run("action/"+name, func(t *testing.T) {
			const draft = "保留正在编辑的草稿"
			screen.Clear("id:composer")
			screen.Type("id:composer", draft)
			if keyboard {
				screen.Focus("id:trust-project")
				if !screen.Find("id:trust-project").Focused {
					t.Fatal("trust action did not receive keyboard focus")
				}
				screen.Key("Return")
			} else {
				screen.Press("id:trust-project")
			}
			screen.WaitForGone("id:trust-bar", 5*time.Second)
			if got := screen.Find("id:composer").Text; got != draft {
				t.Errorf("draft = %q, want %q", got, draft)
			}
			screen.Post(func() {
				ws := a.workspaceFor(sess.Target, sess.WS)
				if !a.projectTrusted(ws) {
					t.Error("trust action did not trust the current project")
				}
				a.untrustProject(ws)
			})
			screen.WaitFor("id:trust-bar", 5*time.Second)
			if got := screen.Find("id:composer").Text; got != draft {
				t.Errorf("revoking trust changed draft to %q, want %q", got, draft)
			}
		})
	}
}
