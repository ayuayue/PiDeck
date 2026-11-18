//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"os"
	"path/filepath"
	"strings"

	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// pasteImage reads an image from the clipboard.
func (a *app) pasteImage(s *session) {
	a.cx.ReadClipboardImage(func(img core.ClipboardImage, ok bool, err error) {
		if err != nil {
			a.toast(ui.ToastError, "读取剪贴板失败", err.Error())
			return
		}
		if !ok {
			a.toast(ui.ToastInfo, "剪贴板里没有图片", "先复制一张图片，或者把文件拖进输入框。")
			return
		}
		a.addImage(s, remotewire.Image{Data: img.PNG, MimeType: "image/png", Name: "粘贴的图片"})
	})
}

// dropFiles attaches dropped images and mentions other files.
func (a *app) dropFiles(s *session, uris []string) {
	for _, uri := range uris {
		path := uri
		if strings.HasPrefix(uri, "file:") {
			path = strings.TrimPrefix(uri, "file://")
			path = strings.TrimPrefix(path, "file:")
			path = strings.ReplaceAll(path, "%20", " ")
			if len(path) > 2 && path[0] == '/' && path[2] == ':' {
				path = path[1:]
			}
		}
		data, err := os.ReadFile(path)
		if err != nil {
			a.toast(ui.ToastError, "无法读取文件", filepath.Base(path))
			continue
		}
		if isImage(path) {
			a.addImage(s, remotewire.Image{Data: data, MimeType: imageMime(path), Name: filepath.Base(path)})
			continue
		}
		rel := path
		if s.WS != "" {
			if r, err := filepath.Rel(s.WS, path); err == nil {
				rel = r
			}
		}
		draft := s.draft.GetUntracked()
		if strings.TrimSpace(draft) != "" && !strings.HasSuffix(draft, " ") {
			draft += " "
		}
		s.draft.Set(draft + "@" + filepath.ToSlash(rel) + " ")
	}
}

// isImage reports whether a path names an image pi can take.
func isImage(path string) bool {
	return imageMime(path) != ""
}

// imageMime is a path's image type, empty when it is not one.
func imageMime(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	}
	return ""
}
