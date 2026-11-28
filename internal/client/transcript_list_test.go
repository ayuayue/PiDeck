package client

import (
	"fmt"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMobileTranscriptJumpsBetweenMatches(t *testing.T) {
	var a *mobileApp
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newMobileApp(cx)
		return a.transcriptList()
	}, nsgotest.Size(420, 620))
	lines := make([]remotewire.Message, 90)
	for i := range lines {
		lines[i] = remotewire.Message{Turn: i, Role: "user", Text: fmt.Sprintf("旁边的提问 %d", i)}
	}
	lines[8].Text = "needle 一"
	lines[78].Text = "needle 二"
	a.messages.Set(lines)
	a.findOpen.Set(true)
	screen.WaitFor("id:mobile-find-input", 5*time.Second)
	screen.Type("id:mobile-find-input", "needle")
	screen.WaitFor("text:needle 一", 5*time.Second)
	screen.WaitFor("text:旁边的提问 9", 5*time.Second)
	screen.Press("id:mobile-find-next")
	screen.WaitFor("text:needle 二", 5*time.Second)
	screen.WaitFor("text:2/2", 5*time.Second)
	screen.Press("id:mobile-find-next")
	screen.WaitFor("text:needle 一", 5*time.Second)
}
