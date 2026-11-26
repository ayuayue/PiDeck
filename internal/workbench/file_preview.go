//go:build !js && !android && !ios

package workbench

// Previews: a file the editor should not show as text opens in the right-hand
// split — rendered prose for Markdown, its own page for HTML and PDF,
// the platform's picture and players for images, audio and video, and a
// document's words or cells for .docx and .xlsx. Anything else says what it
// is and offers the system's own application.

import (
	"path/filepath"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// The kinds of preview a file opens in. The names are what a preview state
// holds, not a file format: one kind may cover many extensions.
const (
	previewTable    = "table"
	previewMarkdown = "markdown"
	previewHTML     = "html"
	previewImage    = "image"
	previewPDF      = "pdf"
	previewAudio    = "audio"
	previewVideo    = "video"
	previewDocx     = "docx"
	previewXLSX     = "xlsx"
	previewOffice   = "office"
	previewBinary   = "binary"
)

// previewKinds maps a file's extension to the preview that shows it. A file
// whose extension is not here opens in the editor; one the editor refuses as
// binary can still be opened with the system's application from its error.
var previewKinds = map[string]string{
	".csv": previewTable, ".tsv": previewTable,

	".md": previewMarkdown, ".markdown": previewMarkdown,

	".html": previewHTML, ".htm": previewHTML, ".xhtml": previewHTML,

	".pdf": previewPDF,

	".png": previewImage, ".jpg": previewImage, ".jpeg": previewImage, ".gif": previewImage,
	".webp": previewImage, ".bmp": previewImage, ".ico": previewImage, ".svg": previewImage, ".svgz": previewImage,

	".mp3": previewAudio, ".m4a": previewAudio, ".aac": previewAudio, ".wav": previewAudio,
	".flac": previewAudio, ".ogg": previewAudio, ".oga": previewAudio, ".opus": previewAudio,

	".mp4": previewVideo, ".m4v": previewVideo, ".mov": previewVideo, ".webm": previewVideo,
	".mkv": previewVideo, ".avi": previewVideo, ".wmv": previewVideo,

	".docx": previewDocx, ".xlsx": previewXLSX,

	".doc": previewOffice, ".xls": previewOffice, ".ppt": previewOffice, ".pptx": previewOffice,
	".wps": previewOffice, ".et": previewOffice, ".dps": previewOffice, ".odt": previewOffice,
	".ods": previewOffice, ".odp": previewOffice, ".rtf": previewOffice, ".pages": previewOffice,
	".numbers": previewOffice, ".key": previewOffice,

	".zip": previewBinary, ".7z": previewBinary, ".rar": previewBinary, ".tar": previewBinary,
	".gz": previewBinary, ".tgz": previewBinary, ".bz2": previewBinary, ".xz": previewBinary,
	".zst": previewBinary, ".iso": previewBinary, ".dmg": previewBinary, ".pkg": previewBinary,
	".exe": previewBinary, ".msi": previewBinary, ".deb": previewBinary, ".rpm": previewBinary,
	".apk": previewBinary, ".ipa": previewBinary, ".jar": previewBinary, ".class": previewBinary,
	".wasm": previewBinary, ".so": previewBinary, ".dll": previewBinary, ".dylib": previewBinary,
	".o": previewBinary, ".a": previewBinary, ".lib": previewBinary, ".pyc": previewBinary,
	".bin": previewBinary, ".dat": previewBinary, ".db": previewBinary, ".sqlite": previewBinary,
	".sqlite3": previewBinary, ".ttf": previewBinary, ".otf": previewBinary, ".woff": previewBinary,
	".woff2": previewBinary, ".psd": previewBinary, ".ai": previewBinary, ".sketch": previewBinary,
	".fig": previewBinary,
}

// filePreviewKind is the preview a file opens in, "" for the editor.
func filePreviewKind(path string) string {
	return previewKinds[strings.ToLower(filepath.Ext(path))]
}

// filePreview is what a preview shows, and everything it read to show it.
type filePreview struct {
	path, kind, err string
	loading         bool

	// text is a prose preview's body: Markdown as its file wrote it, or the
	// words a document holds.
	text string
	// rows, columns and limited are a table preview's cells.
	rows    [][]string
	columns int
	limited bool
	// size and modified describe the file where the dialog says what it is.
	size     int64
	modified time.Time
}

// editable reports whether the editor may take a preview's file.
func (p *filePreview) editable() bool {
	switch p.kind {
	case previewTable, previewMarkdown, previewHTML:
		return true
	}
	return false
}

// kindLabel says what the preview shows, under the file's name.
func (p *filePreview) kindLabel() string {
	switch p.kind {
	case previewTable:
		return apptext.T("表格预览")
	case previewMarkdown:
		return apptext.T("Markdown 预览")
	case previewHTML:
		return apptext.T("网页预览")
	case previewPDF:
		return apptext.T("PDF 预览")
	case previewImage:
		return apptext.T("图片预览")
	case previewAudio:
		return apptext.T("音频预览")
	case previewVideo:
		return apptext.T("视频预览")
	case previewDocx:
		return apptext.T("Word 文档")
	case previewXLSX:
		return apptext.T("Excel 工作表")
	case previewOffice:
		return apptext.T("Office 文档")
	}
	return apptext.T("文件信息")
}

// openFilePreview shows a file in the preview pane, reading what the kind
// needs off the UI thread.
func (a *app) openFilePreview(path, kind string) {
	a.closePreviewAudio()
	state := &filePreview{path: path, kind: kind, loading: true}
	a.preview.Set(state)
	if kind == previewAudio {
		a.openPreviewAudio(path)
	}
	a.openPane(panePreview)
	go func() {
		next, err := readFilePreview(path, kind)
		next.loading = false
		if err != nil {
			next.err = err.Error()
		}
		a.cx.Post(func() {
			if a.preview.GetUntracked() == state {
				a.preview.Set(&next)
			}
		})
	}()
}

// closeFilePreview closes the preview and whatever it was playing.
func (a *app) closeFilePreview() {
	a.preview.Set(nil)
	a.closePreviewAudio()
}

// editPreviewFile hands a preview's file to the editor.
func (a *app) editPreviewFile(p *filePreview) {
	a.closeFilePreview()
	a.activePane.Set("")
	a.editor.openFile(filepath.Dir(p.path), p.path)
	a.rememberFile(p.path)
}

// previewPane is the preview as a split pane: the file's name and what
// can be done with it above, its content filling the work area.
func (a *app) previewPane() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		p := a.preview.Get()
		if p == nil {
			return core.View{Style: ui.FillRest}
		}
		var body core.Node
		switch {
		case p.loading:
			body = core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
				Children: []core.Node{ui.Spinner{Size: 16, Label: apptext.T("正在读取文件…")}}}
		case p.err != "":
			body = core.View{Style: core.Style{FlexGrow: 1, Padding: core.All(16)},
				Children: []core.Node{ui.Text(p.err, 12, ui.Regular, colors.Danger)}}
		default:
			body = a.previewBody(cx, p)
		}
		var actions []core.Node
		if !p.loading && p.err == "" {
			if p.editable() {
				actions = append(actions, ui.Button{Text: apptext.T("编辑文本"), Variant: ui.ButtonSecondary,
					TestID: "preview-edit-text", OnPress: func() { a.editPreviewFile(p) }})
			}
			actions = append(actions, ui.Button{Text: apptext.T("在系统应用中打开"), Variant: ui.ButtonSecondary,
				TestID: "preview-open-native", OnPress: func() { a.cx.OpenURL(fileURL(p.path), nil) }})
		}
		actions = append(actions, ui.IconButton{Icon: lucide.X, Label: apptext.T("关闭文件"),
			TestID: "file-preview-close", Size: 28, IconSize: 14, OnPress: func() { a.closePane(panePreview) }})
		return core.View{Style: core.Style{Direction: core.Column, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0)},
			Children: []core.Node{
				a.paneHeader(filepath.Base(p.path), p.kindLabel(), actions...),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Padding: core.Symmetric(10, 0)},
					Children: []core.Node{body}},
			}}
	})
}
