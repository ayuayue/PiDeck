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
	add         func([]remotewire.Image)
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
	return core.View{Style: core.Style{Padding: core.Edges{Top: 4, Right: 10, Bottom: 6, Left: 10},
		PaddingEnv: core.EnvEdges{Bottom: core.EnvKeyboard}}, Children: []core.Node{
		a.sessionActivityBar(cx),
		a.sessionActivitySheet(cx),
		a.draftChangeBar(),
		a.commandSuggestions(cx),
		a.composerCard(cx, composerSource{
			draft: a.draft.Get, setDraft: a.commandDraftChanged,
			pending: a.pending.Get,
			add: func(images []remotewire.Image) {
				a.pending.Update(func(list []remotewire.Image) []remotewire.Image {
					return append(append([]remotewire.Image(nil), list...), images...)
				})
			},
			drop: func(index int) {
				a.pending.Update(func(list []remotewire.Image) []remotewire.Image { return withoutImage(list, index) })
			},
			pick: a.pickImage, send: a.sendMessage, sending: a.sending.Get, running: a.running.Get,
			stop: a.stopTurn, openOptions: a.openOptions, placeholder: "发消息给 pi…",
		}),
	}}
}

// composerCard is the input card: what waits to be sent, the field, and the
// row of controls under it. The field carries no frame of its own; the card
// is the frame, so an empty composer is one soft block rather than a box in
// a box.
func (a *mobileApp) composerCard(cx *core.Scope, src composerSource) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Column, Gap: 4, Padding: core.Edges{Top: 8, Right: 8, Bottom: 6, Left: 10},
			CornerRadius: 20, Background: colors.Surface(), BorderWidth: 1, BorderColor: colors.FieldBorder()}
	}, Children: []core.Node{
		a.composerModeRow(cx, src),
		a.pendingThumbs(cx, src.pending, src.drop),
		core.Input{Value: src.draft, OnChange: src.setDraft, Placeholder: apptext.T(src.placeholder),
			Label: apptext.T("消息"), TestID: "mobile-draft",
			// Return makes a new line; the send button sends.
			Multiline: true, SubmitBehavior: core.SubmitBehaviorNewline,
			OnPaste: func(e core.PasteEvent) { a.pastedPictures(src, e) },
			Style: core.Style{MinHeight: core.Pt(38), MaxHeight: core.Pt(132), Padding: core.Symmetric(6, 1), FontSize: 15,
				Color: colors.Text(), Background: colors.Surface(), PlaceholderColor: colors.Faint(),
				CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}},
		a.composerToolbar(cx, src),
	}}
}

// composerModeRow is the chip above the field that says what the next turn
// asks for, when it is not an ordinary prompt.
func (a *mobileApp) composerModeRow(cx *core.Scope, src composerSource) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		mode := a.mode.Get()
		if mode == "" || a.active.Get() == "" {
			return nil
		}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, MinWidth: core.Pt(0)},
			Children: []core.Node{a.modeChip(mode)}}
	})
}

// composerToolbar is the row under the field, where the desktop keeps its
// chips: the model, the thinking level and the usage on the left, the
// picture button, the add menu and send on the right. The chips shrink to
// the width they have rather than wrap, so the card stays one short block
// whatever the phone's width.
func (a *mobileApp) composerToolbar(cx *core.Scope, src composerSource) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		empty := strings.TrimSpace(src.draft()) == "" && len(src.pending()) == 0
		sending := src.sending()
		var left []core.Node
		if src.openOptions != nil {
			left = append(left,
				a.composerChip(lucide.Cpu, a.modelLabel(), apptext.T("选择模型"), "mobile-model", src.openOptions),
				a.composerChip(lucide.Brain, a.thinkingLabel(), apptext.T("思考等级"), "mobile-thinking", src.openOptions),
				a.usageChip())
		}
		var right []core.Node
		right = append(right, a.composerIcon(lucide.Image, apptext.T("添加图片"), "mobile-image", src.pick))
		right = append(right, a.composerIcon(lucide.Plus, apptext.T("添加与工具"), "mobile-plus", func() { a.composerPlusOpen.Set(true) }))
		if src.stop != nil && src.running() {
			right = append(right, a.composerIcon(lucide.Square, apptext.T("停止这一轮"), "mobile-stop", src.stop))
		}
		right = append(right, a.sendButton(cx, sending, empty, src.send))
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, MinWidth: core.Pt(0),
			MinHeight: core.Pt(34)}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2, FlexGrow: 1, FlexShrink: 1,
				MinWidth: core.Pt(0), Wrap: core.Wrap, Overflow: core.Hidden, MaxHeight: core.Pt(30)}, Children: left},
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

// composerChip is one small control of the toolbar: a glyph and its words in
// a soft pill. label is what it shows, name what assistive technology reads
// for it.
func (a *mobileApp) composerChip(icon func() *core.SVG, label, name, testID string, press func()) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{OnPress: func(core.PressEvent) { press() }, Role: core.RoleButton, Label: name, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(26), FlexShrink: 1,
				Padding: core.Symmetric(0, 8), CornerRadius: 13, Background: colors.Inset(), Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.Icon(icon, 11.5, colors.Muted),
			core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0), MaxWidth: core.Pt(104), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
		}}
}

// composerIcon is a toolbar button of a glyph alone.
func (a *mobileApp) composerIcon(icon func() *core.SVG, name, testID string, press func()) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{OnPress: func(core.PressEvent) { press() }, Role: core.RoleButton, Label: name, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Width: core.Pt(30), Height: core.Pt(30), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
				CornerRadius: 15, FlexShrink: 0, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{ui.Icon(icon, 16, colors.Muted)}}
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
// The list is read inside a Dynamic: a Show only rebuilds its content when
// presence changes, so a second picture would never get its thumb.
func (a *mobileApp) pendingThumbs(cx *core.Scope, images func() []remotewire.Image, drop func(index int)) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		list := images()
		if len(list) == 0 {
			return nil
		}
		colors := ui.ColorsOf(cx)
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
	})
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

// composerImageMax is the most one picture may take, picked or pasted: the
// desktop refuses more too.
const composerImageMax = 6 << 20

// pastedPictures attaches the pictures a paste carried. A browser's clipboard
// offers them as files, which is the only way to paste a screenshot into the
// web build; a paste of text is left to the field.
func (a *mobileApp) pastedPictures(src composerSource, e core.PasteEvent) {
	if src.add == nil {
		return
	}
	var images []remotewire.Image
	for _, file := range e.Files {
		if len(file.Data) == 0 {
			continue
		}
		mime := strings.ToLower(strings.TrimSpace(file.MIME))
		if !strings.HasPrefix(mime, "image/") {
			// The clipboard often names no type: read the bytes instead.
			mime = http.DetectContentType(file.Data)
		}
		switch mime {
		case "image/png", "image/jpeg", "image/gif", "image/webp":
		default:
			continue
		}
		if len(file.Data) > composerImageMax {
			a.flash(apptext.T("图片太大，上限 6 MB"))
			continue
		}
		name := strings.TrimSpace(file.Name)
		if name == "" {
			name = apptext.T("粘贴的图片")
		}
		images = append(images, remotewire.Image{Data: file.Data, MimeType: mime, Name: name})
	}
	if len(images) > 0 {
		src.add(images)
	}
}

// readImageFile reads one picture from the phone, ready to send.
func readImageFile(path string) (remotewire.Image, error) {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return remotewire.Image{}, errors.New(apptext.T("图片读不出来"))
	}
	if len(data) > composerImageMax {
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
	draft := a.draft.GetUntracked()
	text := strings.TrimSpace(draft)
	images := append([]remotewire.Image(nil), a.pending.GetUntracked()...)
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
	case a.mode.GetUntracked() == modeImage && text != "" && !strings.HasPrefix(text, "/"):
		// Image mode draws the words instead of prompting pi; the picture
		// arrives in the composer, ready to send.
		a.drawImage()
		return
	}
	visit := a.sessionSeq
	a.sending.Set(true)
	a.draft.Set("")
	a.pending.Set(nil)
	a.sendErr.Set("")
	// Nothing confirms the send but the message itself: the poll brings it
	// back at the transcript's end once the desktop has it.
	go func() {
		err := client.promptWithImages(id, text, images)
		a.cx.Post(func() {
			if a.client != client || visit != a.sessionSeq || a.active.GetUntracked() != id {
				return
			}
			a.sending.Set(false)
			if err != nil {
				// Do not mix a failed send back into a draft edited while it was in flight.
				if a.draft.GetUntracked() == "" && len(a.pending.GetUntracked()) == 0 {
					a.draft.Set(draft)
					a.pending.Set(images)
				}
				a.sendErr.Set(remoteErrorText(err))
				return
			}
			if strings.HasPrefix(text, "/") {
				a.features.commandSession = ""
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
