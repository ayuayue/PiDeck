package client

// The phone's composer menu and the actions behind it: the mode of the next
// turn, a picture drawn from the draft, a file mention, and the desktop's
// draft tools. Everything runs on the desktop, so the phone asks and shows
// what comes back.

import (
	"encoding/base64"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// The session modes, as the desktop names them.
const (
	modeNormal = "normal"
	modePlan   = "plan"
	modeGoal   = "goal"
	modeImage  = "imagegen"
)

// modeName names what the next turn asks for.
func modeName(mode string) string {
	switch mode {
	case modePlan:
		return apptext.T("计划")
	case modeGoal:
		return apptext.T("目标")
	case modeImage:
		return apptext.T("生图")
	}
	return apptext.T("正常")
}

// chooseMode asks the desktop for another mode. A mode belongs to the
// session, so the desktop stays the one that holds it; the same mode again
// returns to a plain prompt.
func (a *mobileApp) chooseMode(mode string) {
	a.composerPlusOpen.Set(false)
	id := a.active.GetUntracked()
	client := a.client
	if id == "" || client == nil {
		return
	}
	if a.mode.GetUntracked() == mode {
		mode = modeNormal
	}
	go func() {
		echo, err := client.setMode(id, mode)
		a.cx.Post(func() {
			if err != nil {
				a.sendErr.Set(remoteErrorText(err))
				return
			}
			a.sendErr.Set("")
			a.mode.Set(echo)
			a.flash(apptext.T("下一轮") + "：" + modeName(echo))
			a.refreshState()
		})
	}()
}

// chooseBackend switches where the session runs, before its first message.
func (a *mobileApp) chooseBackend(b remotewire.Backend) {
	id := a.active.GetUntracked()
	client := a.client
	if id == "" || client == nil {
		return
	}
	backend, preset, _ := strings.Cut(b.ID, ":")
	go func() {
		err := client.setBackend(id, backend, preset)
		a.cx.Post(func() {
			if err != nil {
				a.sendErr.Set(remoteErrorText(err))
				return
			}
			a.sendErr.Set("")
			a.flash(apptext.T("后端") + "：" + b.Name)
			a.loadOptions(id)
			a.refreshState()
		})
	}()
}

// runDraftTool rewrites or continues the draft with the desktop's model.
func (a *mobileApp) runDraftTool(tool string) {
	a.composerPlusOpen.Set(false)
	id := a.active.GetUntracked()
	draft := a.draft.GetUntracked()
	client := a.client
	if id == "" || client == nil || strings.TrimSpace(draft) == "" || a.aiBusy.GetUntracked() != "" {
		return
	}
	a.aiBusy.Set(tool)
	go func() {
		text, err := client.draftTool(id, tool, draft)
		a.cx.Post(func() {
			a.aiBusy.Set("")
			if a.client != client {
				return
			}
			if err != nil {
				if a.active.GetUntracked() == id {
					a.sendErr.Set(remoteErrorText(err))
				}
				return
			}
			if a.active.GetUntracked() == id {
				a.sendErr.Set("")
			}
			text = strings.TrimSpace(text)
			if text == "" {
				return
			}
			if tool == "predict" {
				text = strings.TrimRight(draft, " \n") + " " + text
			}
			a.offerDraftChange(client, id, draft, text)
		})
	}()
}

// drawImage turns the draft into a picture, drawn by the desktop's image
// provider and put in the phone's composer, ready to send.
func (a *mobileApp) drawImage() {
	a.composerPlusOpen.Set(false)
	id := a.active.GetUntracked()
	prompt := strings.TrimSpace(a.draft.GetUntracked())
	client := a.client
	if id == "" || client == nil || prompt == "" || a.aiBusy.GetUntracked() != "" {
		return
	}
	wasImageMode := a.mode.GetUntracked() == modeImage
	a.aiBusy.Set("image")
	go func() {
		pictures, err := client.drawImage(id, prompt)
		if err == nil && wasImageMode {
			// The picture is the result, not another description: leave
			// image mode once it is drawn, as the desktop does.
			_, _ = client.setMode(id, modeNormal)
		}
		a.cx.Post(func() {
			a.aiBusy.Set("")
			if err != nil {
				a.sendErr.Set(remoteErrorText(err))
				return
			}
			a.sendErr.Set("")
			list := append([]remotewire.Image(nil), a.pending.GetUntracked()...)
			added := 0
			for _, p := range pictures {
				data, decodeErr := base64.StdEncoding.DecodeString(p.Data)
				if decodeErr != nil || len(data) == 0 {
					continue
				}
				mime := p.Mime
				if mime == "" {
					mime = "image/png"
				}
				list = append(list, remotewire.Image{Data: data, MimeType: mime, Name: "generated.png"})
				added++
			}
			if added == 0 {
				a.sendErr.Set(apptext.T("电脑没有返回图片"))
				return
			}
			a.pending.Set(list)
			a.draft.Set("")
			if wasImageMode {
				a.mode.Set("")
			}
			a.flash(apptext.T("已生成图片"))
		})
	}()
}

// insertMention puts an @path into the draft, so pi reads that file. The
// new-session page keeps its text apart until the session exists.
func (a *mobileApp) insertMention(path string) {
	a.closeFilesView()
	a.filesMention.Set(false)
	if a.active.GetUntracked() == "" {
		a.initDraft.Set(mention(a.initDraft.GetUntracked(), path))
		return
	}
	a.draft.Set(mention(a.draft.GetUntracked(), path))
}

// mention appends @path to a draft, with a space before it.
func mention(draft, path string) string {
	if draft != "" && !strings.HasSuffix(draft, " ") && !strings.HasSuffix(draft, "\n") {
		draft += " "
	}
	return draft + "@" + path + " "
}

// hasDraftTool says whether the desktop has a model for one of the draft
// tools.
func (a *mobileApp) hasDraftTool(tool string) bool {
	for _, t := range a.options.Get().Tools {
		if t == tool {
			return true
		}
	}
	return false
}

// plusRow is one line of the composer's add menu.
func (a *mobileApp) plusRow(icon func() *core.SVG, title, detail, testID string, checked, disabled bool, press func()) core.Node {
	colors := ui.ColorsOf(a.cx)
	var children []core.Node
	if icon != nil {
		children = append(children, ui.Icon(icon, 15, colors.Muted))
	}
	body := []core.Node{core.Text{Content: title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
		Style: core.Style{FontSize: 13.5}, StyleFunc: ui.Colored(colors.Text)}}
	if detail != "" {
		body = append(body, core.Text{Content: detail, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)})
	}
	children = append(children, core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: body})
	if checked {
		children = append(children, ui.Icon(lucide.Check, 15, colors.Accent))
	}
	var disabledStyle *core.Style
	if disabled {
		disabledStyle = ui.Dimmed()
	}
	return core.View{OnPress: func(core.PressEvent) {
		if !disabled && press != nil {
			press()
		}
	}, Role: core.RoleButton, Label: title, TestID: testID,
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(44),
				Padding: core.Symmetric(3, 8), CornerRadius: 8, Transition: viewkit.PressMotion, Disabled: disabledStyle,
				Active: &core.Style{Background: colors.Pressed()}}
			if !disabled {
				st.Hover = &core.Style{Background: colors.Hover()}
			}
			return st
		},
		Children: children}
}

// composerPlusSheet is the add menu under the field: the modes, a picture
// drawn from the draft, a file mention and the draft tools.
func (a *mobileApp) composerPlusSheet() core.Node {
	return ui.Dialog{
		Open:         func() bool { return a.composerPlusOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) { a.composerPlusOpen.Set(open) },
		Title:        apptext.T("添加与工具"),
		TestID:       "mobile-plus-sheet",
		Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			busy := a.aiBusy.Get()
			session := a.active.Get() != ""
			draft := strings.TrimSpace(a.draft.Get())
			empty := draft == "" || busy != ""
			var rows []core.Node
			if session {
				mode := a.mode.Get()
				rows = append(rows,
					a.plusRow(lucide.ClipboardList, apptext.T("计划模式"), apptext.T("先给计划，确认后再动手"),
						"mobile-mode-plan", mode == modePlan, busy != "", func() { a.chooseMode(modePlan) }),
					a.plusRow(lucide.Target, apptext.T("目标模式"), apptext.T("没完成就自己继续，直到完成或停下"),
						"mobile-mode-goal", mode == modeGoal, busy != "", func() { a.chooseMode(modeGoal) }),
					a.plusRow(lucide.Image, apptext.T("把这句话画成图"), apptext.T("用电脑上的生图供应商画一张，放进输入框"),
						"mobile-imagegen", false, empty, a.drawImage),
				)
			}
			rows = append(rows, a.plusRow(lucide.AtSign, apptext.T("插入文件…"), apptext.T("把 @路径 写进消息，让 pi 读这个文件"),
				"mobile-mention", false, false, a.openSessionMentions))
			if session && (a.hasDraftTool("prompt") || a.hasDraftTool("predict")) {
				if a.hasDraftTool("prompt") {
					rows = append(rows, a.plusRow(lucide.WandSparkles, apptext.T("增强这句话"), apptext.T("让电脑上的模型改写得更清楚"),
						"mobile-enhance", false, empty, func() { a.runDraftTool("prompt") }))
				}
				if a.hasDraftTool("predict") {
					rows = append(rows, a.plusRow(lucide.Sparkles, apptext.T("帮我续写"), apptext.T("接着草稿写半句"),
						"mobile-predict", false, empty, func() { a.runDraftTool("predict") }))
				}
			}
			if busy != "" {
				rows = append(rows, core.View{TestID: "mobile-plus-busy",
					Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(8, 8)},
					Children: []core.Node{
						ui.Spinner{Size: 13, Label: apptext.T("正在调用电脑上的模型")},
						ui.Text(apptext.T("正在调用电脑上的模型…"), 11.5, ui.Regular, colors.Faint),
					}})
			}
			return core.View{Style: core.Style{Gap: 1}, Children: rows}
		})},
	}
}

// openSessionMentions lists the open session's project files to mention.
func (a *mobileApp) openSessionMentions() {
	a.composerPlusOpen.Set(false)
	path, name := a.projectOf(a.active.GetUntracked())
	if path == "" {
		// The new-session page has no session yet: the project it starts in
		// is the one whose files are worth mentioning.
		path, name = a.initProjectPath(), a.projectName(a.initProjectPath())
	}
	if path == "" {
		a.sendErr.Set(apptext.T("先在抽屉里添加一个项目"))
		return
	}
	a.filesMention.Set(true)
	a.openFiles(path, name)
}
