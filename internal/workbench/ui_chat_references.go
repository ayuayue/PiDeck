//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base/textview"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) chatReferences(s *session) viewkit.MarkdownBehavior {
	return viewkit.MarkdownBehavior{
		Document: func(markdown string) textview.Document {
			a.filesRev.Get()
			return chatReferenceDocument(markdown, a.workspaceFiles(s.WS))
		},
		Span: func(n textview.Custom) core.Span {
			span := core.Span{Content: n.Text}
			ref, ok := n.Data.(chatReference)
			if n.Name != "pideck-reference" || !ok {
				return span
			}
			span.StyleFunc = func() core.Style {
				colors := ui.ColorsOf(a.cx)
				style := core.Style{Color: colors.Accent(), Cursor: core.CursorPointer, TextDecoration: core.TextDecorationUnderline}
				if !ref.web || ref.code {
					style.FontFamily = viewkit.MonoFont()
					style.Background = ui.Alpha(colors.Accent(), 0.07)
				}
				if ref.code {
					style.FontSize = a.readingFont() * 0.875
				}
				return style
			}
			span.OnPress = func(e core.PressEvent) { a.openChatReference(s, ref, e) }
			return span
		},
	}
}

func (a *app) openChatReference(s *session, ref chatReference, e core.PressEvent) {
	if ref.web {
		u, ok := chatWebURL(ref.target)
		if !ok {
			return
		}
		if e.Modifiers.Control {
			a.cx.OpenURL(u, nil)
			return
		}
		a.openPane(paneBrowser)
		a.navigateBrowser(u)
		return
	}
	if s.Target.remote() || a.sessionOf(s.ID) != s {
		return
	}
	root, target := s.WS, ref.target
	relative := !filepath.IsAbs(target)
	if relative {
		rel, ok := toolFileRelative(root, target)
		if !ok {
			return
		}
		target = filepath.Join(root, rel)
	}
	complete := a.chatFileReferenceResult(s, root, target, ref.line)
	go func() {
		path, err := filepath.EvalSymlinks(target)
		if err == nil && relative {
			base, baseErr := filepath.EvalSymlinks(root)
			if baseErr != nil {
				err = baseErr
			} else if _, ok := toolFileRelative(base, path); !ok {
				err = os.ErrPermission
			}
		}
		if err == nil {
			var info os.FileInfo
			info, err = os.Stat(path)
			if err == nil && !info.Mode().IsRegular() {
				err = os.ErrInvalid
			}
		}
		a.cx.Post(func() { complete(path, err) })
	}()
}

// chatFileReferenceResult applies a resolved reference only while its request
// is still current. Tab and pane selection can change without opening a file.
func (a *app) chatFileReferenceResult(s *session, root, target string, line int) func(string, error) {
	a.editor.navigation++
	navigation := a.editor.navigation
	active, pane := a.editor.active.GetUntracked(), a.activePane.GetUntracked()
	return func(path string, err error) {
		if s.Target.remote() || s.WS != root || a.sessionOf(s.ID) != s || a.activeID.GetUntracked() != s.ID ||
			a.editor.navigation != navigation || a.editor.active.GetUntracked() != active || a.activePane.GetUntracked() != pane {
			return
		}
		if err != nil {
			a.toast(ui.ToastError, apptext.T("无法读取文件"), filepath.Base(target))
			return
		}
		a.openFileAt(root, path, line)
	}
}
