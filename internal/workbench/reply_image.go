//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"math"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

const maxReplyImagePixels = 32_000_000

type replyImageRequest struct {
	text  string
	share bool
}

func (a *app) openReplyImage(s *session, t turn, process, share bool, request *core.Signal[*replyImageRequest]) {
	show := func(text string) { request.Set(&replyImageRequest{text: text, share: share}) }
	if share {
		a.prepareReplyShare(s, t, process, show)
	} else {
		show(replyMarkdown(t, process))
	}
}

// The native capture API clips to the window. Render an unfolded document
// in a stationary viewport, capture successive pages, then join their PNGs.
func (a *app) replyImageDialog(request *core.Signal[*replyImageRequest]) core.Node {
	return core.Show{When: func() bool { return request.Get() != nil }, Then: func(cx *core.Scope) core.Node {
		r := request.GetUntracked()
		colors := ui.ColorsOf(cx)
		var viewport core.Ref
		offset := core.NewSignal(cx, core.Points(0))
		page := core.Points(max(80, min(480, float64(cx.Env().Window().Height)-160)))
		height := core.NewSignal(cx, page)
		var fullHeight core.Points
		var tiles [][]byte
		busy, scheduled, stopped := false, false, false
		close := func() { request.Set(nil) }
		fail := func(err error) {
			if !stopped {
				stopped = true
				close()
				a.toast(ui.ToastError, "操作失败", err.Error())
			}
		}
		stopTimeout := cx.AfterFunc(20*time.Second, func() { fail(fmt.Errorf("%s", apptext.T("生成图片超时，请重试。"))) })
		cx.Cleanup(func() { stopped = true; stopTimeout() })
		capture := func() {
			if stopped || busy || scheduled || fullHeight <= 0 {
				return
			}
			scheduled = true
			cx.Post(func() {
				scheduled = false
				if stopped || busy {
					return
				}
				bounds, ok := viewport.Bounds()
				if !ok {
					return
				}
				if float64(bounds.Size.Width)*float64(fullHeight) > maxReplyImagePixels {
					fail(fmt.Errorf("%s", apptext.T("回复过长，无法生成图片。请复制 Markdown。")))
					return
				}
				h := min(page, fullHeight-offset.GetUntracked())
				if height.GetUntracked() != h {
					height.Set(h)
					return
				}
				busy = true
				cx.Capture(&viewport, func(data []byte, err error) {
					if stopped {
						return
					}
					if err != nil {
						fail(err)
						return
					}
					tiles = append(tiles, data)
					if next := offset.GetUntracked() + h; next < fullHeight {
						busy = false
						offset.Set(next)
						return
					}
					go func() {
						data, err := stitchReplyImages(tiles)
						cx.Post(func() {
							if stopped {
								return
							}
							if err != nil {
								fail(err)
								return
							}
							stopped = true
							stopTimeout()
							close()
							a.finishReplyImage(data, r.share)
						})
					}()
				})
			})
		}
		title := apptext.T("复制图片")
		if r.share {
			title = apptext.T("分享图片")
		}
		// No entrance animation: captures must use the final scale and opacity.
		return base.Dialog{Open: func() bool { return true }, Animation: core.ModalNone, Label: title, TestID: "reply-image-dialog",
			OnOpenChange: func(open bool, _ base.Reason) {
				if !open {
					close()
				}
			},
			PopupStyle:     core.Style{Width: core.Pt(min(760, max(160, cx.Env().Window().Width-80))), Padding: core.All(viewkit.PanelInset), Gap: 12},
			PopupStyleFunc: ui.Filled(colors.Background),
			Children: []core.Node{
				core.View{Ref: &viewport, TestID: "reply-image-viewport", OnLayout: func(core.Bounds) { capture() },
					Style:     core.Style{Overflow: core.Hidden, Position: core.Relative, FlexShrink: 0},
					StyleFunc: func() core.Style { return core.Style{Height: core.Pt(height.Get()), Background: colors.Background()} },
					Children: []core.Node{
						core.View{TestID: "reply-image-document", OnLayout: func(b core.Bounds) {
							// Pixel snapping may change a fractional height when the dialog
							// recenters. Keep a monotonic, rounded extent to avoid a layout loop.
							fullHeight = max(fullHeight, core.Points(math.Ceil(float64(b.Size.Height))+2))
							capture()
						},
							StyleFunc: func() core.Style {
								return core.Style{Position: core.Absolute, Top: core.Pt(-offset.Get()), Left: core.Pt(0), Right: core.Pt(0), Padding: core.All(viewkit.PanelInset)}
							},
							Children: []core.Node{viewkit.MarkdownWithCodeWrap(nil, r.text, nil, false, a.readingFont(), a.readingLine(), core.Style{}, func() bool { return true })}},
					}},
				ui.Button{Text: apptext.T("取消"), TestID: "reply-image-cancel", Variant: ui.ButtonGhost, OnPress: close},
			}}
	}}
}

func (a *app) finishReplyImage(data []byte, share bool) {
	if share {
		a.cx.Share(core.ShareOptions{Files: []core.SharedFile{{Name: "reply.png", MIME: "image/png", Data: data}}}, a.replyShareDone)
	} else {
		a.cx.SetClipboardImage(data)
		a.toast(ui.ToastSuccess, "已复制图片", "")
	}
}

func stitchReplyImages(tiles [][]byte) ([]byte, error) {
	width, height := 0, 0
	for _, tile := range tiles {
		cfg, err := png.DecodeConfig(bytes.NewReader(tile))
		if err != nil {
			return nil, err
		}
		if width == 0 {
			width = cfg.Width
		}
		if cfg.Width != width || width <= 0 || cfg.Height <= 0 {
			return nil, fmt.Errorf("reply image has inconsistent tile dimensions")
		}
		if cfg.Height > maxReplyImagePixels/width-height {
			return nil, fmt.Errorf("%s", apptext.T("回复过长，无法生成图片。请复制 Markdown。"))
		}
		height += cfg.Height
	}
	if height == 0 {
		return nil, fmt.Errorf("reply image has no pixels")
	}
	out := image.NewRGBA(image.Rect(0, 0, width, height))
	y := 0
	for _, tile := range tiles {
		img, err := png.Decode(bytes.NewReader(tile))
		if err != nil {
			return nil, err
		}
		h := img.Bounds().Dy()
		draw.Draw(out, image.Rect(0, y, width, y+h), img, img.Bounds().Min, draw.Src)
		y += h
	}
	var result bytes.Buffer
	err := png.Encode(&result, out)
	return result.Bytes(), err
}
