//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

type exportFormat string

const (
	exportHTMLFile     exportFormat = ".html"
	exportMarkdownFile exportFormat = ".md"
	exportClipboard    exportFormat = ""
)

// Capture a transcript on the UI thread without keeping its mutable slices.
func (a *app) runSessionExport(s *session, format exportFormat, original bool) {
	if s == nil {
		a.toast(ui.ToastError, "导出失败", "找不到这个会话")
		return
	}
	if original && format == exportHTMLFile && s.backend != "acp" {
		a.exportPiHTML(s)
		return
	}
	if format != exportClipboard && a.st == nil {
		return
	}
	d := exportData{Title: s.title.GetUntracked(), Project: s.WS, Model: s.model.GetUntracked().label(),
		Usage: s.usage.GetUntracked(), When: a.cx.Now()}
	readPath := s.File
	if s.loaded.GetUntracked() || s.backend == "acp" {
		readPath = ""
	}
	d.Turns = cloneTranscriptTurns(s.turns.GetUntracked())
	go a.completeSessionExport(readPath, d, format, original)
}

// Image bytes and filenames are immutable; the UI replaces their owners.
func cloneTranscriptTurns(turns []turn) []turn {
	copy := slices.Clone(turns)
	for i := range copy {
		copy[i].Steps = slices.Clone(copy[i].Steps)
		for j := range copy[i].Steps {
			copy[i].Steps[j].Tools = slices.Clone(copy[i].Steps[j].Tools)
		}
	}
	return copy
}

func (a *app) completeSessionExport(readPath string, d exportData, format exportFormat, original bool) {
	if readPath != "" {
		msgs, err := sessionFileMessages(readPath)
		if err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "导出失败", "无法读取会话文件") })
			return
		}
		d.Turns = append(turnsFromMessages(msgs), d.Turns...)
	}
	name := "session-share"
	if original {
		name = sanitizeFileName(d.Title)
	} else {
		d = shareExport(d, a.shareExportSecrets())
		if len(d.Turns) == 0 {
			a.cx.Post(func() { a.toast(ui.ToastInfo, "没有可分享的文字", "分享副本只包含提问和回答。") })
			return
		}
	}
	if format == exportClipboard {
		out := renderSessionMarkdown(d)
		a.cx.Post(func() {
			a.cx.SetClipboard(out)
			if original {
				a.toast(ui.ToastSuccess, "已复制", "")
			} else {
				a.toast(ui.ToastSuccess, "已复制分享副本", "")
			}
		})
		return
	}
	var out, message string
	if format == exportHTMLFile {
		out, message = renderSessionHTML(d), "已导出会话"
	} else {
		out, message = renderSessionMarkdown(d), "已导出 Markdown"
	}
	if !original {
		message = "已导出分享副本"
	}
	dir := filepath.Join(a.st.dir, "exports")
	path, err := writeSessionExport(dir, name+"-"+time.Now().Format("20060102-150405"), string(format), out)
	if err != nil {
		a.cx.Post(func() { a.toast(ui.ToastError, "导出失败", "无法写入导出目录") })
		return
	}
	a.cx.Post(func() { a.sessionExported(message, path) })
}

// The temporary name also gives each export a unique suffix, even when
// several copies are made in the same second.
func writeSessionExport(dir, name, extension, content string) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, "."+name+"-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	_, writeErr := tmp.WriteString(content)
	if err := errors.Join(writeErr, tmp.Close()); err != nil {
		return "", err
	}
	path := filepath.Join(dir, strings.TrimPrefix(filepath.Base(tmp.Name()), ".")+extension)
	return path, os.Rename(tmp.Name(), path)
}

// The original pi export keeps pi's own document, including its attachments.
func (a *app) exportPiHTML(s *session) {
	a.ensureEngine(s, func() {
		c := s.engine
		go func() {
			var res struct {
				Path string `json:"path"`
			}
			err := c.call(map[string]any{"type": "export_html"}, &res, 60*time.Second)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "导出失败", err.Error())
					return
				}
				a.sessionExported("已导出会话", res.Path)
			})
		}()
	})
}

func (a *app) sessionExported(message, path string) {
	a.toastAction(ui.ToastSuccess, message, path, "打开", func() { a.cx.OpenURL(fileURL(path), nil) })
}

// fileURL makes a file path an openable URL.
func fileURL(path string) string {
	p := filepath.ToSlash(path)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return (&url.URL{Scheme: "file", Path: p}).String()
}
