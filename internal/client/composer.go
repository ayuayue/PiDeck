package client

// The phone build: it connects to a desktop PiDeck Lite server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_LITE_MOBILE=1 for a preview on a desktop).

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// composer is the message bar under a transcript.
func (a *mobileApp) composer(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Column, Gap: 6, Padding: core.Symmetric(8, 10),
			PaddingEnv: core.EnvEdges{Bottom: core.EnvKeyboard},
			Background: colors.Surface(), Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Line()}}
	}, Children: []core.Node{
		a.pendingStrip(cx),
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignEnd, Gap: 8}, Children: []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), MinHeight: core.Pt(42)}, Children: []core.Node{
				core.Input{Value: a.draft.Get, OnChange: a.draft.Set, Placeholder: apptext.T("发消息给 pi…"), Label: apptext.T("消息"), TestID: "mobile-draft",
					// Return makes a new line; the send button sends.
					Multiline: true, SubmitBehavior: core.SubmitBehaviorNewline,
					Style: core.Style{MinHeight: core.Pt(42), MaxHeight: core.Pt(132), Padding: core.Symmetric(10, 12), FontSize: 14, Color: colors.Text(),
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 12,
						PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}},
			}},
			a.pressIcon(lucide.Image, "添加图片", 38, 16, nil, a.pickImage, "mobile-image"),
			core.Dynamic(func(*core.Scope) core.Node {
				empty := func() bool {
					return strings.TrimSpace(a.draft.Get()) == "" && len(a.pending.Get()) == 0
				}
				var actions []core.Node
				// A running turn can still take another message: pi queues it,
				// so the stop button sits beside send instead of replacing it.
				if a.running.Get() {
					actions = append(actions, a.pressIcon(lucide.Square, "停止这一轮", 38, 14, nil, a.stopTurn, "mobile-stop"))
				}
				actions = append(actions, ui.Press{OnPress: a.sendMessage, Disabled: empty, Scale: 0.9, Role: core.RoleButton, Label: apptext.T("发送"), TestID: "mobile-send",
					StyleFunc: func() core.Style {
						st := core.Style{Width: core.Pt(40), Height: core.Pt(40), CornerRadius: 20, AlignItems: core.AlignCenter,
							JustifyContent: core.JustifyCenter, Background: colors.Light(), Transition: viewkit.PressMotion}
						if empty() {
							st.Background = colors.Inset()
						}
						return st
					},
					Children: []core.Node{ui.Icon(lucide.Send, 16, func() core.Color {
						if empty() {
							return colors.Faint()
						}
						return colors.OnLight()
					})}})
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: actions}
			}),
		}},
	}}
}

// pendingStrip shows the pictures waiting to be sent; tapping one drops it.
func (a *mobileApp) pendingStrip(cx *core.Scope) core.Node {
	return a.pendingThumbs(cx, func() []remotewire.Image { return a.pending.Get() }, func(index int) {
		a.pending.Update(func(list []remotewire.Image) []remotewire.Image { return withoutImage(list, index) })
	})
}

// pendingThumbs is the strip both composers show, each with its own list.
func (a *mobileApp) pendingThumbs(cx *core.Scope, images func() []remotewire.Image, drop func(index int)) core.Node {
	colors := ui.ColorsOf(cx)
	return core.Show{When: func() bool { return len(images()) > 0 }, Then: func(*core.Scope) core.Node {
		list := images()
		thumbs := make([]core.Node, 0, len(list))
		for i, img := range list {
			index := i
			thumbs = append(thumbs, core.View{OnPress: func(core.PressEvent) { drop(index) },
				Role: core.RoleButton, Label: apptext.T("移除图片"), TestID: "mobile-pending",
				Style: core.Style{Width: core.Pt(46), Height: core.Pt(46), CornerRadius: 9, Overflow: core.Hidden,
					BorderWidth: 1, BorderColor: colors.Border()},
				Children: []core.Node{core.Image{Source: core.ImageSource{Data: img.Data}, ResizeMode: core.Cover,
					Label: apptext.T("待发送的图片"), Style: core.Style{Width: core.Pct(100), Height: core.Pct(100)}}},
			})
		}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: thumbs}
	}}
}

// withoutImage drops one picture from a list.
func withoutImage(list []remotewire.Image, index int) []remotewire.Image {
	out := make([]remotewire.Image, 0, len(list))
	for i, img := range list {
		if i != index {
			out = append(out, img)
		}
	}
	return out
}

// readImageFile reads one picture from the phone, ready to send.
func readImageFile(path string) (remotewire.Image, error) {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return remotewire.Image{}, errors.New(apptext.T("图片读不出来"))
	}
	if len(data) > 6<<20 {
		return remotewire.Image{}, errors.New(apptext.T("图片太大，上限 6 MB"))
	}
	mime := http.DetectContentType(data)
	if !strings.HasPrefix(mime, "image/") {
		mime = "image/png"
	}
	return remotewire.Image{Data: data, MimeType: mime, Name: filepath.Base(path)}, nil
}

// pickImage adds pictures from the phone to the next message.
func (a *mobileApp) pickImage() {
	if a.client == nil {
		return
	}
	a.cx.PickFiles(core.PickFilesOptions{Types: []string{"image/*"}, Multiple: true, Limit: 4}, func(files []core.File, err error) {
		if err != nil {
			a.flash("选择图片失败")
			return
		}
		for _, file := range files {
			img, readErr := readImageFile(file.Path)
			if readErr != nil {
				a.flash(readErr.Error())
				continue
			}
			a.pending.Update(func(list []remotewire.Image) []remotewire.Image { return append(list, img) })
		}
	})
}

// sendMessage hands the composer's text to the desktop.
func (a *mobileApp) sendMessage() {
	id := a.active.GetUntracked()
	text := strings.TrimSpace(a.draft.GetUntracked())
	client := a.client
	if id == "" || (text == "" && len(a.pending.GetUntracked()) == 0) || client == nil || a.sending.GetUntracked() {
		return
	}
	images := a.pending.GetUntracked()
	a.sending.Set(true)
	a.draft.Set("")
	a.pending.Set(nil)
	a.transcriptErr.Set("")
	go func() {
		err := client.promptWithImages(id, text, images)
		a.cx.Post(func() {
			a.sending.Set(false)
			if err != nil {
				a.draft.Set(text)
				a.pending.Set(images)
				a.transcriptErr.Set(remoteErrorText(err))
				return
			}
			a.refreshTranscript()
		})
	}()
}

// stopTurn aborts the running turn.
func (a *mobileApp) stopTurn() {
	id := a.active.GetUntracked()
	client := a.client
	if id == "" || client == nil {
		return
	}
	go func() {
		err := client.stop(id)
		a.cx.Post(func() {
			if err != nil {
				a.transcriptErr.Set(remoteErrorText(err))
				return
			}
			a.refreshTranscript()
		})
	}()
}
