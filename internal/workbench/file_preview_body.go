//go:build !js && !android && !ios

package workbench

// What a preview shows inside its dialog, by the kind of file it is: prose,
// a table, a picture, the platform's player or page, or what the file is.

import (
	"path/filepath"
	"regexp"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// previewBody is a preview's content.
func (a *app) previewBody(cx *core.Scope, p *filePreview) core.Node {
	switch p.kind {
	case previewTable, previewXLSX:
		return a.tablePreview(cx, p)
	case previewMarkdown:
		return a.markdownPreview(cx, p)
	case previewHTML:
		return a.pagePreview(cx, p, "html-preview", apptext.T("网页预览"))
	case previewPDF:
		return a.pagePreview(cx, p, "pdf-preview", apptext.T("PDF 预览"))
	case previewImage:
		return a.imagePreview(cx, p)
	case previewAudio:
		return a.audioPreview(cx, p)
	case previewVideo:
		return a.videoPreview(cx, p)
	case previewDocx:
		return a.prosePreview(cx, p)
	}
	return a.fileInfoPreview(cx, p)
}

// previewHeight is how tall a preview's content may be in this window, for
// the parts that need a size of their own.
func previewHeight(cx *core.Scope) core.Points {
	return core.Points(max(220, cx.Env().Window().Height-200))
}

// markdownPreview renders a Markdown file, its pictures resolved against the
// file's own directory.
func (a *app) markdownPreview(cx *core.Scope, p *filePreview) core.Node {
	body := resolvePreviewImages(p.text, filepath.Dir(p.path))
	return core.Scroll{Style: ui.FillRest, Children: []core.Node{
		core.View{Style: core.Style{Padding: core.Symmetric(14, 18), Width: core.Pct(100)}, Children: []core.Node{
			viewkit.MarkdownSized(body, func() bool { return false }, false, 14, 21, core.Style{}),
		}},
	}}
}

// prosePreview shows words a document holds, as selectable text.
func (a *app) prosePreview(cx *core.Scope, p *filePreview) core.Node {
	colors := ui.ColorsOf(cx)
	if strings.TrimSpace(p.text) == "" {
		return ui.Text(apptext.T("这个文档里没有文字。"), 12, ui.Regular, colors.Muted)
	}
	body := []core.Node{
		core.Text{Content: p.text, Selectable: core.SelectableOn,
			Style: core.Style{FontSize: 13, LineHeight: 21}, StyleFunc: ui.Colored(colors.Text)},
	}
	if p.limited {
		body = append(body, ui.Text(apptext.T("文档较长，只显示开头部分。"), 11, ui.Regular, colors.Muted))
	}
	return core.Scroll{Style: ui.FillRest, Children: []core.Node{
		core.View{Style: core.Style{Padding: core.Symmetric(14, 18), Width: core.Pct(100), Gap: 10}, Children: body},
	}}
}

// pagePreview shows a file as its own page: HTML with its scripts and
// styles, a PDF in the web view's own viewer where the platform has one.
func (a *app) pagePreview(cx *core.Scope, p *filePreview, testID, label string) core.Node {
	return core.WebView{Source: core.WebSrc(fileURL(p.path)), Incognito: true, PinchZoom: true,
		TestID: testID, Label: label, Style: ui.FillRest,
		OnError: func(err error) { a.toast(ui.ToastError, "打不开这个页面", err.Error()) }}
}

// imagePreview shows a picture the platform decodes, SVG included.
func (a *app) imagePreview(cx *core.Scope, p *filePreview) core.Node {
	return core.Image{Source: core.ImageSource{URI: fileURL(p.path)}, ResizeMode: core.Contain,
		Label: filepath.Base(p.path), TestID: "image-preview",
		Style:   ui.FillRest,
		OnError: func(err error) { a.toast(ui.ToastError, "打不开这张图片", err.Error()) }}
}

// videoPreview plays a clip in the platform's player.
func (a *app) videoPreview(cx *core.Scope, p *filePreview) core.Node {
	return core.Video{Source: p.path, Controls: true, Paused: true, ResizeMode: core.Contain,
		Label: filepath.Base(p.path), TestID: "video-preview",
		Style:   ui.FillRest,
		OnError: func(err error) { a.toast(ui.ToastError, "无法播放此视频", err.Error()) }}
}

// audioPreview plays an audio file: nothing starts until the user asks, and
// closing the pane stops the player.
func (a *app) audioPreview(cx *core.Scope, p *filePreview) core.Node {
	colors := ui.ColorsOf(cx)
	sound := a.previewAudio
	if sound == nil {
		return ui.Text(apptext.T("这个音频无法播放。"), 12, ui.Regular, colors.Muted)
	}
	return core.View{Style: core.Style{Gap: 14, Padding: core.Symmetric(18, 4)}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12}, Children: []core.Node{
			core.Dynamic(func(*core.Scope) core.Node {
				icon, label := lucide.Play, apptext.T("播放")
				if sound.playing.Get() {
					icon, label = lucide.Pause, apptext.T("暂停")
				}
				return ui.IconButton{Icon: icon, Label: label, Variant: ui.IconButtonPrimary, Size: 42, IconSize: 18,
					TestID: "preview-audio-play", OnPress: sound.toggle}
			}),
			core.Text{Content: filepath.Base(p.path), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 13}, StyleFunc: ui.Colored(colors.Text)},
		}},
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10}, Children: []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
				ui.Slider{Min: 0, MaxFunc: func() float64 { return sound.duration.Get().Seconds() },
					Value:    func() float64 { return sound.position.Get().Seconds() },
					Label:    apptext.T("播放进度"),
					TestID:   "preview-audio-progress",
					Disabled: func() bool { return sound.duration.Get() <= 0 },
					OnChange: sound.seekSeconds},
			}},
			core.Text{ContentFunc: func() string {
				return clockText(sound.position.Get()) + " / " + clockText(sound.duration.Get())
			}, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11, MinWidth: core.Pt(92), TextAlign: core.TextAlignRight},
				StyleFunc: ui.Colored(colors.Muted)},
		}},
		core.Show{When: func() bool { return sound.err.Get() != "" }, Then: func(*core.Scope) core.Node {
			return ui.Text(sound.err.Get(), 12, ui.Regular, colors.Danger)
		}},
	}}
}

// fileInfoPreview says what a file is where the app shows nothing of it.
func (a *app) fileInfoPreview(cx *core.Scope, p *filePreview) core.Node {
	colors := ui.ColorsOf(cx)
	row := func(name, value string) core.Node {
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12}, Children: []core.Node{
			core.Text{Content: name, Style: core.Style{Width: core.Pt(84), FlexShrink: 0, FontSize: 12}, StyleFunc: ui.Colored(colors.Muted)},
			core.Text{Content: value, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
		}}
	}
	hint := apptext.T("这种文件不在应用内预览，可以用系统关联的应用打开。")
	if p.kind == previewOffice {
		hint = apptext.T("Office 文档的版式由系统关联的应用显示。")
	}
	format := strings.TrimPrefix(strings.ToUpper(filepath.Ext(p.path)), ".")
	if format == "" {
		format = apptext.T("无扩展名")
	}
	return core.View{Style: core.Style{Gap: 16, Padding: core.Symmetric(8, 2)}, Children: []core.Node{
		core.Text{Content: hint, MaxLines: 3, Style: core.Style{FontSize: 12.5, LineHeight: 19}, StyleFunc: ui.Colored(colors.Muted)},
		core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
			row(apptext.T("格式"), format),
			row(apptext.T("大小"), viewkit.FileSize(p.size)),
			row(apptext.T("修改时间"), p.modified.Format("2006-01-02 15:04")),
		}},
	}}
}

// tablePreview shows a table's cells in a grid that scrolls both ways.
func (a *app) tablePreview(cx *core.Scope, p *filePreview) core.Node {
	colors := ui.ColorsOf(cx)
	if len(p.rows) == 0 {
		return ui.Text(apptext.T("表格为空"), 12, ui.Regular, colors.Muted)
	}
	const colWidth = 126
	row := func(i int) core.Node {
		values := p.rows[i]
		cells := make([]core.Node, p.columns)
		for col := range cells {
			value := ""
			if col < len(values) {
				value = values[col]
			}
			cells[col] = core.Text{Content: value, MaxLines: 1, EllipsizeMode: core.EllipsizeTail, Selectable: core.SelectableOn,
				Style: core.Style{Width: core.Pt(colWidth), FlexShrink: 0, Padding: core.Symmetric(6, 8), FontSize: 12,
					Borders: core.Edges{Right: 1, Bottom: 1}, BorderColors: core.EdgeColors{Right: colors.Line(), Bottom: colors.Line()}}, StyleFunc: ui.Colored(colors.Text)}
		}
		return core.View{Style: core.Style{Direction: core.Row}, Children: cells}
	}
	height := previewHeight(cx)
	return core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
		core.Scroll{Horizontal: true, Style: core.Style{Height: core.Pt(height)}, Children: []core.Node{
			core.List{Style: core.Style{Width: core.Pt(core.Points(p.columns * colWidth)), Height: core.Pt(height - 16)},
				EstimatedSize: 28, Count: func() int { return len(p.rows) }, TestID: "csv-preview-rows",
				Row: func(cx *core.Scope, item core.ListRow) core.Node { return row(item.Index()) }},
		}},
		core.Show{When: func() bool { return p.limited }, Then: func(cx *core.Scope) core.Node {
			return ui.Text(apptext.T("仅预览前 %d 行、%d 列。", csvPreviewRows, csvPreviewCols), 11, ui.Regular, colors.Muted)
		}},
	}}
}

// markdownImage and htmlImage name a picture a document refers to.
var (
	markdownImage = regexp.MustCompile(`(!\[[^\]]*\]\()([^)\s]+)`)
	htmlImage     = regexp.MustCompile(`(?i)(<img[^>]*\bsrc=")([^"]+)`)
	externalRef   = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.\-]*:`)
)

// resolvePreviewImages points a document's relative picture paths at the
// files beside it: a preview has no base URL of its own.
func resolvePreviewImages(body, dir string) string {
	local := func(ref string) string {
		switch {
		case ref == "", dir == "", strings.HasPrefix(ref, "#"), strings.HasPrefix(ref, "//"),
			strings.HasPrefix(ref, "/"), externalRef.MatchString(ref):
			return ref
		}
		return fileURL(filepath.Join(dir, filepath.FromSlash(ref)))
	}
	swap := func(re *regexp.Regexp, text string) string {
		return re.ReplaceAllStringFunc(text, func(match string) string {
			parts := re.FindStringSubmatch(match)
			return parts[1] + local(parts[2])
		})
	}
	return swap(htmlImage, swap(markdownImage, body))
}
