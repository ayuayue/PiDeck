package client

// The phone build: it connects to a desktop PiDeck V2 server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_V2_MOBILE=1 for a preview on a desktop).

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// composerSource is what one composer edits: the text, the pictures
// waiting for it, and what its controls do. The new-session page and an
// open session differ only in where the text goes, so both draw the one
// card below.
type composerSource struct {
	draft       func() string
	setDraft    func(string)
	pending     func() []remotewire.Image
	drop        func(index int)
	pick        func()
	send        func()
	sending     func() bool
	running     func() bool
	stop        func()
	openOptions func()
	placeholder string
}

// composer is the message bar under a transcript, the desktop's card in
// the phone's size: the pictures, the text, and one row of controls.
func (a *mobileApp) composer(cx *core.Scope) core.Node {
	return core.View{Style: core.Style{Padding: core.Edges{Top: 6, Right: 10, Bottom: 8, Left: 10},
		PaddingEnv: core.EnvEdges{Bottom: core.EnvKeyboard}}, Children: []core.Node{
		a.draftChangeBar(),
		a.composerCard(cx, composerSource{
			draft: a.draft.Get, setDraft: a.draft.Set,
			pending: a.pending.Get,
			drop: func(index int) {
				a.pending.Update(func(list []remotewire.Image) []remotewire.Image { return withoutImage(list, index) })
			},
			pick: a.pickImage, send: a.sendMessage, sending: a.sending.Get, running: a.running.Get,
			stop: a.stopTurn, openOptions: a.openOptions, placeholder: "发消息给 pi…",
		}),
	}}
}

// composerCard is the input card: what waits to be sent, the field, and the
// row of controls under it.
func (a *mobileApp) composerCard(cx *core.Scope, src composerSource) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Column, Gap: 2, Padding: core.Symmetric(4, 6), CornerRadius: 16,
			Background: colors.Surface(), BorderWidth: 1, BorderColor: colors.FieldBorder()}
	}, Children: []core.Node{
		a.pendingThumbs(cx, src.pending, src.drop),
		core.Input{Value: src.draft, OnChange: src.setDraft, Placeholder: apptext.T(src.placeholder),
			Label: apptext.T("消息"), TestID: "mobile-draft",
			// Return makes a new line; the send button sends.
			Multiline: true, SubmitBehavior: core.SubmitBehaviorNewline,
			Style: core.Style{MinHeight: core.Pt(40), MaxHeight: core.Pt(140), Padding: core.Symmetric(8, 8), FontSize: 14.5,
				Color: colors.Text(), Background: colors.Surface(), PlaceholderColor: colors.Faint(),
				CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}},
		a.composerToolbar(cx, src),
	}}
}

// composerToolbar is the row under the field, where the desktop keeps its
// chips: the model, the thinking level, the picture button and the usage,
// with send and stop at the right.
func (a *mobileApp) composerToolbar(cx *core.Scope, src composerSource) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		empty := strings.TrimSpace(src.draft()) == "" && len(src.pending()) == 0
		sending := src.sending()
		var left []core.Node
		if mode := a.mode.Get(); mode != "" && a.active.Get() != "" {
			left = append(left, a.modeChip(mode))
		}
		if src.openOptions != nil {
			left = append(left,
				a.composerChip(lucide.Cpu, a.modelLabel(), apptext.T("选择模型"), "mobile-model", src.openOptions),
				a.composerChip(lucide.Brain, a.thinkingLabel(), apptext.T("思考等级"), "mobile-thinking", src.openOptions),
				a.usageChip())
		}
		left = append(left, a.voiceButton(src), a.composerIcon(lucide.Image, apptext.T("添加图片"), "mobile-image", src.pick))
		var right []core.Node
		right = append(right, a.composerIcon(lucide.Plus, apptext.T("添加与工具"), "mobile-plus", func() { a.composerPlusOpen.Set(true) }))
		if src.stop != nil && src.running() {
			right = append(right, a.composerIcon(lucide.Square, apptext.T("停止这一轮"), "mobile-stop", src.stop))
		}
		right = append(right, a.sendButton(cx, sending, empty, src.send))
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, MinWidth: core.Pt(0)},
			Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2, FlexGrow: 1, FlexShrink: 1,
					MinWidth: core.Pt(0), Wrap: core.Wrap, Overflow: core.Hidden, MaxHeight: core.Pt(58)}, Children: left},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2, FlexShrink: 0}, Children: right},
			}}
	})
}

// modeChip shows what the next turn asks for, and drops it again.
func (a *mobileApp) modeChip(mode string) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{OnPress: func(core.PressEvent) { a.chooseMode(mode) }, Role: core.RoleButton,
		Label: apptext.T("模式") + "：" + modeName(mode), TestID: "mobile-mode",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 3, Height: core.Pt(28), FlexShrink: 0,
				Padding: core.Symmetric(0, 6), CornerRadius: 8, Background: ui.Alpha(colors.Accent(), 0.13),
				BorderWidth: 1, BorderColor: ui.Alpha(colors.Accent(), 0.34), Transition: viewkit.PressMotion}
		},
		Children: []core.Node{
			ui.Icon(lucide.Target, 12, colors.Accent),
			core.Text{Content: modeName(mode), MaxLines: 1, Style: core.Style{FontSize: 11.5, FontWeight: ui.Medium},
				StyleFunc: ui.Colored(colors.Text)},
			ui.Icon(lucide.X, 11, colors.Muted),
		}}
}

// composerChip is one small control of the toolbar: a glyph and its words.
// label is what it shows, name what assistive technology reads for it.
func (a *mobileApp) composerChip(icon func() *core.SVG, label, name, testID string, press func()) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{OnPress: func(core.PressEvent) { press() }, Role: core.RoleButton, Label: name, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(28), FlexShrink: 0,
				Padding: core.Symmetric(0, 6), CornerRadius: 8, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.Icon(icon, 12, colors.Muted),
			core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexShrink: 1, MaxWidth: core.Pt(112), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
		}}
}

// composerIcon is a toolbar button of a glyph alone.
func (a *mobileApp) composerIcon(icon func() *core.SVG, name, testID string, press func()) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{OnPress: func(core.PressEvent) { press() }, Role: core.RoleButton, Label: name, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Width: core.Pt(28), Height: core.Pt(28), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
				CornerRadius: 8, FlexShrink: 0, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{ui.Icon(icon, 15, colors.Muted)}}
}

// sendButton sends, and shows that it is sending.
func (a *mobileApp) sendButton(cx *core.Scope, sending, empty bool, press func()) core.Node {
	colors := ui.ColorsOf(cx)
	if sending {
		return core.View{TestID: "mobile-sending", Style: core.Style{Width: core.Pt(36), Height: core.Pt(36), AlignItems: core.AlignCenter,
			JustifyContent: core.JustifyCenter}, Children: []core.Node{ui.Spinner{Size: 15, Label: apptext.T("发送中")}}}
	}
	return ui.Press{OnPress: press, Disabled: func() bool { return empty }, Scale: 0.9, Role: core.RoleButton, Label: apptext.T("发送"),
		TestID: "mobile-send",
		StyleFunc: func() core.Style {
			st := core.Style{Width: core.Pt(36), Height: core.Pt(36), CornerRadius: 18, AlignItems: core.AlignCenter,
				JustifyContent: core.JustifyCenter, Background: colors.Light(), Transition: viewkit.PressMotion}
			if empty {
				st.Background = colors.Inset()
			}
			return st
		},
		Children: []core.Node{ui.Icon(lucide.Send, 15, func() core.Color {
			if empty {
				return colors.Faint()
			}
			return colors.OnLight()
		})}}
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
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(2, 2)}, Children: thumbs}
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
		a.flash(apptext.T("还没连上电脑"))
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
	images := a.pending.GetUntracked()
	client := a.client
	switch {
	case client == nil:
		a.flash(apptext.T("还没连上电脑，先回到连接页"))
		return
	case id == "":
		a.flash(apptext.T("会话还没准备好，稍等一下"))
		return
	case text == "" && len(images) == 0:
		return
	case a.sending.GetUntracked():
		a.flash(apptext.T("上一条还在发送"))
		return
	case a.mode.GetUntracked() == modeImage && text != "":
		// Image mode draws the words instead of prompting pi; the picture
		// arrives in the composer, ready to send.
		a.drawImage()
		return
	}
	a.sending.Set(true)
	a.draft.Set("")
	a.pending.Set(nil)
	a.sendErr.Set("")
	// The desktop may take a moment to start pi, so say it went out now and
	// let the poll bring the answer.
	a.flash(apptext.T("已发送"))
	go func() {
		err := client.promptWithImages(id, text, images)
		a.cx.Post(func() {
			a.sending.Set(false)
			if err != nil {
				a.draft.Set(text)
				a.pending.Set(images)
				a.sendErr.Set(remoteErrorText(err))
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
				a.sendErr.Set(remoteErrorText(err))
				return
			}
			a.sendErr.Set("")
			a.refreshTranscript()
		})
	}()
}
