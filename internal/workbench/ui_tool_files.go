//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/remotewire"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// Only image attachments stay outside the text disclosure. A memo prevents streamed
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
			var paths []string
			for _, path := range toolFileCandidates(r) {
				if rel, ok := toolFileRelative(s.WS, path); ok && filePreviewKind(rel) == previewImage {
					paths = append(paths, rel)
				}
			}
			return source{root: s.WS, paths: strings.Join(paths, "\x00"), status: r.Status}
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
				if len(img.Data) == 0 {
					continue
				}
				duplicate := false
				for _, file := range loaded {
					if len(file.image.Data) > 0 && bytes.Equal(file.image.Data, img.Data) {
						duplicate = true
						break
					}
				}
				if !duplicate {
					tiles = append(tiles, a.toolImageTile(img, "transcript-image-tile", ""))
				}
			}
			for _, file := range loaded {
				if len(file.image.Data) > 0 {
					img := file.image
					img.Name = filepath.ToSlash(file.rel)
					tiles = append(tiles, a.toolImageTile(img, "tool-file-card", "tool-file-thumbnail"))
				}
			}
			if len(tiles) == 0 {
				return nil
			}
			return core.View{TestID: "tool-attachments", Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6,
				MinWidth: core.Pt(0), Padding: core.Edges{Top: 2, Bottom: 4, Left: viewkit.ContentLeft(a.processSizes()), Right: scrollbarGutter}}, Children: tiles}
		})
	})
}

// toolImageTile keeps the transcript compact; the shared dialog owns the
// enlarged view and its copy/save actions for returned and local images alike.
func (a *app) toolImageTile(img remotewire.Image, testID, imageID string) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		label := firstNonEmpty(img.Name, apptext.T("图片"))
		return ui.Tooltip{Text: label,
			Style: core.Style{Width: core.Pt(64), Height: core.Pt(48), FlexShrink: 0},
			Trigger: base.Button{TestID: testID, Label: label,
				OnPress: func(core.PressEvent) { a.attachPreview.Set(img) },
				Style: core.Style{Width: core.Pct(100), Height: core.Pct(100), CornerRadius: 6,
					BorderWidth: 1, Overflow: core.Hidden},
				StyleFunc: func() core.Style {
					return core.Style{Background: colors.Surface(), BorderColor: colors.Border(),
						Hover: &core.Style{BorderColor: colors.Accent()}, FocusVisible: ui.FocusRing(cx, 2)}
				},
				Children: []core.Node{core.Image{Source: core.ImageSource{Data: img.Data}, ResizeMode: core.Contain,
					Label: label, TestID: imageID, Style: core.Style{Width: core.Pct(100), Height: core.Pct(100)}}},
			}}
	})
}
