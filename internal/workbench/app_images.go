//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

const maxDroppedImageBytes = 6 << 20

var errDroppedImageTooLarge = errors.New("dropped image exceeds 6 MB")

func (s *session) filesLoading() bool {
	return s != nil && s.dropPending != nil && s.dropPending.Get() > 0
}

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
	if s == nil || len(uris) == 0 {
		return
	}
	inputs := append([]string(nil), uris...)
	previous := s.dropTail
	done := make(chan struct{})
	s.dropTail = done
	s.dropPending.Set(s.dropPending.GetUntracked() + 1)
	ctx := a.cx.Context()
	go func() {
		defer close(done)
		if previous != nil {
			select {
			case <-previous:
			case <-ctx.Done():
				return
			}
		}
		files := make([]droppedFile, 0, len(inputs))
		for _, input := range inputs {
			if ctx.Err() != nil {
				return
			}
			files = append(files, readDroppedFile(input))
		}
		a.cx.Post(func() {
			defer s.dropPending.Set(s.dropPending.GetUntracked() - 1)
			if a.sessionOf(s.ID) != s {
				return
			}
			for _, file := range files {
				if file.err != nil {
					detail := ""
					if file.path != "" {
						detail = filepath.Base(file.path)
					}
					if errors.Is(file.err, errDroppedImageTooLarge) {
						detail = "图片太大，上限 6 MB"
					}
					a.toast(ui.ToastError, "无法读取文件", detail)
					continue
				}
				if file.image.MimeType != "" {
					a.addImage(s, file.image)
					continue
				}
				rel := file.path
				if s.WS != "" {
					if r, err := filepath.Rel(s.WS, file.path); err == nil {
						rel = r
					}
				}
				draft := s.draft.GetUntracked()
				if strings.TrimSpace(draft) != "" && !strings.HasSuffix(draft, " ") {
					draft += " "
				}
				s.draft.Set(draft + "@" + filepath.ToSlash(rel) + " ")
			}
		})
	}()
}

type droppedFile struct {
	path  string
	image remotewire.Image
	err   error
}

// readDroppedFile only reads bytes for images; other regular files and
// directories become references regardless of their size.
func readDroppedFile(input string) droppedFile {
	path, err := droppedFilePath(input)
	file := droppedFile{path: path, err: err}
	if err != nil {
		return file
	}
	info, err := os.Stat(path)
	if err != nil {
		file.err = err
		return file
	}
	if info.IsDir() {
		return file
	}
	if !info.Mode().IsRegular() {
		file.err = os.ErrInvalid
		return file
	}
	mime := imageMime(path)
	if mime == "" {
		return file
	}
	if info.Size() > maxDroppedImageBytes {
		file.err = errDroppedImageTooLarge
		return file
	}
	f, err := os.Open(path)
	if err != nil {
		file.err = err
		return file
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxDroppedImageBytes+1))
	if err == nil && len(data) > maxDroppedImageBytes {
		err = errDroppedImageTooLarge
	}
	if err == nil && len(data) == 0 {
		err = io.ErrUnexpectedEOF
	}
	file.err = err
	if err == nil {
		file.image = remotewire.Image{Data: data, MimeType: mime, Name: filepath.Base(path)}
	}
	return file
}

// droppedFilePath decodes file URIs once, while native paths keep literal
// percent signs. Remote file authorities are UNC paths on Windows only.
func droppedFilePath(input string) (string, error) {
	if input == "" || strings.ContainsRune(input, '\x00') {
		return "", os.ErrInvalid
	}
	if !strings.HasPrefix(strings.ToLower(input), "file:") {
		if strings.Contains(input, "://") && filepath.VolumeName(input) == "" {
			return "", os.ErrInvalid
		}
		return input, nil
	}
	u, err := url.Parse(input)
	if err != nil {
		return "", err
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", os.ErrInvalid
	}
	path := u.Path
	if u.Opaque != "" {
		path, err = url.PathUnescape(u.Opaque)
		if err != nil {
			return "", err
		}
	}
	if path == "" || strings.ContainsRune(path, '\x00') {
		return "", os.ErrInvalid
	}
	if u.Host != "" && !strings.EqualFold(u.Host, "localhost") {
		if runtime.GOOS != "windows" {
			return "", os.ErrInvalid
		}
		path = "//" + u.Host + path
	} else if runtime.GOOS == "windows" && len(path) > 2 && path[0] == '/' && path[2] == ':' {
		path = path[1:]
	}
	return filepath.FromSlash(path), nil
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
