//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestNativeDraftExperienceScreens(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	home, project := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"scanPi":false,"telemetryEnabled":false,"autoModelCatalog":false,"theme":"light"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var a *app
	var s *session
	t.Cleanup(sessionDraftWrites.Wait)
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		s = a.makeSession(sessionMeta{ID: "draft-experience", Cwd: project, Title: "首版体验验收"}, localTarget)
		s.turns.Set([]turn{{ID: "answer", Prompt: "帮我检查这个项目的首版体验。", Final: "核心路径已经连通。接下来补充边界测试，并确认草稿不会被晚到的 AI 结果覆盖。", Status: chat.Completed}})
		a.activeID.Set(s.ID)
		a.tabs.Set([]string{s.ID})
		return a.view()
	}, nsgotest.Size(1280, 860))
	t.Cleanup(a.closeDiag)
	screen.WaitFor("id:turn-edit-prompt", 10*time.Second)
	onNativeUI(t, screen, a, func() {
		s.draft.Set("继续检查输入和消息修改的体验。")
		a.offerDraftChange(s, "", "请补充一份可复现的首版验收清单，覆盖输入、修改、翻译与保存失败的反馈。")
	})
	screen.WaitFor("id:draft-change-apply", 5*time.Second)
	shot(screen, "v1/draft-conflict-light")
	screen.Press("id:draft-change-apply")
	screen.WaitFor("id:draft-change-undo", 5*time.Second)
	shot(screen, "v1/draft-undo-light")
	screen.Press("id:draft-change-undo")
	screen.Press("id:turn-translate")
	screen.WaitFor("id:translate-dialog", 5*time.Second)
	shot(screen, "v1/reply-translation")
	onNativeUI(t, screen, a, func() { a.closeTranslation(); a.openPromptTemplate() })
	screen.WaitFor("text:"+toolSystem("prompt"), 5*time.Second)
	shot(screen, "v1/prompt-template-light")
	onNativeUI(t, screen, a, func() { a.theme.Set("dark"); a.applyTheme() })
	shot(screen, "v1/prompt-template-dark")
}
