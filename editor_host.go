//go:build !js && !android && !ios

package main

// The built-in file editor: the app's own view of a file, with the text
// held in a signal so the tab can say whether it is saved. Files are read
// and written off the UI thread, and a file too big or not text is
// refused with a reason rather than half-opened.

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/base/editor"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// maxEditorFile is the largest file the editor opens.
const maxEditorFile = 4 << 20

// editorFile is one open file.
type editorFile struct {
	Path string
	Root string
	Name string
	Lang string

	Text    *core.Signal[string]
	Dirty   *core.Signal[bool]
	Loading *core.Signal[bool]
	Err     *core.Signal[string]
	// caret is the cursor's line and column, "3:5", for the status bar.
	caret *core.Signal[string]
	ref   *editor.Ref

	saved string
	mode  os.FileMode
	// crlf says the file used CRLF newlines; the editor works in LF and the
	// file gets its CRLF back on save, so Git does not see the whole file
	// change.
	crlf bool
}

// editorHost is the open files and which one shows.
type editorHost struct {
	cx     *core.Scope
	open   *core.Signal[bool]
	files  *core.Signal[[]*editorFile]
	active *core.Signal[string]

	// onResult reports a save or a failed read to the app's toasts.
	onResult func(title string, err error)
}

func newEditorHost(cx *core.Scope) *editorHost {
	return &editorHost{
		cx:     cx,
		open:   core.NewSignal(cx, false),
		files:  core.NewSignalFunc(cx, []*editorFile(nil), nil),
		active: core.NewSignal(cx, ""),
	}
}

// activeFile is the file on screen, nil when none.
func (h *editorHost) activeFile() *editorFile {
	path := h.active.GetUntracked()
	for _, f := range h.files.GetUntracked() {
		if f.Path == path {
			return f
		}
	}
	return nil
}

// openFile shows a file, reading it the first time it opens.
func (h *editorHost) openFile(root, path string) {
	if path == "" {
		return
	}
	path = filepath.Clean(path)
	for _, f := range h.files.GetUntracked() {
		if f.Path == path {
			h.open.Set(true)
			h.active.Set(path)
			return
		}
	}
	f := &editorFile{
		Path:    path,
		Root:    root,
		Name:    filepath.Base(path),
		Lang:    editorLanguage(path),
		Text:    core.NewSignal(h.cx, ""),
		Dirty:   core.NewSignal(h.cx, false),
		Loading: core.NewSignal(h.cx, true),
		Err:     core.NewSignal(h.cx, ""),
		caret:   core.NewSignal(h.cx, "1:1"),
		ref:     &editor.Ref{},
	}
	h.files.Update(func(list []*editorFile) []*editorFile { return append(list, f) })
	h.open.Set(true)
	h.active.Set(path)
	h.load(f)
}

// load reads a file from disk, or says why it cannot.
func (h *editorHost) load(f *editorFile) {
	f.Loading.Set(true)
	f.Err.Set("")
	path := f.Path
	go func() {
		info, err := os.Stat(path)
		if err != nil {
			h.cx.Post(func() { f.Loading.Set(false); f.Err.Set("读不到文件：" + err.Error()) })
			return
		}
		if info.IsDir() {
			h.cx.Post(func() { f.Loading.Set(false); f.Err.Set("这是一个文件夹") })
			return
		}
		if info.Size() > maxEditorFile {
			h.cx.Post(func() {
				f.Loading.Set(false)
				f.Err.Set("文件太大（超过 4 MB），没有在编辑器里打开")
			})
			return
		}
		data, err := os.ReadFile(path)
		if err != nil {
			h.cx.Post(func() { f.Loading.Set(false); f.Err.Set("读不到文件：" + err.Error()) })
			return
		}
		if bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 {
			h.cx.Post(func() { f.Loading.Set(false); f.Err.Set("这是二进制文件，不能用文本编辑器打开") })
			return
		}
		text := string(data)
		// Only a file whose newlines are all CRLF keeps CRLF; a mixed file
		// is left as LF rather than rewritten line by line.
		crlf := strings.Count(text, "\r\n") > 0 &&
			strings.Count(text, "\r\n") == strings.Count(text, "\n")
		if crlf {
			text = strings.ReplaceAll(text, "\r\n", "\n")
		}
		mode := info.Mode()
		h.cx.Post(func() {
			f.saved = text
			f.mode = mode
			f.crlf = crlf
			f.Text.Set(text)
			f.Dirty.Set(false)
			f.Loading.Set(false)
			f.Err.Set("")
		})
	}()
}

// save writes a file back, keeping its permissions.
func (h *editorHost) save(f *editorFile) {
	if f == nil || f.Loading.GetUntracked() || f.Err.GetUntracked() != "" {
		return
	}
	text := f.Text.GetUntracked()
	path, mode := f.Path, f.mode
	if mode == 0 {
		mode = 0o644
	}
	crlf := f.crlf
	go func() {
		out := text
		if crlf {
			out = strings.ReplaceAll(out, "\n", "\r\n")
		}
		err := os.WriteFile(path, []byte(out), mode)
		h.cx.Post(func() {
			if err != nil {
				if h.onResult != nil {
					h.onResult("保存失败："+f.Name, err)
				}
				return
			}
			f.saved = text
			f.Dirty.Set(f.Text.GetUntracked() != text)
			if h.onResult != nil {
				h.onResult("已保存 "+f.Name, nil)
			}
		})
	}()
}

// close removes a file from the strip and picks the next one.
func (h *editorHost) close(path string) {
	list := h.files.GetUntracked()
	idx := -1
	for i, f := range list {
		if f.Path == path {
			idx = i
			break
		}
	}
	if idx < 0 {
		return
	}
	list = append(list[:idx], list[idx+1:]...)
	h.files.Set(list)
	if len(list) == 0 {
		h.open.Set(false)
		h.active.Set("")
		return
	}
	if h.active.GetUntracked() == path {
		next := list[min(idx, len(list)-1)]
		h.active.Set(next.Path)
	}
}

// closeAll forgets every file.
func (h *editorHost) closeAll() {
	h.files.Set(nil)
	h.open.Set(false)
	h.active.Set("")
}

// anyDirty reports whether any open file has unsaved text.
func (h *editorHost) anyDirty() bool {
	for _, f := range h.files.GetUntracked() {
		if f.Dirty.GetUntracked() {
			return true
		}
	}
	return false
}

// editorOpen reports whether the editor is the middle pane.
func (a *app) editorOpen() bool {
	return a.editor != nil && a.editor.open.GetUntracked()
}

// openEditorFile shows a file in the middle of the window. Only local
// files are editable: a remote project's tree is read over there, and
// writing it through the editor would need a remote file channel.
func (a *app) openEditorFile(root, path string) {
	if a.editor == nil || path == "" {
		return
	}
	if s := a.active(); s != nil && s.Target.remote() {
		a.toast(ui.ToastInfo, "远程文件暂不支持编辑", "现在只编辑本机项目里的文件。")
		return
	}
	if root == "" {
		root = a.files.root.GetUntracked()
	}
	a.editor.openFile(root, path)
	a.rememberFile(path)
}

// rememberFile keeps the editor's recent files, newest first.
func (a *app) rememberFile(path string) {
	if path == "" {
		return
	}
	path = filepath.Clean(path)
	next := pushRecent(a.cfg.RecentFiles, path, recentFileMax)
	a.cfg.RecentFiles = next
	if a.st != nil {
		a.st.edit(func(c *config) { c.RecentFiles = append([]string(nil), next...) })
	}
}

// openFileAt shows a file and puts the caret on a line, once its text is
// in: the editor's ref is not ready before the load lands.
func (a *app) openFileAt(root, path string, line int) {
	a.openEditorFile(root, path)
	f := a.editor.activeFile()
	if f == nil || line < 1 {
		return
	}
	a.jumpWhenLoaded(f, line, 60)
}

// jumpWhenLoaded retries a jump for a while, so a large file has time to
// load.
func (a *app) jumpWhenLoaded(f *editorFile, line, tries int) {
	a.cx.AfterFunc(50*time.Millisecond, func() {
		if f.Loading.GetUntracked() {
			if tries > 0 {
				a.jumpWhenLoaded(f, line, tries-1)
			}
			return
		}
		if f.ref == nil || f.Err.GetUntracked() != "" {
			return
		}
		at := line - 1
		f.ref.SetSelections([]editor.Selection{{Anchor: editor.Position{Line: at}, Head: editor.Position{Line: at}}})
		f.ref.ScrollToLine(at)
		f.ref.Focus()
	})
}

// saveActiveFile writes the file on screen.
func (a *app) saveActiveFile() {
	if a.editor == nil {
		return
	}
	a.editor.save(a.editor.activeFile())
}

// reloadActiveFile reads the file on screen again, asking first when the
// editor's copy is unsaved.
func (a *app) reloadActiveFile() {
	if a.editor == nil {
		return
	}
	f := a.editor.activeFile()
	if f == nil {
		return
	}
	if f.Dirty.GetUntracked() {
		a.askConfirm("重新读取文件", f.Name+" 有未保存的修改，重新读取会丢掉它们。", "重新读取", func() { a.editor.load(f) })
		return
	}
	a.editor.load(f)
}

// renamePath follows a file or folder renamed on disk: open tabs, their
// names and languages, and the active tab.
func (h *editorHost) renamePath(old, next string) {
	if h == nil || old == "" || old == next {
		return
	}
	sep := string(filepath.Separator)
	move := func(p string) string {
		if p == old {
			return next
		}
		if strings.HasPrefix(p, old+sep) {
			return next + p[len(old):]
		}
		return p
	}
	for _, f := range h.files.GetUntracked() {
		updated := move(f.Path)
		if updated == f.Path {
			continue
		}
		f.Path = updated
		f.Name = filepath.Base(updated)
		f.Lang = editorLanguage(updated)
	}
	if active := h.active.GetUntracked(); active != "" {
		h.active.Set(move(active))
	}
}

// closeEditorFile closes one file, asking when it is unsaved.
func (a *app) closeEditorFile(f *editorFile) {
	if f == nil || a.editor == nil {
		return
	}
	if f.Dirty.GetUntracked() {
		a.askConfirm("关闭文件", f.Name+" 有未保存的修改。", "放弃修改", func() { a.editor.close(f.Path) })
		return
	}
	a.editor.close(f.Path)
}

// closeEditorPane goes back to the chat, asking when anything is unsaved.
func (a *app) closeEditorPane() {
	if a.editor == nil {
		return
	}
	if a.editor.anyDirty() {
		a.askConfirm("关闭编辑器", "有文件还没保存。", "放弃修改并关闭", func() { a.editor.closeAll() })
		return
	}
	a.editor.closeAll()
}

// editorLanguage names a file's language for the editor's highlighter.
func editorLanguage(path string) string {
	base := strings.ToLower(filepath.Base(path))
	switch base {
	case "dockerfile", "containerfile":
		return "dockerfile"
	case "makefile":
		return "makefile"
	}
	switch strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".") {
	case "ts":
		return "typescript"
	case "tsx":
		return "tsx"
	case "js", "mjs", "cjs":
		return "javascript"
	case "jsx":
		return "jsx"
	case "md", "markdown":
		return "markdown"
	case "py":
		return "python"
	case "rs":
		return "rust"
	case "sh", "bash", "zsh":
		return "bash"
	case "yml", "yaml":
		return "yaml"
	case "toml":
		return "toml"
	case "html", "htm":
		return "html"
	case "css":
		return "css"
	case "scss":
		return "scss"
	case "sql":
		return "sql"
	case "c", "h":
		return "c"
	case "cpp", "cc", "cxx", "hpp", "hxx":
		return "cpp"
	case "java":
		return "java"
	case "kt", "kts":
		return "kotlin"
	case "swift":
		return "swift"
	case "xml":
		return "xml"
	case "ini":
		return "ini"
	case "vue":
		return "vue"
	case "svelte":
		return "svelte"
	case "go":
		return "go"
	case "json":
		return "json"
	}
	return strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
}

// openGotoLine asks for a line number.
func (a *app) openGotoLine() {
	if a.editor == nil || a.editor.activeFile() == nil {
		return
	}
	a.gotoLine.Set("")
	a.gotoOpen.Set(true)
}

// jumpToLine puts the caret on the line typed.
func (a *app) jumpToLine() {
	f := a.editor.activeFile()
	if f == nil || f.ref == nil {
		return
	}
	n, err := strconv.Atoi(strings.TrimSpace(a.gotoLine.GetUntracked()))
	if err != nil || n < 1 {
		a.toast(ui.ToastWarning, "行号不对", "填一个从 1 开始的行号。")
		return
	}
	line := n - 1
	f.ref.SetSelections([]editor.Selection{{Anchor: editor.Position{Line: line}, Head: editor.Position{Line: line}}})
	f.ref.ScrollToLine(line)
	f.ref.Focus()
	a.gotoOpen.Set(false)
}

// toggleEditorWrap flips soft wrapping in the editor.
func (a *app) toggleEditorWrap() {
	on := !a.editorWrap.GetUntracked()
	a.editorWrap.Set(on)
	a.cfg.EditorWrap = on
	if a.st != nil {
		a.st.edit(func(c *config) { c.EditorWrap = on })
	}
}

// saveAllFiles writes every dirty file, skipping ones still loading.
func (a *app) saveAllFiles() {
	if a.editor == nil {
		return
	}
	saved := 0
	for _, f := range a.editor.files.GetUntracked() {
		if f == nil || f.Loading.GetUntracked() || f.Err.GetUntracked() != "" || !f.Dirty.GetUntracked() {
			continue
		}
		a.editor.save(f)
		saved++
	}
	if saved == 0 {
		a.toast(ui.ToastInfo, "没有要保存的文件", "所有打开的文件都已保存。")
	}
}
