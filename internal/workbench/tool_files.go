//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/ui"
)

const toolFileCandidateLimit = 12

var toolFileLink = regexp.MustCompile(`\]\(([^)\r\n]+)\)`)

// File references are a transient projection of tool arguments/results. They
// never become another session file format or a reason to read remote paths.
func toolFileArgs(raw json.RawMessage) []string {
	if len(raw) == 0 || len(raw) > 64<<10 {
		return nil
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	var paths []string
	var visit func(any, int)
	visit = func(value any, depth int) {
		if depth > 3 || len(paths) >= toolFileCandidateLimit {
			return
		}
		switch value := value.(type) {
		case string:
			paths = appendToolFilePaths(paths, value)
		case []any:
			for _, item := range value {
				visit(item, depth+1)
			}
		case map[string]any:
			for _, key := range []string{"path", "file_path", "filePath", "file", "output_path", "image_path", "paths", "files", "images", "attachments", "output_files"} {
				if item, ok := value[key]; ok {
					visit(item, depth+1)
				}
			}
		}
	}
	visit(value, 0)
	return paths
}

func appendToolFilePaths(paths []string, more ...string) []string {
	for _, path := range more {
		path = strings.TrimSpace(path)
		if path == "" || len(path) > 4096 || strings.ContainsAny(path, "\x00\r\n") || len(paths) >= toolFileCandidateLimit {
			continue
		}
		duplicate := false
		for _, old := range paths {
			if pathKey(old) == pathKey(path) {
				duplicate = true
				break
			}
		}
		if !duplicate {
			paths = append(paths, path)
		}
	}
	return paths
}

func toolFileCandidates(run toolRun) []string {
	paths := appendToolFilePaths(nil, run.filePaths...)
	// Older in-memory projections may only have the short target. Never use
	// a truncated label as a file name.
	if (run.Name == "read" || run.Name == "write" || run.Name == "edit") && !strings.HasSuffix(run.Detail, "…") {
		paths = appendToolFilePaths(paths, run.Detail)
	}
	out := run.Output[:min(len(run.Output), 24_000)]
	paths = appendToolFilePaths(paths, toolFileArgs(json.RawMessage(out))...)
	for _, link := range toolFileLink.FindAllStringSubmatch(out, toolFileCandidateLimit) {
		path := strings.Trim(link[1], "<>")
		if decoded, err := url.PathUnescape(path); err == nil {
			paths = appendToolFilePaths(paths, decoded)
		}
	}
	for _, line := range strings.Split(out, "\n") {
		if toolFileLink.MatchString(line) {
			continue
		}
		path := strings.Trim(strings.TrimSpace(line), "`\"'<>")
		if filepath.Ext(path) != "" {
			paths = appendToolFilePaths(paths, path)
		}
	}
	return paths
}

// prepareToolPreviews runs on the RPC reader, before publishing an event;
// decoding returned image bytes must not block the UI goroutine.
func prepareToolPreviews(ev *piEvent) {
	var result *piToolResult
	switch ev.Type {
	case "tool_execution_update":
		result = ev.PartialResult
	case "tool_execution_end":
		var decoded piToolResult
		if json.Unmarshal(ev.Result, &decoded) == nil {
			result = &decoded
		}
	}
	if result != nil {
		ev.finishedTool = &toolRun{Images: piBlockImages(result.Content), filePaths: toolFileArgs(result.Details)}
	}
}

type toolFilePreview struct {
	rel   string
	size  int64
	image remotewire.Image
}

func toolFileRelative(root, path string) (string, bool) {
	if root == "" || path == "" || strings.ContainsAny(path, "\x00\r\n") || len(path) > 4096 {
		return "", false
	}
	if strings.HasPrefix(strings.ToLower(path), "file:") {
		var err error
		path, err = droppedFilePath(path)
		if err != nil {
			return "", false
		}
	}
	if strings.Contains(path, "://") || strings.HasPrefix(path, `\\`) || strings.HasPrefix(path, "//") {
		return "", false
	}
	if filepath.IsAbs(path) {
		var err error
		path, err = filepath.Rel(root, path)
		if err != nil {
			return "", false
		}
	}
	path = filepath.Clean(path)
	return path, filepath.IsLocal(path)
}

func loadToolFiles(ctx context.Context, root string, paths []string) []toolFilePreview {
	dir, err := os.OpenRoot(root)
	if err != nil {
		return nil
	}
	defer dir.Close()
	var files []toolFilePreview
	seen := map[string]bool{}
	for _, path := range paths[:min(len(paths), toolFileCandidateLimit)] {
		if ctx.Err() != nil || len(files) >= transcriptImagesPerMessage {
			break
		}
		rel, ok := toolFileRelative(root, path)
		if !ok || seen[pathKey(rel)] {
			continue
		}
		seen[pathKey(rel)] = true
		info, err := dir.Stat(rel)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		file := toolFilePreview{rel: rel, size: info.Size()}
		if filePreviewKind(rel) == previewImage && info.Size() <= remotewire.MaxTranscriptImageBytes {
			// Root.Open enforces containment at the read itself, including
			// symlinks; a tool's output cannot make the transcript read outside.
			f, err := dir.Open(rel)
			if err == nil {
				data, readErr := io.ReadAll(io.LimitReader(f, remotewire.MaxTranscriptImageBytes+1))
				f.Close()
				if readErr == nil {
					file.image, _ = transcriptImage(data)
				}
			}
		}
		files = append(files, file)
	}
	return files
}

func (a *app) openToolFile(s *session, rel string) {
	if s.Target.remote() || s.WS == "" {
		return
	}
	root := s.WS
	go func() {
		// Re-resolve on press: files can disappear or become links after a
		// thumbnail was loaded. Hand the existing viewer a canonical path.
		base, err := filepath.EvalSymlinks(root)
		path := ""
		if err == nil {
			path, err = filepath.EvalSymlinks(filepath.Join(base, rel))
		}
		if err == nil {
			if _, ok := toolFileRelative(base, path); !ok {
				err = os.ErrPermission
			}
		}
		a.cx.Post(func() {
			if s.WS != root || s.Target.remote() || a.sessionOf(s.ID) != s {
				return
			}
			if err != nil {
				a.toast(ui.ToastError, "无法读取文件", filepath.Base(rel))
				return
			}
			a.openEditorFile(base, path)
		})
	}()
}
