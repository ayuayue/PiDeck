//go:build !js && !android && !ios

package workbench

// The built-in file editor: the app's own view of a file, with the text
// held in a signal so the tab can say whether it is saved. Files are read
// and written off the UI thread, and a file too big or not text is
// refused with a reason rather than half-opened.

import (
	"context"
	"errors"
	"path"
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
	Key  string
	Path string
	Root string
	Name string
	Lang string
	file workspaceFile
	busy *core.Signal[bool]

	Text    *core.Signal[string]
	Dirty   *core.Signal[bool]
	Loading *core.Signal[bool]
	Err     *core.Signal[string]
	// caret is the cursor's line and column, "3:5", for the status bar.
	caret *core.Signal[string]
	ref   *editor.Ref

	saved    string
	revision string
	// loadID identifies the latest read; it only changes on the UI thread.
	loadID uint64
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

	// navigation invalidates unresolved file references when a newer file
	// request opens or closes the file area. It only changes on the UI thread.
	navigation uint64

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
	// View computations must follow tab changes as well as file contents.
	path := h.active.Get()
	for _, f := range h.files.Get() {
		if f.Key == path {
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
	if root == "" {
		root = filepath.Dir(path)
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return
	}
	h.openWorkspaceFile(path, workspaceFile{root: root, rel: filepath.ToSlash(rel)})
}

func (h *editorHost) openWorkspaceFile(display string, file workspaceFile) {
	h.navigation++
	key := display
	if file.target.remote() {
		key = file.target.key() + "|" + display
	}
	for _, f := range h.files.GetUntracked() {
		if f.Key == key {
			h.open.Set(true)
			h.active.Set(key)
			return
		}
	}
	f := &editorFile{
		Key:     key,
		Path:    display,
		Root:    file.root,
		Name:    path.Base(file.rel),
		Lang:    editorLanguage(display),
		file:    file,
		busy:    core.NewSignal(h.cx, false),
		Text:    core.NewSignal(h.cx, ""),
		Dirty:   core.NewSignal(h.cx, false),
		Loading: core.NewSignal(h.cx, true),
		Err:     core.NewSignal(h.cx, ""),
		caret:   core.NewSignal(h.cx, "1:1"),
		ref:     &editor.Ref{},
	}
	h.files.Update(func(list []*editorFile) []*editorFile { return append(list, f) })
	h.open.Set(true)
	h.active.Set(key)
	h.load(f)
}

// load reads a file from disk, or says why it cannot.
func (h *editorHost) load(f *editorFile) {
	if f.busy.GetUntracked() {
		return
	}
	f.loadID++
	loadID := f.loadID
	f.Loading.Set(true)
	f.Err.Set("")
	file := f.file
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		data, err := file.read(ctx, maxEditorFile)
		if err != nil {
			h.cx.Post(func() {
				if f.loadID != loadID {
					return
				}
				f.Loading.Set(false)
				f.Err.Set(fileEditorError(err))
			})
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
		revision := workspaceRevision(data)
		h.cx.Post(func() {
			if f.loadID != loadID {
				return
			}
			f.saved = text
			f.revision = revision
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
	if f == nil || f.Loading.GetUntracked() || f.busy.GetUntracked() || f.Err.GetUntracked() != "" {
		return
	}
	text := f.Text.GetUntracked()
	file, expected := f.file, f.revision
	crlf := f.crlf
	f.busy.Set(true)
	go func() {
		out := text
		if crlf {
			out = strings.ReplaceAll(out, "\n", "\r\n")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		revision, err := file.save(ctx, expected, []byte(out), maxEditorFile)
		h.cx.Post(func() {
			f.busy.Set(false)
			if err != nil {
				if h.onResult != nil {
					h.onResult("保存失败："+f.Name, errors.New(fileEditorError(err)))
				}
				return
			}
			f.saved = text
			f.revision = revision
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
		if f.Key == path {
			idx = i
			break
		}
	}
	if idx < 0 {
		return
	}
	h.navigation++
	list = append(list[:idx], list[idx+1:]...)
	h.files.Set(list)
	if len(list) == 0 {
		h.open.Set(false)
		h.active.Set("")
		return
	}
	if h.active.GetUntracked() == path {
		next := list[min(idx, len(list)-1)]
		h.active.Set(next.Key)
	}
}

// closeAll forgets every file.
func (h *editorHost) closeAll() {
	h.navigation++
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

// openEditorFile shows a local file, using its preview when available.
func (a *app) openEditorFile(root, path string) {
	a.openFileAt(root, path, 0)
}

// openFileAt shows a local file and, when a line is requested, opens editable
// text in the editor so the caret can land on that line after it loads.
func (a *app) openFileAt(root, path string, line int) {
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
	if kind := filePreviewKind(path); kind != "" && (line < 1 || !(&filePreview{kind: kind}).editable()) {
		a.openFilePreview(path, kind)
		return
	}
	a.activePane.Set("")
	a.editor.openFile(root, path)
	a.rememberFile(path)
	f := a.editor.activeFile()
	if f != nil && f.Path == filepath.Clean(path) && line > 0 {
		a.jumpWhenLoaded(f, line, 60)
	}
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
	files := h.files.GetUntracked()
	updated := false
	for _, f := range files {
		if f.file.target.remote() {
			continue
		}
		path := move(f.Path)
		if path == f.Path {
			continue
		}
		updated = true
		f.Path = path
		f.Key = path
		if rel, err := filepath.Rel(f.Root, path); err == nil {
			f.file.rel = filepath.ToSlash(rel)
		}
		f.Name = filepath.Base(path)
		f.Lang = editorLanguage(path)
	}
	if updated {
		h.files.Set(append([]*editorFile(nil), files...))
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
		a.askConfirm("关闭文件", f.Name+" 有未保存的修改。", "放弃修改", func() { a.editor.close(f.Key) })
		return
	}
	a.editor.close(f.Key)
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
