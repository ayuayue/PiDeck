//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"example.com/pideck-v2/assets"
	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestToolFileReferences(t *testing.T) {
	args := json.RawMessage(`{"path":"a file.png","files":[{"path":"docs/report.md"},"data.csv"],"command":"cat secret.txt","content":"not-a-file.txt"}`)
	if got, want := toolFileArgs(args), []string{"a file.png", "docs/report.md", "data.csv"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("references = %q, want %q", got, want)
	}
	for _, raw := range []json.RawMessage{[]byte(`{broken`), []byte(`{"command":"read.png"}`), []byte(strings.Repeat(" ", (64<<10)+1))} {
		if got := toolFileArgs(raw); len(got) != 0 {
			t.Errorf("invalid/non-file arguments produced %q", got)
		}
	}
	run := toolRun{Name: "read", Detail: "truncated…", filePaths: []string{"result.png"},
		Output: "[report](docs/report%20one.md)\n`data.csv`\nresult.png"}
	if got, want := toolFileCandidates(run), []string{"result.png", "docs/report one.md", "data.csv"}; !reflect.DeepEqual(got, want) {
		t.Errorf("output references = %q, want %q", got, want)
	}
}

func TestToolFilePreviewBoundsAndContainment(t *testing.T) {
	root := t.TempDir()
	write := func(name string, data []byte) string {
		t.Helper()
		path := filepath.Join(root, name)
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	image := write("image.png", assets.LogoPNG)
	write("report.md", []byte("# Report"))
	write("data.csv", []byte("name,count\na,1"))
	write("main.go", []byte("package main"))
	write("extra.txt", []byte("extra"))
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, assets.LogoPNG, 0o600); err != nil {
		t.Fatal(err)
	}
	paths := []string{outside, "../outside.png", "https://example.invalid/a.png", "file://server/share/a.png", root, "missing.png", image, "image.png", "report.md", "data.csv", "main.go", "extra.txt"}
	files := loadToolFiles(t.Context(), root, paths)
	if len(files) != 4 {
		t.Fatalf("files = %+v, want four valid unique project files", files)
	}
	if files[0].rel != "image.png" || len(files[0].image.Data) == 0 || files[1].rel != "report.md" || files[3].rel != "main.go" {
		t.Errorf("wrong preview order or thumbnail: %+v", files)
	}
	write("broken.png", []byte("not an image"))
	large := write("large.png", nil)
	if err := os.Truncate(large, remotewire.MaxTranscriptImageBytes+1); err != nil {
		t.Fatal(err)
	}
	files = loadToolFiles(t.Context(), root, []string{"broken.png", "large.png"})
	if len(files) != 2 || len(files[0].image.Data) != 0 || len(files[1].image.Data) != 0 {
		t.Errorf("invalid/large images should keep file entries without decoding: %+v", files)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if files := loadToolFiles(ctx, root, []string{"image.png"}); len(files) != 0 {
		t.Error("cancelled read published file previews")
	}
	t.Run("symlink escape", func(t *testing.T) {
		link := filepath.Join(root, "link.png")
		if err := os.Symlink(outside, link); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		if files := loadToolFiles(t.Context(), root, []string{"link.png"}); len(files) != 0 {
			t.Errorf("outside symlink produced previews: %+v", files)
		}
	})
}

func TestToolFilePathsSurviveHistoryAndMerges(t *testing.T) {
	path := strings.Repeat("long-directory/", 12) + "report.md"
	args, err := json.Marshal(map[string]string{"path": path})
	if err != nil {
		t.Fatal(err)
	}
	calls, err := json.Marshal([]piContent{{Type: "toolCall", ID: "file-call", Name: "write", Arguments: args}})
	if err != nil {
		t.Fatal(err)
	}
	turns := turnsFromMessages([]piMessage{{Role: "user", Content: json.RawMessage(`"create a report"`)},
		{Role: "assistant", Content: calls},
		{Role: "toolResult", ToolCallID: "file-call", ToolName: "write", Content: json.RawMessage(`"done"`)}})
	run := turns[0].Steps[0].Tools[0]
	if got := toolFileCandidates(run); len(got) != 1 || got[0] != path {
		t.Fatalf("history lost the complete path: %q", got)
	}
	old := toolRun{filePaths: []string{path}, Images: []remotewire.Image{{Name: "previous"}}}
	next := mergeRun(old, toolRun{filePaths: []string{"data.csv"}, Status: chat.Completed})
	if len(next.filePaths) != 2 || old.filePaths[0] != path || len(next.Images) != 1 {
		t.Errorf("merge lost references or images: %+v", next)
	}
	acp := acpToolRun(acpUpdate{ToolName: "read_file", Locations: []string{path, "data.csv"}}, chat.Running)
	acp = mergeRun(acp, acpToolRun(acpUpdate{ToolName: "read_file", Text: "done"}, chat.Completed))
	if got, want := toolFileCandidates(acp), []string{path, "data.csv"}; !reflect.DeepEqual(got, want) {
		t.Errorf("ACP locations lost after completion: %q, want %q", got, want)
	}
}

func TestToolImagesPreparedForPartialAndFinalResults(t *testing.T) {
	result := piToolResult{Content: []piContent{{Type: "image", Data: base64.StdEncoding.EncodeToString(assets.LogoPNG)}},
		Details: json.RawMessage(`{"files":["report.md"]}`)}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range []piEvent{{Type: "tool_execution_update", PartialResult: &result}, {Type: "tool_execution_end", Result: raw}} {
		prepareToolPreviews(&ev)
		if ev.finishedTool == nil || len(ev.finishedTool.Images) != 1 || len(ev.finishedTool.Images[0].Data) == 0 || !reflect.DeepEqual(ev.finishedTool.filePaths, []string{"report.md"}) {
			t.Errorf("%s did not prepare its attachments: %+v", ev.Type, ev.finishedTool)
		}
	}
}
