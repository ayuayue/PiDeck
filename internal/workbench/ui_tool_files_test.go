//go:build !js && !android && !ios

package workbench

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"example.com/pideck-v2/assets"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestToolFilesStayVisibleAndOpenPreviews(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	for name, data := range map[string][]byte{
		"result.png": assets.LogoPNG,
		"report.md":  []byte("# 工具生成的报告\n\n这份报告可以直接预览。"),
		"data.csv":   []byte("name,count\npreview,3\n"),
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
	calls := []piContent{}
	for _, name := range []string{"result.png", "report.md", "data.csv"} {
		calls = append(calls, piContent{Type: "toolCall", ID: name, Name: "read", Arguments: marshal(map[string]string{"path": name})})
	}
	calls = append(calls, piContent{Type: "toolCall", ID: "returned-image", Name: "image"})
	messages := []piMessage{{Role: "user", Content: marshal("检查生成的文件")}, {Role: "assistant", Content: marshal(calls)}}
	for _, call := range calls[:3] {
		messages = append(messages, piMessage{Role: "toolResult", ToolCallID: call.ID, ToolName: call.Name,
			Content: marshal([]piContent{{Type: "text", Text: "done"}})})
	}
	messages = append(messages, piMessage{Role: "toolResult", ToolCallID: "returned-image", ToolName: "image",
		Content: marshal([]piContent{{Type: "image", Data: base64.StdEncoding.EncodeToString(assets.LogoPNG)}})})
	onNativeUI(t, screen, a, func() { s.turns.Set(turnsFromMessages(messages)) })
	screen.WaitFor("text:执行过程", 5*time.Second)
	screen.Press("text:执行过程")
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:tool-file-card")) == 3 })
	screen.WaitFor("id:tool-file-thumbnail", 5*time.Second)
	screen.WaitFor("id:transcript-image-tile", 5*time.Second)
	if got := len(screen.Query("id:tool-output")); got != 0 {
		t.Fatalf("completed tool output should stay folded, got %d open bodies", got)
	}
	shot(screen, "tool-files/light")
	onNativeUI(t, screen, a, func() { a.theme.Set("dark"); a.applyTheme() })
	screen.Resize(900, 760)
	for _, card := range screen.Query("id:tool-file-card") {
		bounds, column := card.Bounds(), screen.Find("id:transcript-column").Bounds()
		if bounds.Origin.X < column.Origin.X || bounds.Origin.X+bounds.Size.Width > column.Origin.X+column.Size.Width+1 {
			t.Errorf("file card %v overflows reading column %v", bounds, column)
		}
	}
	shot(screen, "tool-files/narrow-dark")
	screen.Press("id:transcript-image-tile")
	screen.WaitFor("id:transcript-image-picture", 5*time.Second)
	screen.Press("id:pane-tab-close-transcript-image")
	screen.WaitForGone("id:transcript-image-picture", 5*time.Second)
	screen.Press("label:result.png")
	screen.WaitFor("id:image-preview", 5*time.Second)
	screen.Press("id:pane-tab-close-preview")
	screen.WaitForGone("id:file-preview", 5*time.Second)
	screen.Press("label:data.csv")
	screen.WaitFor("id:csv-preview-rows", 5*time.Second)
	screen.WaitFor("text:preview", 5*time.Second)
	shot(screen, "tool-files/table-preview")
	screen.Press("id:pane-tab-close-preview")
	screen.WaitForGone("id:file-preview", 5*time.Second)
	if got := len(screen.Query("id:tool-output")); got != 0 {
		t.Fatalf("opening attachments toggled the tool body: %d open bodies", got)
	}
	screen.Press("label:report.md")
	screen.WaitFor("id:file-preview", 5*time.Second)
	screen.WaitFor("text:这份报告可以直接预览。", 5*time.Second)
	shot(screen, "tool-files/markdown-preview")
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
