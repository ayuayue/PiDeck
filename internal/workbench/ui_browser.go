//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"net/url"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

type browserState struct {
	open    *core.Signal[bool]
	address *core.Signal[string]
	source  *core.Signal[core.WebSource]
	nav     *core.Signal[core.WebNavigation]
	err     *core.Signal[string]
	view    *core.Ref
	owner   *core.Signal[string]
	origin  string
	last    *browserSnapshot
	pending *core.Signal[*browserApproval]
}

func newBrowserState(cx *core.Scope) browserState {
	return browserState{open: core.NewSignal(cx, false), address: core.NewSignal(cx, ""),
		source: core.NewSignal(cx, core.WebSource{}), nav: core.NewSignal(cx, core.WebNavigation{}),
		err: core.NewSignal(cx, ""), view: &core.Ref{}, owner: core.NewSignal(cx, ""),
		pending: core.NewSignal(cx, (*browserApproval)(nil))}
}

func browserURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsAny(raw, "\r\n\t\\") {
		return "", errors.New(apptext.T("请输入有效的 HTTP 或 HTTPS 地址。"))
	}
	// Browsers accept a host, a host with a port, and protocol-relative
	// addresses in their omnibox. Keep that forgiving behaviour while still
	// limiting the embedded view to web pages.
	lower := strings.ToLower(raw)
	switch {
	case strings.HasPrefix(raw, "//"):
		raw = "https:" + raw
	case strings.HasPrefix(lower, "http:"):
		raw = "http://" + strings.TrimPrefix(raw[len("http:"):], "//")
	case strings.HasPrefix(lower, "https:"):
		raw = "https://" + strings.TrimPrefix(raw[len("https:"):], "//")
	case browserHasScheme(raw):
		// Keep an explicit non-HTTP scheme intact so the validation below
		// rejects it instead of turning it into an HTTP host.
	default:
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.Hostname() == "" || u.User != nil || (strings.ToLower(u.Scheme) != "http" && strings.ToLower(u.Scheme) != "https") {
		return "", errors.New(apptext.T("请输入有效的 HTTP 或 HTTPS 地址。"))
	}
	u.Scheme = strings.ToLower(u.Scheme)
	return u.String(), nil
}

// browserHasScheme detects a scheme only when the colon is at the beginning
// of the address. A host:port entry such as "127.0.0.1:8787" must continue
// through the HTTPS defaulting path, while javascript:, data:, and ftp: are
// kept intact so they can be rejected by browserURL.
func browserHasScheme(raw string) bool {
	colon := strings.IndexByte(raw, ':')
	if colon <= 0 {
		return false
	}
	if cut := strings.IndexAny(raw, "/?#"); cut >= 0 && colon > cut {
		return false
	}
	if strings.HasPrefix(raw[colon+1:], "//") {
		return true
	}
	// A numeric suffix is the common host:port form. Keep it as a host even
	// when the hostname has no dot (for example localhost:3000).
	rest := raw[colon+1:]
	if len(rest) > 0 && rest[0] >= '0' && rest[0] <= '9' {
		return false
	}
	for i, r := range raw[:colon] {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (i > 0 && ((r >= '0' && r <= '9') || r == '+' || r == '-' || r == '.')) {
			continue
		}
		return false
	}
	return true
}

func (a *app) navigateBrowser(raw string) {
	u, err := browserURL(raw)
	if err != nil {
		a.browser.err.Set(err.Error())
		return
	}
	a.browser.err.Set("")
	a.browser.address.Set(u)
	old := a.browser.source.GetUntracked()
	a.browser.source.Set(core.WebSrc(u))
	if old.Src == u {
		a.browser.view.Reload()
	}
}

func (a *app) browserCanNavigate() bool {
	_, err := browserURL(a.browser.address.Get())
	return err == nil
}

func (a *app) browserStatusBar() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		b := a.browser
		colors := ui.ColorsOf(cx)
		if message := b.err.Get(); message != "" {
			return core.View{TestID: "browser-error", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8,
				Padding: core.Symmetric(5, 12), Background: ui.Alpha(colors.Danger(), 0.10)}, Children: []core.Node{
				ui.Icon(lucide.TriangleAlert, 14, colors.Danger),
				core.Text{Content: message, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12}, StyleFunc: ui.Colored(colors.Danger)},
				ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "browser-retry",
					Disabled: func() bool { return !a.browserCanNavigate() },
					OnPress:  func() { a.navigateBrowser(b.address.GetUntracked()) }},
			}}
		}
		if b.nav.Get().Loading {
			return core.View{TestID: "browser-loading", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7,
				Padding: core.Symmetric(4, 12), Background: colors.Surface()}, Children: []core.Node{
				ui.Spinner{Size: 11, Label: apptext.T("加载")},
				ui.Text(apptext.T("加载"), 11.5, ui.Regular, colors.Muted),
			}}
		}
		if title := strings.TrimSpace(b.nav.Get().Title); title != "" {
			return core.View{TestID: "browser-page-title", Style: core.Style{Padding: core.Symmetric(4, 12), Background: colors.Surface()}, Children: []core.Node{
				core.Text{Content: title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
			}}
		}
		return nil
	})
}

func (a *app) browserPane() core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		b := a.browser
		colors := ui.ColorsOf(cx)
		syncNav := func(n core.WebNavigation) {
			if b.owner.GetUntracked() != "" && browserOrigin(n.URL) != b.origin {
				a.revokeBrowser()
			}
			// Progress events for the same page cannot overwrite an address
			// the user is in the middle of entering.
			if n.URL != b.nav.GetUntracked().URL {
				if u, err := browserURL(n.URL); err == nil {
					b.address.Set(u)
				}
			}
			b.nav.Set(n)
		}
		return core.View{TestID: "browser-pane", Style: ui.FillRest, StyleFunc: func() core.Style {
			if a.activePane.Get() != paneBrowser {
				return core.Style{Display: core.DisplayNone}
			}
			return core.Style{Background: colors.Background()}
		}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4,
				Padding: core.Symmetric(8, 10), Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}, Children: []core.Node{
				ui.IconButton{Icon: lucide.ArrowLeft, Label: apptext.T("后退"), TestID: "browser-back", OnPress: b.view.GoBack,
					Disabled: func() bool { return !b.nav.Get().CanGoBack }},
				ui.IconButton{Icon: lucide.ArrowRight, Label: apptext.T("前进"), TestID: "browser-forward", OnPress: b.view.GoForward,
					Disabled: func() bool { return !b.nav.Get().CanGoForward }},
				core.Dynamic(func(*core.Scope) core.Node {
					if b.nav.Get().Loading {
						return ui.IconButton{Icon: lucide.X, Label: apptext.T("停止"), TestID: "browser-stop", OnPress: b.view.StopLoading}
					}
					return ui.IconButton{Icon: lucide.RefreshCw, Label: apptext.T("刷新"), TestID: "browser-reload", OnPress: func() { b.err.Set(""); b.view.Reload() }}
				}),
				core.Input{Value: b.address.Get, OnChange: func(value string) {
					b.address.Set(value)
					if b.err.GetUntracked() != "" {
						b.err.Set("")
					}
				},
					OnSubmit: a.navigateBrowser, AutoFocus: b.source.Get().Src == "", KeyboardType: core.KeyboardURL,
					ReturnKeyType: core.ReturnKeyGo, SubmitBehavior: core.SubmitBehaviorSubmit,
					AutoCapitalize: core.AutoCapitalizeNone, NoAutoCorrect: true, AutoComplete: core.AutoCompleteURL,
					Placeholder: apptext.T("输入网址…"), Label: apptext.T("网址"), TestID: "browser-address",
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Height: core.Pt(32), Padding: core.Symmetric(0, 9),
						CornerRadius: ui.RadiusControl, Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text()}},
				ui.Button{Text: apptext.T("打开"), Icon: lucide.ArrowRight, Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "browser-go",
					Disabled: func() bool { return strings.TrimSpace(b.address.Get()) == "" }, OnPress: func() { a.navigateBrowser(b.address.GetUntracked()) }},
				ui.IconButton{Icon: lucide.ExternalLink, Label: apptext.T("在浏览器打开"), TestID: "browser-external",
					Disabled: func() bool { _, err := browserURL(b.nav.Get().URL); return err != nil }, OnPress: func() {
						if u, err := browserURL(b.nav.GetUntracked().URL); err == nil {
							a.cx.OpenURL(u, nil)
						}
					}},
			}},
			a.browserShareBar(),
			a.sharedBrowserComposer(),
			a.browserStatusBar(),
			core.Show{When: func() bool { return b.source.Get().Src != "" }, Then: func(cx *core.Scope) core.Node {
				return core.WebView{SourceFunc: b.source.Get, Ref: b.view, Incognito: true, PinchZoom: true, BackForwardGestures: true,
					OnLoadStart: func(n core.WebNavigation) { b.err.Set(""); syncNav(n) }, OnNavigationStateChange: syncNav, OnLoad: syncNav,
					OnError: func(err error) { b.err.Set(err.Error()) }, Style: ui.FillRest, Label: apptext.T("网页"), TestID: "browser-webview"}
			}, Else: func(cx *core.Scope) core.Node {
				return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
					Children: []core.Node{ui.Icon(lucide.Globe, 30, colors.Faint), ui.Text(apptext.T("输入网址打开网页"), 13, ui.Regular, colors.Muted)}}
			}},
		}}
	})
}
