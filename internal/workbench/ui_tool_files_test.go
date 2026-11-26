//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"example.com/pideck-v2/assets"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestToolImagesStayCompactAndOpenDialog(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	for name, data := range map[string][]byte{
		"result.png": assets.LogoPNG,
		"report.md":  []byte("# 工具生成的报告"),
		"data.csv":   []byte("name,count\npreview,3\n"),
		"source.go":  []byte("package main"),
		"notes.txt":  []byte("notes"),
		"broken.png": []byte("not an image"),
	} {
		if err := os.WriteFile(filepath.Join(s.WS, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	marshal := func(v any) json.RawMessage {
		t.Helper()
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	calls := []piContent{
		{Type: "toolCall", ID: "files", Name: "read", Arguments: marshal(map[string][]string{
			"paths": {"report.md", "data.csv", "source.go", "notes.txt", "broken.png", "result.png"},
		})},
		{Type: "toolCall", ID: "returned-image", Name: "image"},
	}
	messages := []piMessage{
		{Role: "user", Content: marshal("检查生成的文件")},
		{Role: "assistant", Content: marshal(calls)},
		{Role: "toolResult", ToolCallID: "files", ToolName: "read", Content: marshal([]piContent{{Type: "text", Text: "done"}})},
		{Role: "toolResult", ToolCallID: "returned-image", ToolName: "image",
			Content: marshal([]piContent{{Type: "image", Data: base64.StdEncoding.EncodeToString(assets.LogoPNG)}})},
	}
	onNativeUI(t, screen, a, func() { s.turns.Set(turnsFromMessages(messages)) })
	screen.WaitFor("text:执行过程", 5*time.Second)
	screen.Press("text:执行过程")
	screen.WaitFor("id:tool-file-thumbnail", 5*time.Second)
	screen.WaitFor("id:transcript-image-tile", 5*time.Second)
	if got := len(screen.Query("id:tool-file-card")); got != 1 {
		t.Fatalf("tool files produced %d cards, want only the valid image", got)
	}
	if got := len(screen.Query("id:tool-output")); got != 0 {
		t.Fatalf("completed tool output should stay folded, got %d open bodies", got)
	}
	if nsgotest.Target() != "" {
		shot(screen, "tool-files/compact-light")
	}
	onNativeUI(t, screen, a, func() { a.theme.Set("dark"); a.applyTheme() })
	screen.Resize(900, 760)
	for _, card := range append(screen.Query("id:tool-file-card"), screen.Query("id:transcript-image-tile")...) {
		bounds, column := card.Bounds(), screen.Find("id:transcript-column").Bounds()
		if bounds.Size.Width > 65 || bounds.Size.Height > 49 {
			t.Errorf("image thumbnail is too large: %v", bounds)
		}
		if bounds.Origin.X < column.Origin.X || bounds.Origin.X+bounds.Size.Width > column.Origin.X+column.Size.Width+1 {
			t.Errorf("image thumbnail %v overflows reading column %v", bounds, column)
		}
	}
	if nsgotest.Target() != "" {
		shot(screen, "tool-files/compact-narrow-dark")
	}
	for _, tile := range []string{"id:transcript-image-tile", "id:tool-file-card"} {
		screen.Press(tile)
		screen.WaitFor("id:attach-image-picture", 5*time.Second)
		screen.WaitFor("id:attach-image-copy", 5*time.Second)
		screen.WaitFor("id:attach-image-save", 5*time.Second)
		if len(screen.Query("id:pane-tab-transcript-image")) != 0 || len(screen.Query("id:file-preview")) != 0 {
			t.Fatal("an image thumbnail opened a split preview instead of the dialog")
		}
		if tile == "id:tool-file-card" {
			if nsgotest.Target() != "" {
				shot(screen, "tool-files/image-dialog")
			}
			screen.Press("id:attach-image-copy")
			screen.WaitFor("text:已复制图片", 5*time.Second)
			if nsgotest.Target() == "" {
				if !bytes.Equal(screen.ClipboardImage, assets.LogoPNG) {
					t.Fatal("copy did not put the previewed image on the clipboard")
				}
				path := filepath.Join(t.TempDir(), "saved.png")
				screen.SaveFile = func(nsgotest.FileSave) string { return path }
				screen.Press("id:attach-image-save")
				screen.WaitUntil(5*time.Second, func() bool {
					data, err := os.ReadFile(path)
					return err == nil && bytes.Equal(data, assets.LogoPNG)
				})
			}
		}
		screen.Press("text:关闭")
		screen.WaitForGone("id:attach-image-picture", 5*time.Second)
	}
	if got := len(screen.Query("id:tool-output")); got != 0 {
		t.Fatalf("opening images toggled the tool body: %d open bodies", got)
	}
}

func TestToolFilesFollowLiveUpdates(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	onNativeUI(t, screen, a, func() {
		s.turns.Set([]turn{{ID: "tool-files-live", Prompt: "生成图片", Status: chat.Running, Start: a.cx.Now()}})
		s.loaded.Set(true)
		s.readySig.Set(true)
		s.runningSig.Set(true)
	})
	emit := func(ev piEvent) {
		t.Helper()
		a.onPiEvent(s, ev)
		screen.Settle()
	}
	emit(piEvent{Type: "message_start", Message: json.RawMessage(`{"role":"assistant"}`)})
	emit(piEvent{Type: "tool_execution_start", ToolCallID: "create-image", ToolName: "write",
		Args: json.RawMessage(`{"path":"created.png"}`)})
	screen.WaitFor("label:写入 created.png", 5*time.Second)
	if got := len(screen.Query("id:tool-file-card")); got != 0 {
		t.Fatalf("a missing output file produced %d cards", got)
	}
	if err := os.WriteFile(filepath.Join(s.WS, "created.png"), assets.LogoPNG, 0o600); err != nil {
		t.Fatal(err)
	}
	emit(piEvent{Type: "tool_execution_update", ToolCallID: "create-image", ToolName: "write",
		PartialResult: &piToolResult{Content: []piContent{{Type: "image", Data: base64.StdEncoding.EncodeToString(assets.LogoPNG)}}}})
	screen.WaitFor("id:transcript-image-tile", 5*time.Second)
	emit(piEvent{Type: "tool_execution_end", ToolCallID: "create-image", ToolName: "write",
		Result: json.RawMessage(`{"content":[{"type":"text","text":"done"}]}`)})
	screen.WaitFor("id:tool-file-thumbnail", 5*time.Second)
	screen.WaitForGone("id:transcript-image-tile", 5*time.Second)
	if got := len(screen.Query("id:tool-file-card")); got != 1 {
		t.Fatalf("completed output file produced %d cards, want one", got)
	}
	if got := len(screen.Query("id:tool-output")); got != 0 {
		t.Fatalf("completed tool body stayed open: %d", got)
	}
	onNativeUI(t, screen, a, func() {
		s.Target = target{Kind: targetSSH, Host: "preview.invalid"}
		// Target is session metadata; publish a run update as the stream does.
		s.liveTools.Set(append([]toolRun(nil), s.liveTools.GetUntracked()...))
		a.openToolFile(s, "created.png")
	})
	screen.WaitForGone("id:tool-file-card", 5*time.Second)
	screen.WaitFor("id:transcript-image-tile", 5*time.Second)
	if got := len(screen.Query("id:file-preview")); got != 0 {
		t.Fatalf("a remote tool opened %d local previews", got)
	}
}
