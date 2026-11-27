//go:build !js && !android && !ios

package workbench

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func queuePanelFixture(t *testing.T) (*app, *session, *nsgotest.App) {
	t.Helper()
	var a *app
	var s *session
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = &app{cx: cx, byID: map[string]*session{}, toaster: ui.NewToaster(cx),
			workspaces:    core.NewSignalFunc(cx, []*workspace(nil), nil),
			attachPreview: core.NewSignalFunc(cx, remotewire.Image{}, nil)}
		s = a.blankSession("queue-fixture", &workspace{}, "Queue")
		s.runningSig.Set(true)
		var editor core.Ref
		return core.View{Style: core.Style{Padding: core.All(16), MinWidth: core.Pt(0)}, Children: []core.Node{
			a.queuePanel(s, &editor),
			base.Input{Ref: &editor, Value: s.draft.Get, OnChange: s.draft.Set, Label: "消息", TestID: "composer", Multiline: true,
				Style: core.Style{Height: core.Pt(100)}},
		}}
	}, nsgotest.Size(480, 480))
	return a, s, screen
}

func queueTestPNG(t *testing.T) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 32, 24))
	for y := 0; y < 24; y++ {
		for x := 0; x < 32; x++ {
			picture.Set(x, y, color.RGBA{R: 55, G: uint8(100 + x*3), B: uint8(100 + y*4), A: 255})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, picture); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestQueuePanelShowsImagesAndRecall(t *testing.T) {
	a, s, screen := queuePanelFixture(t)
	image := remotewire.Image{Name: "queued.png", MimeType: "image/png", Data: queueTestPNG(t)}
	onNativeUI(t, screen, a, func() {
		s.sending.Set([]queuedMessage{{ID: "queued", Text: "看看这张图", Images: []remotewire.Image{image}}})
	})
	screen.Press("id:queue-image-queued-0")
	if !bytes.Equal(a.attachPreview.GetUntracked().Data, image.Data) {
		t.Fatal("queue image did not open its preview")
	}
	onNativeUI(t, screen, a, func() { s.draft.Set("  正在写的新草稿  ") })
	screen.Press("id:queue-retract")
	screen.WaitForGone("id:queue-panel", 5*time.Second)
	if s.draft.GetUntracked() != "看看这张图\n\n  正在写的新草稿  " || len(s.images.GetUntracked()) != 1 {
		t.Fatal("recall did not restore both text and image while preserving the existing draft")
	}
	if !screen.Find("id:composer").Focused {
		t.Fatal("recall did not focus the composer")
	}
}

// queueRPCFixture models pi's text-only events and clear_queue response while
// retaining the exact commands, so attachment preservation is tested on the wire.
func queueRPCFixture(t *testing.T, a *app, s *session, before func(map[string]any), reject func(map[string]any) bool) func() []map[string]any {
	t.Helper()
	reader, writer := io.Pipe()
	c := &piClient{in: writer, pending: map[string]chan response{}}
	s.engine = c
	var mu sync.Mutex
	var commands []map[string]any
	var steering, followUp []string
	done := make(chan struct{})
	go func() {
		defer close(done)
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			var cmd map[string]any
			if json.Unmarshal(scanner.Bytes(), &cmd) != nil {
				return
			}
			mu.Lock()
			commands = append(commands, cmd)
			mu.Unlock()
			if before != nil {
				before(cmd)
			}
			kind, _ := cmd["type"].(string)
			data := map[string]any{}
			success := reject == nil || !reject(cmd)
			if success {
				switch kind {
				case "steer":
					steering = append(steering, cmd["message"].(string))
				case "follow_up":
					followUp = append(followUp, cmd["message"].(string))
				case "clear_queue":
					data["steering"], data["followUp"] = append([]string(nil), steering...), append([]string(nil), followUp...)
					steering, followUp = nil, nil
				}
				texts := append([]string(nil), steering...)
				a.cx.Post(func() { a.applyEvent(s, piEvent{Type: "queue_update", Steering: texts}) })
			}
			reply, _ := json.Marshal(map[string]any{"type": "response", "id": cmd["id"], "success": success,
				"error": "queue command rejected", "data": data})
			c.dispatch(reply)
		}
	}()
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
		c.shutdown(nil)
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("queue RPC fixture did not stop")
		}
	})
	return func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]any(nil), commands...)
	}
}

func TestQueuePanelSwitchBothDirections(t *testing.T) {
	a, s, screen := queuePanelFixture(t)
	commands := queueRPCFixture(t, a, s, nil, nil)
	image := remotewire.Image{Name: "queued.png", MimeType: "image/png", Data: queueTestPNG(t)}
	onNativeUI(t, screen, a, func() {
		s.turns.Set([]turn{{ID: "running", Status: chat.Running}})
		a.queueFollowUp(s, "看看这张图", []remotewire.Image{image})
	})
	id := s.sending.GetUntracked()[0].ID
	screen.Press("id:queue-switch")
	screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	steering := s.steering.GetUntracked()
	if len(steering) != 1 || steering[0].ID != id || len(steering[0].Images) != 1 || len(s.sending.GetUntracked()) != 0 {
		t.Fatalf("follow-up to steer lost message metadata: %+v", steering)
	}
	wire := commands()
	images, ok := wire[0]["images"].([]any)
	if wire[0]["type"] != "steer" || !ok || len(images) != 1 || images[0].(map[string]any)["data"] != base64.StdEncoding.EncodeToString(image.Data) {
		t.Fatal("switch did not send the queued image with its text")
	}
	screen.Find("id:queue-image-" + id + "-0")
	screen.Press("id:queue-switch")
	screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	held := s.sending.GetUntracked()
	if len(held) != 1 || held[0].ID != id || !bytes.Equal(held[0].Images[0].Data, image.Data) || len(s.steering.GetUntracked()) != 0 {
		t.Fatal("steer to follow-up lost message or attachment")
	}
	screen.Press("id:queue-switch")
	screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	if got := commands(); len(got) != 3 || got[1]["type"] != "clear_queue" || got[2]["type"] != "steer" {
		t.Fatalf("unexpected switch RPC sequence: %+v", got)
	}
	screen.Press("id:queue-retract")
	screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	if s.draft.GetUntracked() != "看看这张图" || len(s.images.GetUntracked()) != 1 || !screen.Find("id:composer").Focused {
		t.Fatal("steering recall did not restore and focus the composer")
	}
}

func TestQueueRecallPreservesOtherSteering(t *testing.T) {
	a, s, screen := queuePanelFixture(t)
	commands := queueRPCFixture(t, a, s, nil, nil)
	image := remotewire.Image{Name: "remaining.png", MimeType: "image/png", Data: queueTestPNG(t)}
	onNativeUI(t, screen, a, func() {
		s.turns.Set([]turn{{ID: "running", Status: chat.Running}})
		a.steer(s, "收回这条", nil)
	})
	screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	onNativeUI(t, screen, a, func() { a.steer(s, "保留这张图", []remotewire.Image{image}) })
	screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	remainingID := s.steering.GetUntracked()[1].ID
	screen.Press("id:queue-steer >> nth=0 >> id:queue-retract")
	screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	if got := s.steering.GetUntracked(); len(got) != 1 || got[0].ID != remainingID || len(got[0].Images) != 1 {
		t.Fatal("recalling one message lost a different message's image")
	}
	wire := commands()
	if len(wire) != 4 || wire[2]["type"] != "clear_queue" || wire[3]["message"] != "保留这张图" || len(wire[3]["images"].([]any)) != 1 {
		t.Fatalf("remaining steering was not re-enqueued intact: %+v", wire)
	}
}

func TestQueueEditClearFailureKeepsMessages(t *testing.T) {
	a, s, screen := queuePanelFixture(t)
	queueRPCFixture(t, a, s, nil, func(cmd map[string]any) bool { return cmd["type"] == "clear_queue" })
	onNativeUI(t, screen, a, func() {
		s.turns.Set([]turn{{ID: "running", Status: chat.Running}})
		a.steer(s, "不能丢掉", nil)
		a.queueFollowUp(s, "本地排队", nil)
	})
	screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	screen.Press("id:queue-steer >> id:queue-retract")
	screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	if len(s.steering.GetUntracked()) != 1 || len(s.sending.GetUntracked()) != 1 || s.draft.GetUntracked() != "" {
		t.Fatal("failed clear_queue changed the queue or draft")
	}
}

func TestQueueACPSupportsRecallWithoutSwitch(t *testing.T) {
	a, s, screen := queuePanelFixture(t)
	onNativeUI(t, screen, a, func() {
		s.backend = "acp"
		s.turns.Set([]turn{{ID: "running", Status: chat.Running}})
		s.draft.Set("ACP 排队")
		a.sendDraft(s, deliverySteer)
	})
	if len(screen.Query("id:queue-switch")) != 0 || len(s.sending.GetUntracked()) != 1 {
		t.Fatal("ACP exposed an unsupported steering action")
	}
	screen.Press("id:queue-retract")
	if s.draft.GetUntracked() != "ACP 排队" {
		t.Fatal("ACP queued message could not be recalled")
	}
}

func TestQueueReconcileRetainsImagesAndConsumedDuplicate(t *testing.T) {
	first := queuedMessage{ID: "first", Text: "相同文本", QueueText: "相同文本", Images: []remotewire.Image{{Name: "first.png"}}}
	second := queuedMessage{ID: "second", Text: "相同文本", QueueText: "相同文本", Images: []remotewire.Image{{Name: "second.png"}}}
	got := reconcileSteering([]queuedMessage{first, second}, []string{"相同文本"}, false)
	if len(got) != 1 || got[0].ID != "second" || got[0].Images[0].Name != "second.png" {
		t.Fatalf("consumed duplicate kept the wrong attachment: %+v", got)
	}
	pending := queuedMessage{ID: "template", Text: "/template", Pending: true, Images: second.Images}
	got = reconcileSteering([]queuedMessage{pending}, []string{"expanded template"}, true)
	if len(got) != 1 || got[0].ID != "template" || got[0].Text != "/template" || got[0].QueueText != "expanded template" {
		t.Fatalf("template expansion lost composer metadata: %+v", got)
	}
	first.Pending, second.Pending = true, true
	first.QueueText, second.QueueText = "", ""
	got = reconcileSteering([]queuedMessage{first, second}, []string{"相同文本"}, true)
	if len(got) != 2 || got[0].ID != "first" || got[0].Pending || got[1].ID != "second" || !got[1].Pending {
		t.Fatalf("concurrent identical sends lost FIFO attachment metadata: %+v", got)
	}
}

func TestQueueEditDoesNotRestoreConsumedMessage(t *testing.T) {
	for _, action := range []queueAction{queueRecall, queueSwitch} {
		t.Run(string(rune('a'+action)), func(t *testing.T) {
			a, s, screen, _ := remoteCommandFixture(t, func(cmd map[string]any) map[string]any {
				return map[string]any{"data": map[string]any{"steering": []string{}, "followUp": []string{}}}
			})
			onNativeUI(t, screen, a, func() {
				s.runningSig.Set(true)
				s.turns.Set([]turn{{ID: "running", Status: chat.Running}})
				s.steering.Set([]queuedMessage{{ID: "consumed", Text: "已经被 pi 取走"}})
				a.editQueue(s, "consumed", deliverySteer, action, nil)
			})
			screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
			if len(s.sending.GetUntracked()) != 0 || s.draft.GetUntracked() != "" || len(s.steering.GetUntracked()) != 0 {
				t.Fatal("clear_queue response did not prevent a consumed message from reappearing")
			}
		})
	}
}

func TestQueueRebuildFailurePreservesDuplicateImages(t *testing.T) {
	a, s, screen := queuePanelFixture(t)
	steers := 0
	queueRPCFixture(t, a, s, nil, func(cmd map[string]any) bool {
		if cmd["type"] == "steer" {
			steers++
			return steers == 5
		}
		return false
	})
	for _, image := range []string{"recall.png", "first.png", "second.png"} {
		onNativeUI(t, screen, a, func() {
			text := "相同文本"
			if image == "recall.png" {
				text = "收回"
			}
			a.steer(s, text, []remotewire.Image{{Name: image, Data: queueTestPNG(t)}})
		})
		screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	}
	remainingID := s.steering.GetUntracked()[1].ID
	screen.Press("id:queue-steer >> nth=0 >> id:queue-retract")
	screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	got := s.steering.GetUntracked()
	if len(got) != 1 || got[0].ID != remainingID || got[0].Images[0].Name != "first.png" {
		t.Fatalf("failed rebuild mixed duplicate attachment metadata: %+v", got)
	}
	images := s.images.GetUntracked()
	if len(images) != 2 || images[0].Name != "second.png" || images[1].Name != "recall.png" {
		t.Fatalf("failed rebuild did not restore the unsent image and recalled image: %+v", images)
	}
}

func TestQueueNewSendDuringRecallKeepsImages(t *testing.T) {
	a, s, screen := queuePanelFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	queueRPCFixture(t, a, s, func(cmd map[string]any) {
		if cmd["type"] == "clear_queue" {
			close(entered)
			<-release
		}
	}, nil)
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	for _, name := range []string{"recall.png", "remaining.png"} {
		onNativeUI(t, screen, a, func() { a.steer(s, name, []remotewire.Image{{Name: name, Data: queueTestPNG(t)}}) })
		screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	}
	screen.Press("id:queue-steer >> nth=0 >> id:queue-retract")
	screen.WaitUntil(5*time.Second, func() bool {
		select {
		case <-entered:
			return true
		default:
			return false
		}
	})
	onNativeUI(t, screen, a, func() { a.steer(s, "new.png", []remotewire.Image{{Name: "new.png", Data: queueTestPNG(t)}}) })
	releaseOnce.Do(func() { close(release) })
	screen.WaitUntil(5*time.Second, func() bool { return !s.queueWorking() })
	got := s.steering.GetUntracked()
	if len(got) != 2 || len(got[0].Images) != 1 || len(got[1].Images) != 1 || got[0].Images[0].Name != "remaining.png" || got[1].Images[0].Name != "new.png" {
		t.Fatalf("new send during recall lost or mixed attachments: %+v", got)
	}
}

func TestQueuePanelControlsInsideNarrowOverflow(t *testing.T) {
	a, s, screen := queuePanelFixture(t)
	onNativeUI(t, screen, a, func() {
		var list []queuedMessage
		for i := 0; i < 8; i++ {
			msg := newQueuedMessage(a.cx.Now(), strings.Repeat("窄栏长消息", 12), []remotewire.Image{{Name: "image.png", Data: queueTestPNG(t)}})
			list = append(list, msg)
		}
		s.sending.Set(list)
	})
	screen.Resize(320, 480)
	viewport := screen.Find("id:queue-scroll").Bounds()
	for _, control := range screen.Query("id:queue-delete") {
		bounds := control.Bounds()
		if bounds.Origin.X+bounds.Size.Width > viewport.Origin.X+viewport.Size.Width-viewkit.PanelInset+1 {
			t.Fatalf("queue control overlaps scrollbar: %v in %v", bounds, viewport)
		}
	}
	shot(screen, "queue/narrow-overflow")
}
