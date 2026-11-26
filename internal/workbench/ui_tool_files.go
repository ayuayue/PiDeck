//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"

	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// Tool attachments stay outside the text disclosure. A memo prevents streamed
// prose or the elapsed-time clock from rereading unchanged file references.
func (a *app) toolAttachments(s *session, run func() toolRun) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		type source struct {
			root, paths string
			status      chat.Status
		}
		input := core.NewMemo(cx, func() source {
			r := run()
			if s.Target.remote() || s.WS == "" {
				return source{}
			}
			return source{root: s.WS, paths: strings.Join(toolFileCandidates(r), "\x00"), status: r.Status}
		})
		type result struct {
			input source
			files []toolFilePreview
		}
		files := core.NewResource(cx, func() (source, bool) {
			in := input.Get()
			return in, in.root != "" && in.paths != ""
		}, func(ctx context.Context, in source, _ core.ResourceInfo) (result, error) {
			return result{input: in, files: loadToolFiles(ctx, in.root, strings.Split(in.paths, "\x00"))}, nil
		})
		return core.Dynamic(func(cx *core.Scope) core.Node {
			var loaded []toolFilePreview
			in := input.Get()
			if in.root != "" && in.paths != "" {
				if value, ok := files.Get(); ok && value.input == in {
					loaded = value.files
				}
			}
			var tiles []core.Node
			for _, img := range run().Images {
				duplicate := false
				for _, file := range loaded {
					if len(file.image.Data) > 0 && bytes.Equal(file.image.Data, img.Data) {
						duplicate = true
						break
					}
				}
				if !duplicate {
					tiles = append(tiles, a.transcriptImageTile(img))
				}
			}
			for _, file := range loaded {
				tiles = append(tiles, a.toolFileCard(s, file))
			}
			if len(tiles) == 0 {
				return nil
			}
			return core.View{TestID: "tool-attachments", Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8,
				MinWidth: core.Pt(0), Padding: core.Edges{Top: 4, Bottom: 8, Left: viewkit.ContentLeft(a.processSizes()), Right: scrollbarGutter}}, Children: tiles}
		})
	})
}

func (a *app) toolFileCard(s *session, file toolFilePreview) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		kind := filePreviewKind(file.rel)
		p := filePreview{kind: kind}
		icon := lucide.FileText
		switch kind {
		case previewImage:
			icon = lucide.Image
		case previewPDF, previewDocx, previewOffice:
			icon = lucide.File
		case previewTable, previewXLSX:
			icon = lucide.Table
		case previewAudio:
			icon = lucide.Music
		case previewVideo:
			icon = lucide.Video
		case previewBinary:
			icon = lucide.Package
		}
		var mark core.Node = core.View{StyleFunc: func() core.Style {
			return core.Style{Width: core.Pt(48), Height: core.Pt(48), FlexShrink: 0,
				AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, CornerRadius: 6, Background: colors.Inset()}
		}, Children: []core.Node{ui.Icon(icon, 22, colors.Muted)}}
		if len(file.image.Data) > 0 {
			mark = core.Image{Source: core.ImageSource{Data: file.image.Data}, ResizeMode: core.Contain,
				Label: filepath.Base(file.rel), TestID: "tool-file-thumbnail",
				Style: core.Style{Width: core.Pt(64), Height: core.Pt(56), FlexShrink: 0, CornerRadius: 4}}
		}
		text := []core.Node{
			core.Text{Content: filepath.Base(file.rel), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: a.readingRowFont(), FontWeight: ui.Medium, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Text)},
			core.Text{Content: p.kindLabel() + " · " + viewkit.FileSize(file.size), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: a.readingDetailFont(), MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Muted)},
		}
		if dir := filepath.Dir(file.rel); dir != "." {
			text = append(text, core.Text{Content: filepath.ToSlash(dir), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontSize: a.readingDetailFont(), MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Muted)})
		}
		return base.Button{TestID: "tool-file-card", Label: filepath.ToSlash(file.rel),
			OnPress: func(core.PressEvent) { a.openToolFile(s, file.rel) },
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, Width: core.Pt(272),
				MaxWidth: core.Pct(100), MinWidth: core.Pt(0), Padding: core.All(10), CornerRadius: 8, BorderWidth: 1},
			StyleFunc: func() core.Style {
				return core.Style{Background: colors.Surface(), BorderColor: colors.Border(),
					Hover: &core.Style{Background: colors.Hover()}, FocusVisible: ui.FocusRing(cx, 2)}
			}, Children: []core.Node{mark, core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 3}, Children: text}}}
	})
}
