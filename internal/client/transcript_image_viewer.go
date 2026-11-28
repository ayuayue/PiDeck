package client

// The phone build: it connects to a desktop PiDeck server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_V2_MOBILE=1 for a preview on a desktop).

import (
	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// transcriptImageViewer shows one attachment over the whole screen: a phone
// has no room for a card inside a card, so the picture takes every point the
// screen has and the two things the viewer can do sit over it. It is an
// overlay rather than a dialog, so it covers the window on every host.
func (a *mobileApp) transcriptImageViewer() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		picture := a.transcriptPicture.Get()
		if !picture.Open {
			return nil
		}
		// Everything over the picture is white: the viewer is black whatever
		// the palette, so the theme's own colours do not apply.
		onDark := func() core.Color { return ui.White(0.92) }
		var body core.Node = ui.Spinner{Label: apptext.T("正在加载图片…")}
		if len(picture.Image.Data) > 0 {
			body = core.Image{Source: core.ImageSource{Data: picture.Image.Data}, ResizeMode: core.Contain,
				Label: apptext.T("图片"), TestID: "mobile-image-full",
				Style: core.Style{Width: core.Pct(100), Height: core.Pct(100)}}
		}
		return core.View{
			TestID: "transcript-image-viewer",
			Style: core.Style{Position: core.Absolute, Top: core.Pt(0), Right: core.Pt(0), Bottom: core.Pt(0), Left: core.Pt(0),
				ZIndex: 40, Background: ui.Black(1)},
			Children: []core.Node{
				// A tap anywhere on the picture closes it: the whole screen is
				// the backdrop on a phone.
				core.View{
					OnPress: func(core.PressEvent) { a.closeTranscriptPicture() },
					Role:    core.RoleButton, Label: apptext.T("关闭图片预览"), TestID: "mobile-image-dismiss",
					Style: core.Style{Width: core.Pct(100), Height: core.Pct(100), AlignItems: core.AlignCenter,
						JustifyContent: core.JustifyCenter, PaddingEnv: core.EnvAll(core.EnvSafeArea)},
					Children: []core.Node{body},
				},
				a.imageViewerTopBar(onDark),
				a.imageViewerSaveBar(cx, picture, onDark),
			},
		}
	})
}

// imageViewerTopBar is what the viewer says and the way out of it.
func (a *mobileApp) imageViewerTopBar(onDark func() core.Color) core.Node {
	return core.View{
		Style: core.Style{Position: core.Absolute, Top: core.Pt(0), Left: core.Pt(0), Right: core.Pt(0),
			Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(10, 12),
			PaddingEnv: core.EnvEdges{Top: core.EnvSafeArea}},
		Children: []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
				ui.Text(apptext.T("图片预览"), 12.5, ui.Medium, onDark),
			}},
			roundIconButton(lucide.X, apptext.T("关闭"), "transcript-image-close", onDark, a.closeTranscriptPicture),
		},
	}
}

// imageViewerSaveBar writes the picture where the user picks.
func (a *mobileApp) imageViewerSaveBar(cx *core.Scope, picture transcriptPicture, onDark func() core.Color) core.Node {
	if len(picture.Image.Data) == 0 {
		return nil
	}
	data, mime := picture.Image.Data, picture.Image.MimeType
	return core.View{
		Style: core.Style{Position: core.Absolute, Bottom: core.Pt(0), Left: core.Pt(0), Right: core.Pt(0),
			Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
			Padding: core.Symmetric(12, 14), PaddingEnv: core.EnvEdges{Bottom: core.EnvSafeArea}},
		Children: []core.Node{core.View{
			OnPress: func(core.PressEvent) {
				cx.SaveFile(core.SaveOptions{Name: imageFileName(mime), MIME: mime, Data: data},
					func(_ bool, _ string, err error) {
						if err != nil {
							a.flash(apptext.T("保存图片失败"))
						}
					})
			},
			Role: core.RoleButton, Label: apptext.T("另存图片…"), TestID: "transcript-image-save",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(36),
					Padding: core.Symmetric(0, 16), CornerRadius: 18,
					Background: ui.Alpha(onDark(), 0.16), Active: &core.Style{Background: ui.Alpha(onDark(), 0.28)}}
			},
			Children: []core.Node{
				ui.IconOf(lucide.Download, 14, onDark),
				core.Text{Content: apptext.T("另存图片…"), Style: core.Style{FontSize: 12.5, FontWeight: ui.Medium},
					StyleFunc: ui.Colored(onDark)},
			},
		}},
	}
}

// closeTranscriptPicture puts the viewer away and drops the bytes with it.
func (a *mobileApp) closeTranscriptPicture() {
	a.transcriptPictureSeq++
	p := a.transcriptPicture.GetUntracked()
	if !p.Open {
		return
	}
	p.Open = false
	a.transcriptPicture.Set(p)
}

// roundIconButton is one round control drawn over a picture, readable on it.
func roundIconButton(icon func() *core.SVG, label, testID string, tint func() core.Color, press func()) core.Node {
	return core.View{
		OnPress: func(core.PressEvent) { press() },
		Role:    core.RoleButton, Label: label, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Width: core.Pt(32), Height: core.Pt(32), CornerRadius: 16, AlignItems: core.AlignCenter,
				JustifyContent: core.JustifyCenter, Background: ui.Alpha(tint(), 0.16),
				Active: &core.Style{Background: ui.Alpha(tint(), 0.28)}}
		},
		Children: []core.Node{ui.IconOf(icon, 15, tint)},
	}
}

// imageFileName is the name a saved picture takes, from what it is.
func imageFileName(mime string) string {
	switch mime {
	case "image/jpeg":
		return "pideck-image.jpg"
	case "image/gif":
		return "pideck-image.gif"
	case "image/webp":
		return "pideck-image.webp"
	default:
		return "pideck-image.png"
	}
}
