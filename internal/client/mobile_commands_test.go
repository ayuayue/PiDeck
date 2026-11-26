package client

import (
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMobileSlashCommandSendAndRecover(t *testing.T) {
	for _, refused := range []bool{false, true} {
		name := "sent"
		if refused {
			name = "refused"
		}
		t.Run(name, func(t *testing.T) {
			desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话"})
			var screen *nsgotest.App
			desk.open(t, &screen)
			screen.WaitFor("id:mobile-session", 10*time.Second)
			screen.Press("id:mobile-session")
			screen.WaitFor("text:先前的回复", 10*time.Second)
			if refused {
				desk.mu.Lock()
				desk.failNext = true
				desk.mu.Unlock()
			}
			const command = "/compact 保留任务目标与验证结论"
			screen.Type("id:mobile-draft", command)
			screen.Press("id:mobile-send")
			if refused {
				screen.WaitFor("id:mobile-error", 5*time.Second)
				screen.WaitUntil(5*time.Second, func() bool { return draftValue(screen) == command })
				return
			}
			screen.WaitUntil(5*time.Second, func() bool {
				sent := desk.sentPrompts()
				return len(sent) == 1 && sent[0] == command && draftValue(screen) == ""
			})
		})
	}
}
