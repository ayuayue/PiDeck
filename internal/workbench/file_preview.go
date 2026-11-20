//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/csv"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

const (
	csvPreviewRows  = 1000
	csvPreviewCols  = 48
	csvPreviewBytes = 2 << 20
)

type filePreview struct {
	path, kind, err string
	loading         bool
	rows            [][]string
	columns         int
	limited         bool
}

func filePreviewKind(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".csv", ".tsv":
		return "table"
	case ".mp4", ".m4v", ".mov", ".webm":
		return "video"
	case ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".wps", ".et", ".dps", ".odt", ".ods", ".odp":
		return "office"
	}
	return ""
}

func readTablePreview(path string) (filePreview, error) {
	p := filePreview{path: path, kind: "table"}
	f, err := os.Open(path)
	if err != nil {
		return p, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, csvPreviewBytes+1))
	if err != nil {
		return p, err
	}
	if len(data) > csvPreviewBytes {
		return p, errors.New(apptext.T("表格预览最多读取 2 MB。"))
	}
	if !utf8.Valid(data) || bytes.ContainsRune(data, 0) {
		return p, errors.New(apptext.T("请选择 UTF-8 编码的表格。"))
	}
	r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))))
	if strings.EqualFold(filepath.Ext(path), ".tsv") {
		r.Comma = '\t'
	}
	r.FieldsPerRecord = -1
	for {
		row, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return p, err
		}
		if len(p.rows) >= csvPreviewRows {
			p.limited = true
			break
		}
		if len(row) > csvPreviewCols {
			p.limited = true
			row = row[:csvPreviewCols]
		}
		p.columns = max(p.columns, len(row))
		p.rows = append(p.rows, row)
	}
	return p, nil
}

func (a *app) openFilePreview(path, kind string) {
	state := &filePreview{path: path, kind: kind, loading: true}
	a.preview.Set(state)
	go func() {
		p, err := *state, error(nil)
		if kind == "table" {
			p, err = readTablePreview(path)
		} else if info, statErr := os.Stat(path); statErr != nil {
			err = statErr
		} else if !info.Mode().IsRegular() {
			err = errors.New(apptext.T("找不到这个文件"))
		}
		p.loading = false
		if err != nil {
			p.err = err.Error()
		}
		a.cx.Post(func() {
			if a.preview.GetUntracked() == state {
				a.preview.Set(&p)
			}
		})
	}()
}

func (a *app) filePreviewDialog() core.Node {
	return core.Show{When: func() bool { return a.preview.Get() != nil }, Then: func(cx *core.Scope) core.Node {
		return core.Dynamic(func(cx *core.Scope) core.Node {
			p := a.preview.Get()
			if p == nil {
				return nil
			}
			colors := ui.ColorsOf(cx)
			closePreview := func() { a.preview.Set(nil) }
			var body core.Node
			switch {
			case p.loading:
				body = ui.Spinner{Size: 16}
			case p.err != "":
				body = ui.Text(p.err, 12, ui.Regular, colors.Danger)
			case p.kind == "table":
				body = a.tablePreview(cx, p)
			case p.kind == "video":
				body = core.Video{Source: p.path, Controls: true, Paused: true,
					Style: core.Style{Height: core.Pt(390)}, TestID: "video-preview", Label: filepath.Base(p.path),
					OnError: func(err error) { a.toast(ui.ToastError, "无法播放此视频", err.Error()) }}
			default:
				body = ui.Text(apptext.T("使用系统关联的文档应用打开并编辑。"), 13, ui.Regular, colors.Muted)
			}
			var actions []core.Node
			if !p.loading && p.err == "" {
				if p.kind == "table" {
					actions = append(actions, ui.Button{Text: apptext.T("编辑文本"), Variant: ui.ButtonSecondary, TestID: "preview-edit-text", OnPress: func() {
						closePreview()
						a.activePane.Set("")
						a.editor.openFile(filepath.Dir(p.path), p.path)
						a.rememberFile(p.path)
					}})
				}
				actions = append(actions, ui.Button{Text: apptext.T("在系统应用中打开"), Variant: ui.ButtonSecondary,
					TestID: "preview-open-native", OnPress: func() { a.cx.OpenURL(fileURL(p.path), nil) }})
			}
			actions = append(actions, ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, OnPress: closePreview})
			return ui.Dialog{Title: filepath.Base(p.path), TestID: "file-preview", Style: core.Style{Width: a.dialogWidth()},
				Open: func() bool { return a.preview.Get() != nil }, OnOpenChange: func(open bool, _ base.Reason) {
					if !open {
						closePreview()
					}
				}, Children: []core.Node{body}, Footer: actions}
		})
	}}
}

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
	return core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
		core.Scroll{Horizontal: true, Style: core.Style{Height: core.Pt(345)}, Children: []core.Node{
			core.List{Style: core.Style{Width: core.Pt(core.Points(p.columns * colWidth)), Height: core.Pt(329)},
				EstimatedSize: 28, Count: func() int { return len(p.rows) }, TestID: "csv-preview-rows",
				Row: func(cx *core.Scope, item core.ListRow) core.Node { return row(item.Index()) }},
		}},
		core.Show{When: func() bool { return p.limited }, Then: func(cx *core.Scope) core.Node {
			return ui.Text(apptext.T("仅预览前 %d 行、%d 列。", csvPreviewRows, csvPreviewCols), 11, ui.Regular, colors.Muted)
		}},
	}}
}
