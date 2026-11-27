//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func historyReadingFixture(t *testing.T, dark bool) (*app, *nsgotest.App, *session) {
	t.Helper()
	project := t.TempDir()
	built, screen := navigationSessionFixture(t, project, dark)
	screen.WaitFor("id:project-row", 5*time.Second)
	var reading *session
	screen.Post(func() {
		ws := built.workspaceOf(project)
		for i, title := range []string{"阅读历史", "另一个会话"} {
			s := built.blankSession(fmt.Sprint(i), ws, title)
			s.agentClosed = true
			s.draft.Set("尚未发送的草稿 " + s.ID)
			ws.Sessions.Update(func(list []*session) []*session { return append(list, s) })
			built.addTab(s.ID)
			if i == 0 {
				reading = s
				var turns []turn
				for n := range 24 {
					turns = append(turns, turn{ID: fmt.Sprintf("history-%02d", n),
						Prompt: fmt.Sprintf("历史问题 %02d：请保留我正在阅读的位置。", n),
						Final:  strings.Repeat("这是用于核对阅读位置的历史内容。\n\n", 3),
						Status: chat.Completed})
				}
				s.turns.Set(turns)
			}
		}
		built.activeID.Set(reading.ID)
	})
	screen.WaitFor("id:chat-transcript", 5*time.Second)
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:tab")) == 2 })
	return built, screen, reading
}

func historyReadEarlier(t *testing.T, screen *nsgotest.App, s *session) float64 {
	t.Helper()
	screen.Scroll("id:chat-transcript", -420)
	v := screen.Find("id:chat-transcript")
	if v.Offset.Y <= 100 || s.conversation.following.GetUntracked() {
		t.Fatalf("fixture did not leave the latest message: offset=%v following=%t", v.Offset, s.conversation.following.GetUntracked())
	}
	return float64(v.Offset.Y)
}

func TestHistoryReadingPositionSurvivesSwitch(t *testing.T) {
	for _, dark := range []bool{false, true} {
		t.Run(fmt.Sprint(dark), func(t *testing.T) {
			_, screen, reading := historyReadingFixture(t, dark)
			want := historyReadEarlier(t, screen, reading)
			screen.Screenshot(fmt.Sprintf("history-reading-%t-before", dark))
			screen.Press("id:tab >> nth=1")
			screen.Focus("id:tab >> nth=0")
			screen.Key("Return")
			screen.Screenshot(fmt.Sprintf("history-reading-%t-restored", dark))
			if got := screen.Find("id:chat-transcript").Offset.Y; math.Abs(float64(got)-want) > 1 {
				t.Fatalf("switching sessions lost the reading position: got=%v want=%v", got, want)
			}
			if reading.conversation.following.GetUntracked() {
				t.Fatal("switching sessions resumed following without the reader asking")
			}
			if got := screen.Find("id:composer").Text; got != "尚未发送的草稿 0" {
				t.Fatalf("switching sessions changed the draft: %q", got)
			}
		})
	}
}

func TestHistoryReadyKeepsReadingPosition(t *testing.T) {
	built, screen, reading := historyReadingFixture(t, false)
	want := historyReadEarlier(t, screen, reading)
	screen.Post(func() {
		reading.readySig.Set(true)
		built.historyReady(reading)
	})
	screen.WaitUntil(time.Second, func() bool { return reading.readySig.GetUntracked() })
	if got := screen.Find("id:chat-transcript").Offset.Y; math.Abs(float64(got)-want) > 1 {
		t.Fatalf("background history readiness interrupted reading: got=%v want=%v", got, want)
	}
	if reading.conversation.following.GetUntracked() {
		t.Fatal("background history readiness resumed following")
	}
}

func TestHistoryReaderCanResumeFollowing(t *testing.T) {
	built, screen, reading := historyReadingFixture(t, false)
	historyReadEarlier(t, screen, reading)
	screen.Focus("id:composer")
	screen.Key("shift+tab")
	if trust := screen.Query("id:trust-project"); len(trust) > 0 && trust[0].Focused {
		screen.Key("shift+tab")
	}
	if !screen.Find("role:button 跳到最新消息").Focused {
		t.Fatal("reverse keyboard navigation did not reach the latest-message button")
	}
	screen.Key("Return")
	if !reading.conversation.following.GetUntracked() {
		t.Fatal("the reader could not resume following with the keyboard")
	}
	screen.Post(func() {
		reading.turns.Update(func(turns []turn) []turn {
			return append(turns, turn{ID: "new-reply", Prompt: "新的问题", Final: "最新回复", Status: chat.Completed})
		})
		reading.readySig.Set(true)
		built.historyReady(reading)
	})
	screen.WaitUntil(time.Second, func() bool { return len(reading.turns.GetUntracked()) == 25 })
	v := screen.Find("id:chat-transcript")
	if gap := v.Content.Height - v.Frame.Size.Height - v.Offset.Y; gap > 2 {
		t.Fatalf("the following transcript missed its newest reply: gap=%v offset=%v", gap, v.Offset.Y)
	}
	if !reading.conversation.following.GetUntracked() {
		t.Fatal("history readiness stopped following the newest reply")
	}
}

func TestChatScrollIgnoresStaleReports(t *testing.T) {
	for _, following := range []bool{false, true} {
		t.Run(fmt.Sprint(following), func(t *testing.T) {
			var scroll *chatScroll
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				scroll = newChatScroll(cx)
				return core.View{}
			}, nsgotest.Size(320, 240))
			var done bool
			want := core.Points(1000)
			screen.Post(func() {
				end := core.ScrollEvent{Offset: core.Point{Y: 1000}, Size: core.Size{Height: 500}, ContentSize: core.Size{Height: 1500}}
				scroll.scrolled(end)
				stale := end
				if following {
					stale.Offset.Y = 0
				} else {
					reading := end
					reading.Offset.Y = 420
					scroll.scrolled(reading)
					want = 420
				}
				stale.Stale = true
				scroll.scrolled(stale)
				done = true
			})
			screen.WaitUntil(time.Second, func() bool { return done })
			if scroll.lastY != want || scroll.following.GetUntracked() != following {
				t.Fatalf("stale platform report changed reading state: offset=%v want=%v following=%t want=%t", scroll.lastY, want, scroll.following.GetUntracked(), following)
			}
		})
	}
}
