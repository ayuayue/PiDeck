//go:build !js && !android && !ios

package workbench

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

// Exercise the phone's real prompt handler without starting pi, watchers or
// the app's startup probes. The pipe records and answers its JSONL calls.
func remoteCommandFixture(t *testing.T) (*app, *session, *nsgotest.App, <-chan map[string]any) {
	t.Helper()
	var a *app
	var s *session
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = &app{cx: cx, byID: map[string]*session{},
			workspaces: core.NewSignalFunc(cx, []*workspace(nil), nil), toaster: ui.NewToaster(cx)}
		s = a.blankSession("phone-command", &workspace{}, "Phone command")
		return core.View{}
	})
	reader, writer := io.Pipe()
	c := &piClient{in: writer, pending: map[string]chan response{}}
	s.engine = c
	commands := make(chan map[string]any, 16)
	done := make(chan struct{})
	go func() {
		defer close(done)
		decoder := json.NewDecoder(reader)
		for {
			var command map[string]any
			if err := decoder.Decode(&command); err != nil {
				return
			}
			commands <- command
			reply, _ := json.Marshal(map[string]any{"type": "response", "id": command["id"], "success": true,
				"data": map[string]any{"disposition": "handled", "tokensBefore": 1200, "estimatedTokensAfter": 200}})
			c.dispatch(reply)
		}
	}()
	t.Cleanup(func() {
		c.shutdown(nil)
		_ = reader.Close()
		_ = writer.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("fake pi did not stop")
		}
	})
	return a, s, screen, commands
}

func postRemoteCommand(t *testing.T, a *app, s *session, screen *nsgotest.App, text string, images []remotewire.Image) *httptest.ResponseRecorder {
	t.Helper()
	var wireImages []map[string]string
	for _, img := range images {
		wireImages = append(wireImages, map[string]string{"mime": img.MimeType, "data": base64.StdEncoding.EncodeToString(img.Data)})
	}
	body, err := json.Marshal(map[string]any{"text": text, "images": wireImages})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+s.ID+"/prompt", strings.NewReader(string(body)))
		(&remoteHost{app: a}).handleSessionAction(rec, req)
		done <- rec
	}()
	var rec *httptest.ResponseRecorder
	screen.WaitUntil(5*time.Second, func() bool {
		select {
		case rec = <-done:
			return true
		default:
			return false
		}
	})
	if rec == nil {
		t.Fatal("phone prompt handler did not respond")
	}
	return rec
}

func TestRemoteCompactCommand(t *testing.T) {
	for _, tc := range []struct {
		name, text, instructions, mode string
	}{
		{name: "plain", text: "/compact"},
		{name: "instructions", text: "  /compact 保留修改与验证结论  ", instructions: "保留修改与验证结论"},
		{name: "unicode whitespace", text: "/compact\u3000保留任务目标", instructions: "保留任务目标"},
		{name: "image mode", text: "/compact", mode: modeImage},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, s, screen, commands := remoteCommandFixture(t)
			if tc.mode != "" {
				s.agentMode.Set(tc.mode)
			}
			rec := postRemoteCommand(t, a, s, screen, tc.text, nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("compact = %d: %s", rec.Code, rec.Body.String())
			}
			var command map[string]any
			screen.WaitUntil(5*time.Second, func() bool {
				select {
				case command = <-commands:
					return true
				default:
					return false
				}
			})
			if command["type"] != "compact" {
				t.Fatalf("/compact reached pi as %v, want compact RPC", command)
			}
			if tc.instructions == "" && command["customInstructions"] != nil {
				t.Fatalf("plain compact added custom instructions: %v", command)
			}
			if got, _ := command["customInstructions"].(string); got != tc.instructions {
				t.Fatalf("customInstructions = %q, want %q", got, tc.instructions)
			}
			if turns := s.turns.GetUntracked(); len(turns) != 0 {
				t.Fatalf("command created an ordinary prompt turn: %+v", turns)
			}
			screen.WaitUntil(5*time.Second, func() bool { return s.notice.GetUntracked() == "" })
		})
	}
}

func TestRemoteCompactCommandRefusals(t *testing.T) {
	for _, state := range []string{"running", "starting turn", "warming", "compacting", "stopping", "loading", "retrying", "images", "untrusted", "deleting"} {
		t.Run(state, func(t *testing.T) {
			a, s, screen, commands := remoteCommandFixture(t)
			var images []remotewire.Image
			switch state {
			case "running", "starting turn":
				s.runningSig.Set(true)
				s.status.Set(statusRunning)
				if state == "starting turn" {
					s.status.Set(statusStarting)
				}
			case "warming":
				s.starting = true
			case "compacting":
				s.status.Set(statusWaiting)
			case "stopping":
				s.agentStopping = true
			case "loading":
				s.historyLoading = true
			case "retrying":
				s.retrying.Set(true)
			case "images":
				images = []remotewire.Image{{MimeType: "image/png", Data: []byte("image")}}
			case "untrusted":
				a.workspaces.Set([]*workspace{{Path: s.WS, Target: s.Target}})
			case "deleting":
				s.deleting = true
			}
			rec := postRemoteCommand(t, a, s, screen, "/compact", images)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("compact while %s = %d: %s", state, rec.Code, rec.Body.String())
			}
			select {
			case command := <-commands:
				t.Fatalf("refused command still reached pi: %v", command)
			default:
			}
			if len(s.turns.GetUntracked()) != 0 {
				t.Fatal("refused command created a prompt turn")
			}
		})
	}
}

func TestRemoteOtherSlashCommandsReachPi(t *testing.T) {
	for _, text := range []string{"/compactness", "/extension arg", "/skill:review", "请运行 /compact"} {
		t.Run(text, func(t *testing.T) {
			a, s, screen, commands := remoteCommandFixture(t)
			rec := postRemoteCommand(t, a, s, screen, text, nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("prompt = %d: %s", rec.Code, rec.Body.String())
			}
			var command map[string]any
			screen.WaitUntil(5*time.Second, func() bool {
				select {
				case command = <-commands:
					return true
				default:
					return false
				}
			})
			if command["type"] != "prompt" || command["message"] != text {
				t.Fatalf("message was intercepted: %v", command)
			}
		})
	}
}

func TestRemoteBusyCommandDelivery(t *testing.T) {
	for _, tc := range []struct {
		name, backend, mode, text string
		queued                    bool
	}{
		{name: "ACP native command", backend: "acp", mode: deliverySteer, text: "/compact", queued: true},
		{name: "pi follow-up", backend: "pi", mode: deliveryFollowUp, text: "/extension arg", queued: true},
		{name: "pi steering", backend: "pi", text: "/extension arg"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, s, screen, commands := remoteCommandFixture(t)
			s.backend = tc.backend
			if tc.backend == "acp" {
				s.engine = nil
			}
			s.sendMode.Set(tc.mode)
			s.runningSig.Set(true)
			s.status.Set(statusRunning)
			rec := postRemoteCommand(t, a, s, screen, tc.text, nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("busy command = %d: %s", rec.Code, rec.Body.String())
			}
			if tc.queued {
				queued := s.sending.GetUntracked()
				if len(queued) != 1 || queued[0].Text != tc.text {
					t.Fatalf("command was not queued unchanged: %+v", queued)
				}
				select {
				case command := <-commands:
					t.Fatalf("queued command reached pi: %v", command)
				default:
				}
				return
			}
			var command map[string]any
			screen.WaitUntil(5*time.Second, func() bool {
				select {
				case command = <-commands:
					return true
				default:
					return false
				}
			})
			if command["type"] != "steer" || command["message"] != tc.text {
				t.Fatalf("steering command = %v", command)
			}
			if len(s.sending.GetUntracked()) != 0 {
				t.Fatal("steering command was also queued")
			}
		})
	}
}
