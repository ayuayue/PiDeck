//go:build !js && !android && !ios

package workbench

import (
	"net/url"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// Reuses the Agent proxy settings; authentication has no separate proxy state.
func (a *app) authProxyGroup() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		address := core.NewSignal(cx, a.cfg.ProxyAgent)
		bypass := core.NewSignal(cx, a.cfg.ProxyBypass)
		failure := core.NewSignal(cx, "")
		saved := core.NewSignal(cx, false)
		lifetime := cx.Context()
		saveSeq := 0
		save := func() {
			proxy := strings.TrimSpace(address.GetUntracked())
			if errText := validateAuthProxy(proxy); errText != "" {
				failure.Set(errText)
				return
			}
			failure.Set("")
			a.cfg.ProxyAgent, a.cfg.ProxyBypass = proxy, strings.TrimSpace(bypass.GetUntracked())
			a.st.change(func(c *config) { c.ProxyAgent, c.ProxyBypass = a.cfg.ProxyAgent, a.cfg.ProxyBypass })
			a.applyProxy()
			saveSeq++
			seq, st := saveSeq, a.st
			configWrites.Add(1)
			go func() {
				defer configWrites.Done()
				err := st.save()
				a.cx.Post(func() {
					if lifetime.Err() != nil || seq != saveSeq {
						return
					}
					if err != nil {
						failure.Set(err.Error())
						return
					}
					saved.Set(true)
				})
			}()
		}
		field := func(value func() string, set func(string), label, placeholder, id string) core.Node {
			return ui.Input{Value: value, OnChange: func(v string) { saveSeq++; set(v); failure.Set(""); saved.Set(false) }, OnSubmit: func(string) { save() }, OnBlur: save,
				Disabled: a.authUI.Busy.Get, Label: apptext.T(label), Placeholder: placeholder, TestID: id,
				Style: core.Style{Width: core.Pt(240), FlexShrink: 1, MinWidth: core.Pt(0)}}
		}
		return setGroup("登录与 Agent 代理",
			setRow("Agent 代理", "登录和之后启动的本机 Agent 共用此设置。留空继承启动环境的代理。", field(address.Get, address.Set, "Agent 代理", "http://127.0.0.1:7890", "auth-proxy-agent")),
			setDivider(),
			setRow("直连名单", "与运行环境页面共用 NO_PROXY。浏览器授权页面使用浏览器自己的网络设置。", field(bypass.Get, bypass.Set, "直连名单", "localhost,127.0.0.1", "auth-proxy-bypass")),
			core.Show{When: func() bool { return failure.Get() != "" }, Then: func(*core.Scope) core.Node {
				return core.Text{ContentFunc: failure.Get, TestID: "auth-proxy-error", Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Danger)}
			}},
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.Button{TextFunc: func() string {
					if saved.Get() {
						return apptext.T("已保存")
					}
					return apptext.T("保存代理")
				}, Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "auth-proxy-save", Disabled: a.authUI.Busy.Get, OnPress: save},
				ui.Text(apptext.T("按回车或移开焦点也会保存；下一次登录生效。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
			}})
	})
}

func validateAuthProxy(value string) string {
	if value == "" {
		return ""
	}
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return apptext.T("请输入完整的 HTTP 或 HTTPS 代理地址，例如 http://127.0.0.1:7890。")
	}
	return ""
}
