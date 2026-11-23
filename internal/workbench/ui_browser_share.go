//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) browserShareBar() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		s := a.active()
		colors := ui.ColorsOf(cx)
		nav := a.browser.nav.Get()
		origin := browserOrigin(nav.URL)
		if origin == "" || nav.Loading {
			return nil
		}
		shared := a.browser.owner.Get() != ""
		var controls []core.Node
		if shared {
			label := apptext.T("当前站点已共享")
			if owner := a.byID[a.browser.owner.Get()]; owner != nil {
				label = apptext.T("共享给 %s", owner.title.Get())
			}
			controls = append(controls, ui.Icon(lucide.Link, 13, colors.Accent),
				core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Text)},
				ui.Button{Text: apptext.T("停止共享"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "browser-unshare", OnPress: a.revokeBrowser})
		} else if s != nil && s.backend != "acp" && !s.Target.remote() {
			controls = append(controls, ui.Button{Text: apptext.T("共享给当前会话"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "browser-share",
				Disabled: func() bool { return s.busy() || s.status.Get() == statusStarting }, OnPress: func() {
					if s.starting || s.busyNow() || s.deleting || a.browser.nav.GetUntracked().Loading || browserOrigin(a.browser.nav.GetUntracked().URL) != origin {
						return
					}
					ws := a.workspaceFor(s.Target, s.WS)
					if ws == nil || !a.projectTrusted(ws) {
						a.toast(ui.ToastWarning, "无法共享网页", "请先信任当前项目。")
						return
					}
					a.browser.origin = origin
					a.browser.owner.Set(s.ID)
					if s.engine != nil {
						a.restartAgent(s)
					}
				}})
		}
		controls = append(controls, ui.Button{Text: apptext.T("翻译选中文字"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "browser-translate",
			OnPress: func() {
				a.browser.view.Evaluate(`String(window.getSelection() || "").slice(0, 12000)`, func(raw string, err error) {
					var text string
					if err != nil || json.Unmarshal([]byte(raw), &text) != nil || strings.TrimSpace(text) == "" {
						a.toast(ui.ToastInfo, "请先在网页上选中文字", "")
						return
					}
					a.openTranslationWith(text)
				})
			}})
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(3, 10), Background: colors.Surface()}, Children: controls}
	})
}

// Keep the WebView visible while starting a turn. The session's regular
// draft and queue still own the message and attachments.
func (a *app) sharedBrowserComposer() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		s := a.byID[a.browser.owner.Get()]
		if s == nil {
			return nil
		}
		colors := ui.ColorsOf(cx)
		disabled := func() bool { return s.busy() || s.status.Get() == statusStarting }
		send := func() {
			if !disabled() && a.browserReady(s) {
				a.sendDraft(s, deliveryFollowUp)
			}
		}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(6, 10), Background: colors.Surface()}, Children: []core.Node{
			core.Input{Value: s.draft.Get, OnChange: s.draft.Set, OnSubmit: func(string) { send() }, Disabled: disabled,
				TestID: "browser-agent-prompt", Label: apptext.T("给共享会话发消息"), Placeholder: apptext.T("给共享会话发消息"),
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Height: core.Pt(30), Padding: core.Symmetric(0, 8),
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: ui.RadiusControl, Color: colors.Text()}},
			ui.Button{Text: apptext.T("发送"), Size: ui.SizeSmall, TestID: "browser-agent-send", Disabled: func() bool {
				return disabled() || a.browser.nav.Get().Loading || (strings.TrimSpace(s.draft.Get()) == "" && len(s.images.Get()) == 0)
			}, OnPress: send},
		}}
	})
}

func (a *app) browserApprovalDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		p := a.browser.pending.Get()
		if p == nil {
			return nil
		}
		colors := ui.ColorsOf(cx)
		target := p.target.Label
		if target == "" {
			target = p.target.Role
		}
		action := apptext.T("点击 %s", target)
		if p.kind == "type" {
			action = apptext.T("在 %s 中输入", target)
		}
		var details []core.Node
		details = append(details, setRow(action, p.snapshot.URL, nil))
		if p.target.Href != "" {
			details = append(details, core.Text{Content: p.target.Href, Selectable: core.SelectableOn, Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Muted)})
		}
		if p.action.Text != "" {
			details = append(details, a.scrollStashFor("browserApprovalDialog:1").bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(180)}, Children: []core.Node{
				core.Text{Content: p.action.Text, Selectable: core.SelectableOn, Style: core.Style{FontSize: 13}, StyleFunc: ui.Colored(colors.Text)},
			}}))
		}
		return ui.Dialog{Open: func() bool { return a.browser.pending.Get() == p }, TestID: "browser-approve-dialog", Title: apptext.T("允许网页操作？"),
			Style: core.Style{Width: a.dialogWidth()}, OnOpenChange: func(open bool, _ base.Reason) {
				if !open {
					a.resolveBrowserApproval(p, false)
				}
			}, Children: details, Footer: []core.Node{
				ui.Button{Text: apptext.T("拒绝"), Variant: ui.ButtonSecondary, TestID: "browser-deny", OnPress: func() { a.resolveBrowserApproval(p, false) }},
				ui.Button{Text: apptext.T("允许一次"), TestID: "browser-approve", OnPress: func() { a.resolveBrowserApproval(p, true) }},
			}}
	})
}
