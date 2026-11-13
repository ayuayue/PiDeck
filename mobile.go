package main

// The phone build: it connects to a desktop PiDeck Lite server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_LITE_MOBILE=1 for a preview on a desktop).

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
)

// mobileMode is the build the window should show.
func mobileMode() bool {
	if os.Getenv("PIDECK_LITE_MOBILE") == "1" {
		return true
	}
	return runtime.GOOS == "ios" || runtime.GOOS == "android"
}

// mobileSaved is the last connection the phone used.
type mobileSaved struct {
	Server string `json:"server"`
	Token  string `json:"token"`
}

type mobileApp struct {
	cx *core.Scope

	server *core.Signal[string]
	token  *core.Signal[string]
	busy   *core.Signal[bool]
	err    *core.Signal[string]

	connected  *core.Signal[bool]
	serverName *core.Signal[string]
	state      *core.Signal[remoteWireSnapshot]

	active         *core.Signal[string]
	activeTitle    *core.Signal[string]
	messages       *core.Signal[[]remoteWireMessage]
	transcriptErr  *core.Signal[string]
	transcriptBusy *core.Signal[bool]

	client *remoteClient
	gen    int

	// query filters the session list, findText the open transcript.
	query      *core.Signal[string]
	searchOpen *core.Signal[bool]
	findOpen   *core.Signal[bool]
	findText   *core.Signal[string]

	// draft is the composer's text; sending covers one request in flight.
	draft   *core.Signal[string]
	sending *core.Signal[bool]
	running *core.Signal[bool]

	// actionID is the session whose action sheet is open, renameID the one
	// being renamed, newOpen the project chooser.
	actionID   *core.Signal[string]
	deleteID   *core.Signal[string]
	renameID   *core.Signal[string]
	renameText *core.Signal[string]
	newOpen    *core.Signal[bool]
	creating   *core.Signal[bool]

	// options are the open session's models and thinking levels, shown in
	// the sheet over optionsOpen.
	options     *core.Signal[remoteWireOptions]
	optionsOpen *core.Signal[bool]

	stateLoading      bool
	transcriptLoading bool
	refreshing        *core.Signal[bool]
}

// newMobileApp builds the phone's state and reconnects to the last server.
func newMobileApp(cx *core.Scope) *mobileApp {
	cx.SetAppearance(core.AppearanceSystem)
	cx.SetTheme(pideckTheme())
	a := &mobileApp{
		cx:             cx,
		server:         core.NewSignal(cx, ""),
		token:          core.NewSignal(cx, ""),
		busy:           core.NewSignal(cx, false),
		err:            core.NewSignal(cx, ""),
		connected:      core.NewSignal(cx, false),
		serverName:     core.NewSignal(cx, "PiDeck Lite"),
		state:          core.NewSignalFunc(cx, remoteWireSnapshot{}, nil),
		active:         core.NewSignal(cx, ""),
		activeTitle:    core.NewSignal(cx, ""),
		messages:       core.NewSignalFunc(cx, []remoteWireMessage(nil), nil),
		transcriptErr:  core.NewSignal(cx, ""),
		transcriptBusy: core.NewSignal(cx, false),
		refreshing:     core.NewSignal(cx, false),
		query:          core.NewSignal(cx, ""),
		searchOpen:     core.NewSignal(cx, false),
		findOpen:       core.NewSignal(cx, false),
		findText:       core.NewSignal(cx, ""),
		draft:          core.NewSignal(cx, ""),
		sending:        core.NewSignal(cx, false),
		running:        core.NewSignal(cx, false),
		actionID:       core.NewSignal(cx, ""),
		deleteID:       core.NewSignal(cx, ""),
		renameID:       core.NewSignal(cx, ""),
		renameText:     core.NewSignal(cx, ""),
		newOpen:        core.NewSignal(cx, false),
		creating:       core.NewSignal(cx, false),
		options:        core.NewSignalFunc(cx, remoteWireOptions{}, nil),
		optionsOpen:    core.NewSignal(cx, false),
	}
	if saved := loadMobileSaved(cx); saved.Server != "" {
		a.server.Set(saved.Server)
		a.token.Set(saved.Token)
		a.connect()
	}
	cx.OnBackPress(func() bool {
		if a.active.GetUntracked() != "" {
			a.closeSession()
			return true
		}
		return false
	})
	return a
}

// view is the whole phone screen, with the sheets over it.
func (a *mobileApp) view() core.Node {
	return core.View{Style: ui.FillRest, Children: []core.Node{
		core.Dynamic(func(cx *core.Scope) core.Node {
			if a.connected.Get() {
				if a.active.Get() != "" {
					return a.transcriptView(cx)
				}
				return a.sessionsView(cx)
			}
			return a.connectView(cx)
		}),
		a.actionSheet(),
		a.renameSheet(),
		a.newSessionSheet(),
		a.optionsSheet(),
	}}
}

// connectView asks for the desktop's link and token.
func (a *mobileApp) connectView(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	field := func(label, placeholder, testID string, value *core.Signal[string], submit func()) core.Node {
		return core.View{Style: core.Style{Gap: 5}, Children: []core.Node{
			ui.Text(label, 11, ui.Medium, colors.Muted),
			core.Input{
				Value: value.Get, OnChange: value.Set, Placeholder: placeholder, Label: label, TestID: testID,
				OnSubmit: func(string) { submit() },
				Style:    core.Style{Height: core.Pt(44), Padding: core.Symmetric(0, 12), FontSize: 14, Color: colors.Text()},
				StyleFunc: func() core.Style {
					return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 10,
						PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
				},
			},
		}}
	}
	card := core.View{StyleFunc: func() core.Style {
		return core.Style{Gap: 12, Padding: core.All(16), CornerRadius: 14, Background: colors.Surface(),
			BorderWidth: 1, BorderColor: colors.Border()}
	}, Children: []core.Node{
		field("连接地址", "http://192.168.1.8:8787/?token=…", "mobile-server", a.server, a.connect),
		field("访问令牌", "粘贴电脑端显示的令牌", "mobile-token", a.token, a.connect),
		core.Show{When: func() bool { return a.err.Get() != "" }, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, Gap: 6, Padding: core.Symmetric(8, 9), CornerRadius: 8,
				Background: ui.Alpha(colors.Danger(), 0.08)}, Children: []core.Node{
				ui.Icon(lucide.TriangleAlert, 13, colors.Danger),
				core.Text{ContentFunc: a.err.Get, MaxLines: 4, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5, LineHeight: 17},
					StyleFunc: ui.Colored(colors.Danger)},
			}}
		}},
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
			core.Dynamic(func(*core.Scope) core.Node {
				if a.busy.Get() {
					return ui.Spinner{Size: 14, Label: "连接中"}
				}
				return nil
			}),
			ui.Button{Text: "连接", Variant: ui.ButtonPrimary, Size: ui.SizeLarge, Flex: 1, TestID: "mobile-connect",
				Disabled: func() bool { return a.busy.Get() }, OnPress: a.connect},
		}},
	}}
	column := core.View{Style: core.Style{Width: core.Pct(100), MaxWidth: core.Pt(480), Gap: 16}, Children: []core.Node{
		core.Image{Source: core.ImageSource{Data: logoPNG}, ResizeMode: core.Contain, Label: "PiDeck",
			Style: core.Style{Width: core.Pt(64), Height: core.Pt(64), CornerRadius: 18, AlignSelf: core.AlignCenter}},
		core.View{Style: core.Style{Gap: 4, AlignItems: core.AlignCenter}, Children: []core.Node{
			ui.Text("PiDeck Lite", 24, ui.Bold, colors.Text),
			ui.Text("连接电脑上的会话", 13, ui.Regular, colors.Muted),
		}},
		card,
		core.Text{Content: "在电脑端打开 设置 → 远程，启用后复制连接链接；手机和电脑需要在同一局域网、Tailscale 或 EasyTier 网络里。",
			Style: core.Style{FontSize: 11, LineHeight: 17, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Faint)},
	}}
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0),
		PaddingEnv: core.EnvEdges{Top: core.EnvSafeArea, Right: core.EnvSafeArea, Left: core.EnvSafeArea, Bottom: core.EnvKeyboard}},
		Children: []core.Node{core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, Padding: core.All(24), Gap: 16, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
				Children: []core.Node{column}},
		}}}}
}

// connect opens the saved or entered server.
func (a *mobileApp) connect() {
	if a.busy.GetUntracked() {
		return
	}
	client, token, err := newRemoteClient(a.server.GetUntracked(), strings.TrimSpace(a.token.GetUntracked()))
	if err != nil {
		a.err.Set(err.Error())
		return
	}
	if token == "" {
		a.err.Set("请填写访问令牌，或粘贴完整的连接链接")
		return
	}
	a.busy.Set(true)
	a.err.Set("")
	go func() {
		ping, err := client.ping()
		var snap remoteWireSnapshot
		if err == nil {
			snap, err = client.state()
		}
		a.cx.Post(func() {
			a.busy.Set(false)
			if err != nil {
				a.err.Set(remoteErrorText(err))
				return
			}
			a.client = client
			a.server.Set(client.base)
			a.token.Set(token)
			a.serverName.Set(mobileServerName(ping, snap))
			a.state.Set(snap)
			a.connected.Set(true)
			a.err.Set("")
			saveMobileSaved(a.cx, mobileSaved{Server: client.base, Token: token})
			a.startPolling()
		})
	}()
}

func mobileServerName(ping remotePing, snap remoteWireSnapshot) string {
	host := strings.TrimSpace(ping.Host)
	if host == "" {
		host = strings.TrimSpace(snap.Host)
	}
	if host == "" {
		return "电脑"
	}
	return host
}

// disconnect leaves the server and stops polling.
func (a *mobileApp) disconnect() { a.disconnectWith("") }

func (a *mobileApp) disconnectWith(message string) {
	a.gen++
	a.client = nil
	a.connected.Set(false)
	a.active.Set("")
	a.messages.Set(nil)
	a.transcriptErr.Set("")
	a.transcriptBusy.Set(false)
	a.state.Set(remoteWireSnapshot{})
	if message != "" {
		a.err.Set(message)
	}
}

// startPolling keeps the project list and the open transcript current.
func (a *mobileApp) startPolling() {
	a.gen++
	gen := a.gen
	var loop func()
	loop = func() {
		if gen != a.gen || !a.connected.GetUntracked() {
			return
		}
		a.refreshState()
		if a.active.GetUntracked() != "" {
			a.refreshTranscript()
			if a.optionsOpen.GetUntracked() {
				a.loadOptions(a.active.GetUntracked())
			}
		}
		wait := 2500 * time.Millisecond
		if a.running.GetUntracked() {
			wait = 1200 * time.Millisecond
		}
		a.cx.AfterFunc(wait, loop)
	}
	loop()
}

// refreshState rereads the desktop's projects and sessions.
func (a *mobileApp) refreshState() {
	client := a.client
	if client == nil || a.stateLoading {
		return
	}
	a.stateLoading = true
	a.refreshing.Set(true)
	go func() {
		snap, err := client.state()
		a.cx.Post(func() {
			a.stateLoading = false
			a.refreshing.Set(false)
			if err != nil {
				if errors.Is(err, errRemoteAuth) {
					a.disconnectWith(remoteErrorText(err))
				} else {
					a.err.Set(remoteErrorText(err))
				}
				return
			}
			a.state.Set(snap)
			a.err.Set("")
		})
	}()
}

// sessionsView lists the desktop's projects and their sessions.
func (a *mobileApp) sessionsView(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0),
		PaddingEnv: core.EnvAll(core.EnvSafeArea)}, Children: []core.Node{
		core.Dynamic(func(cx *core.Scope) core.Node {
			if a.searchOpen.Get() {
				return a.searchHeader(cx)
			}
			return a.mobileHeader(cx, a.serverName.Get(), a.server.Get(), false,
				a.pressIcon(lucide.Search, "搜索会话", 34, 16, nil, func() { a.searchOpen.Set(true) }, "mobile-search"),
				a.pressIcon(lucide.Plus, "新建会话", 34, 18, nil, a.startNewSession, "mobile-new"),
				a.pressIcon(lucide.RefreshCw, "刷新", 34, 16, nil, a.refreshState, "mobile-refresh"),
				a.pressIcon(lucide.Unplug, "断开连接", 34, 16, nil, func() { a.disconnect() }, "mobile-disconnect"),
			)
		}),
		core.Show{When: func() bool { return a.err.Get() != "" }, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, Gap: 6, Padding: core.Symmetric(8, 14)},
				StyleFunc: func() core.Style { return core.Style{Background: ui.Alpha(colors.Danger(), 0.07)} },
				Children: []core.Node{
					ui.Icon(lucide.TriangleAlert, 12, colors.Danger),
					core.Text{ContentFunc: a.err.Get, MaxLines: 2, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11},
						StyleFunc: ui.Colored(colors.Danger)},
				}}
		}},
		core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.Dynamic(func(cx *core.Scope) core.Node {
				snap := a.state.Get()
				query := strings.ToLower(strings.TrimSpace(a.query.Get()))
				var sections []core.Node
				for _, project := range snap.Projects {
					p := project
					matched := make([]remoteWireSession, 0, len(p.Sessions))
					for _, session := range p.Sessions {
						if query == "" || strings.Contains(strings.ToLower(session.Title), query) {
							matched = append(matched, session)
						}
					}
					if len(matched) == 0 {
						continue
					}
					rows := make([]core.Node, 0, len(matched))
					for _, session := range matched {
						rows = append(rows, a.mobileSessionRow(cx, session))
					}
					sections = append(sections, core.View{Style: core.Style{Gap: 2, Margin: core.Edges{Bottom: 14}}, Children: []core.Node{
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Padding: core.Symmetric(8, 16)}, Children: []core.Node{
							ui.Icon(lucide.Folder, 13, colors.Muted),
							core.Text{Content: p.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
								Style: core.Style{FlexGrow: 1, FontSize: 12, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)},
							ui.Text(fmt.Sprint(len(matched)), 10, ui.Regular, colors.Faint),
						}},
						core.View{Style: core.Style{Gap: 1}, Children: rows},
					}})
				}
				switch {
				case len(sections) > 0:
				case query != "":
					sections = append(sections, core.View{Style: core.Style{Padding: core.All(32), AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
						ui.Icon(lucide.SearchX, 28, colors.Faint),
						ui.Text("没有匹配的会话", 13, ui.Medium, colors.Muted),
						ui.Text("换个词试试，或者新建一个会话。", 11.5, ui.Regular, colors.Faint),
					}})
				default:
					sections = append(sections, core.View{Style: core.Style{Padding: core.All(32), AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
						ui.Icon(lucide.Laptop, 30, colors.Faint),
						ui.Text("电脑上还没有会话", 13, ui.Medium, colors.Muted),
						ui.Text("点右上角的新建，直接在手机上开始。", 11.5, ui.Regular, colors.Faint),
						core.View{Style: core.Style{Margin: core.Edges{Top: 6}}, Children: []core.Node{
							ui.Button{Text: "新建会话", Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-new-empty",
								OnPress: a.startNewSession},
						}},
					}})
				}
				return core.View{Style: core.Style{Padding: core.Edges{Top: 10, Bottom: 24, Left: 8, Right: 8}, Gap: 0}, Children: sections}
			}),
		}},
	}}
}

// mobileSessionRow is one session in the phone's list.
func (a *mobileApp) mobileSessionRow(cx *core.Scope, s remoteWireSession) core.Node {
	colors := ui.ColorsOf(cx)
	tone := remoteStatusColor(s.Status, colors)
	return core.View{OnPress: func(core.PressEvent) { a.openSession(s.ID, s.Title) },
		Role: core.RoleButton, Label: s.Title, TestID: "mobile-session",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(52), Padding: core.Edges{Left: 8, Right: 2},
				CornerRadius: 9, Transition: pressMotion, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			core.View{Style: core.Style{Width: core.Pt(7), Height: core.Pt(7), CornerRadius: 4, Background: tone, FlexShrink: 0}},
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
				core.Text{Content: s.Title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 14, LineHeight: 19}, StyleFunc: ui.Colored(colors.Text)},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: []core.Node{
					core.Text{Content: mobileWhen(s.Updated), MaxLines: 1, Style: core.Style{FontSize: 10.5},
						StyleFunc: ui.Colored(colors.Faint)},
					core.Show{When: func() bool { return s.Running }, Then: func(*core.Scope) core.Node {
						return ui.Text("运行中", 10, ui.Medium, colors.Accent)
					}},
				}},
			}},
			core.Show{When: func() bool { return s.External }, Then: func(*core.Scope) core.Node {
				return core.View{Style: core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 4, Background: colors.Inset()},
					Children: []core.Node{ui.Text("pi", 9, ui.Medium, colors.Faint)}}
			}},
			core.Show{When: func() bool { return s.Pinned }, Then: func(*core.Scope) core.Node {
				return ui.Icon(lucide.Pin, 12, colors.Faint)
			}},
			a.pressIcon(lucide.Ellipsis, "会话操作", 32, 16, nil, func() { a.actionID.Set(s.ID) }, "mobile-session-actions"),
		}}
}

func remoteStatusColor(status string, colors ui.Colors) core.Color {
	switch status {
	case "running":
		return thinking
	case "waiting":
		return warning
	case "failed":
		return colors.Danger()
	case "starting":
		return colors.Accent()
	}
	return colors.Faint()
}

func mobileWhen(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return whenText(time.UnixMilli(ms), time.Now())
}

// pressIcon is a phone toolbar action with a springing press.
func (a *mobileApp) pressIcon(icon func() *core.SVG, label string, size, iconSize core.Points, disabled func() bool,
	press func(), testID string) core.Node {
	colors := ui.ColorsOf(a.cx)
	return ui.Press{
		OnPress: press, Disabled: disabled, Scale: 0.88, Role: core.RoleButton, Label: label, TestID: testID,
		Style: core.Style{Width: core.Pt(size), Height: core.Pt(size), AlignItems: core.AlignCenter,
			JustifyContent: core.JustifyCenter, CornerRadius: 8},
		StyleFunc: func() core.Style {
			return core.Style{Transition: pressMotion, Hover: &core.Style{Background: colors.Hover()},
				Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{ui.Icon(icon, iconSize, colors.Muted)},
	}
}

// mobileHeader is the bar over the list and the transcript; actions sit at
// its end.
func (a *mobileApp) mobileHeader(cx *core.Scope, title, subtitle string, back bool, actions ...core.Node) core.Node {
	colors := ui.ColorsOf(cx)
	var leading []core.Node
	if back {
		leading = append(leading, a.pressIcon(lucide.ChevronLeft, "返回", 36, 20, nil, a.closeSession, "mobile-back"))
	}
	children := append(leading, core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
		core.Text{Content: title, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
			Style: core.Style{FontSize: 15, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)},
		core.Show{When: func() bool { return subtitle != "" }, Then: func(*core.Scope) core.Node {
			return core.Text{Content: subtitle, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
		}},
	}})
	children = append(children, core.Dynamic(func(*core.Scope) core.Node {
		if a.transcriptBusy.Get() || a.refreshing.Get() {
			return ui.Spinner{Size: 12, Label: "刷新"}
		}
		return nil
	}))
	children = append(children, actions...)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(52), Padding: core.Symmetric(0, 12),
			Background: colors.Surface(), Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}
	}, Children: children}
}

// searchHeader replaces the title with a search field over the list.
func (a *mobileApp) searchHeader(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(52), Padding: core.Symmetric(0, 8),
			Background: colors.Surface(), Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}
	}, Children: []core.Node{
		a.pressIcon(lucide.X, "关闭搜索", 34, 16, nil, func() {
			a.searchOpen.Set(false)
			a.query.Set("")
		}, "mobile-search-close"),
		core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
			core.Input{
				Value: a.query.Get, OnChange: a.query.Set, Placeholder: "搜索会话标题", Label: "搜索会话", TestID: "mobile-search-input",
				Style: core.Style{Height: core.Pt(38), Padding: core.Symmetric(0, 10), FontSize: 14, Color: colors.Text(),
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 9,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection},
			},
		}},
	}}
}

// openSession downloads a session's transcript.
func (a *mobileApp) openSession(id, title string) {
	a.active.Set(id)
	a.activeTitle.Set(title)
	a.messages.Set(nil)
	a.running.Set(false)
	a.transcriptErr.Set("")
	a.options.Set(remoteWireOptions{})
	a.refreshTranscript()
	a.loadOptions(id)
}

func (a *mobileApp) closeSession() {
	a.active.Set("")
	a.messages.Set(nil)
	a.running.Set(false)
	a.findOpen.Set(false)
	a.findText.Set("")
	a.transcriptErr.Set("")
}

func (a *mobileApp) refreshTranscript() {
	client := a.client
	id := a.active.GetUntracked()
	if client == nil || id == "" || a.transcriptLoading {
		return
	}
	a.transcriptLoading = true
	a.transcriptBusy.Set(true)
	go func() {
		t, err := client.transcript(id)
		a.cx.Post(func() {
			a.transcriptLoading = false
			a.transcriptBusy.Set(false)
			if a.active.GetUntracked() != id {
				return
			}
			if err != nil {
				if errors.Is(err, errRemoteAuth) {
					a.disconnectWith(remoteErrorText(err))
				} else {
					a.transcriptErr.Set(remoteErrorText(err))
				}
				return
			}
			a.activeTitle.Set(t.Title)
			a.messages.Set(t.Messages)
			a.running.Set(t.Running)
			a.transcriptErr.Set(t.Error)
		})
	}()
}

// transcriptView shows the messages of one session, with the composer
// under them.
func (a *mobileApp) transcriptView(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0),
		PaddingEnv: core.EnvAll(core.EnvSafeArea)}, Children: []core.Node{
		a.mobileHeader(cx, a.activeTitle.Get(), "", true,
			a.pressIcon(lucide.Search, "搜索会话内容", 34, 16, nil, func() {
				a.findText.Set("")
				a.findOpen.Update(func(v bool) bool { return !v })
			}, "mobile-find"),
			a.pressIcon(lucide.RefreshCw, "刷新", 34, 16, nil, a.refreshTranscript, "mobile-refresh"),
		),
		core.Show{When: a.findOpen.Get, Then: func(cx *core.Scope) core.Node { return a.findBar(cx) }},
		core.Show{When: func() bool { return a.transcriptErr.Get() != "" }, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, Gap: 6, Padding: core.Symmetric(8, 14)},
				StyleFunc: func() core.Style { return core.Style{Background: ui.Alpha(colors.Danger(), 0.07)} },
				Children: []core.Node{
					ui.Icon(lucide.TriangleAlert, 12, colors.Danger),
					core.Text{ContentFunc: a.transcriptErr.Get, MaxLines: 3, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11},
						StyleFunc: ui.Colored(colors.Danger)},
				}}
		}},
		core.Dynamic(func(cx *core.Scope) core.Node {
			msgs := a.messages.Get()
			if a.transcriptBusy.Get() && len(msgs) == 0 {
				return core.View{Style: core.Style{Padding: core.All(18), Gap: 14}, Children: []core.Node{
					ui.Skeleton{Lines: 3, Avatar: true, Label: "正在读取会话"},
					ui.Skeleton{Lines: 4, Avatar: true, Label: "正在读取会话"},
				}}
			}
			query := strings.ToLower(strings.TrimSpace(a.findText.Get()))
			matches := 0
			if query != "" {
				kept := make([]remoteWireMessage, 0, len(msgs))
				for _, m := range msgs {
					if strings.Contains(strings.ToLower(m.Text), query) {
						kept = append(kept, m)
					}
				}
				matches = len(kept)
				msgs = kept
			}
			var rows []core.Node
			if query != "" {
				rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Icon(lucide.Search, 12, colors.Faint),
					ui.Text(fmt.Sprintf("匹配 %d 条", matches), 11, ui.Medium, colors.Faint),
				}})
			}
			for _, m := range msgs {
				rows = append(rows, mobileMessage(cx, m))
			}
			if len(rows) == 0 || (query != "" && matches == 0) {
				empty := "这个会话还没有消息"
				if query != "" {
					empty = "没有匹配的消息"
				}
				rows = append(rows, core.View{Style: core.Style{Padding: core.All(32), AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
					ui.Icon(lucide.MessageSquare, 26, colors.Faint),
					ui.Text(empty, 12.5, ui.Regular, colors.Muted),
				}})
			}
			return core.Scroll{Style: ui.FillRest, Children: []core.Node{
				core.View{Selectable: true, Style: core.Style{Padding: core.Edges{Top: 14, Bottom: 20, Left: 14, Right: 14}, Gap: 12}, Children: rows},
			}}
		}),
		a.sessionBar(cx),
		a.composer(cx),
	}}
}

// findBar searches the loaded messages of the open session.
func (a *mobileApp) findBar(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(6, 10),
			Background: colors.Surface(), Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}
	}, Children: []core.Node{
		core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
			core.Input{Value: a.findText.Get, OnChange: a.findText.Set, Placeholder: "在这个会话里搜索", Label: "搜索会话内容", TestID: "mobile-find-input",
				Style: core.Style{Height: core.Pt(36), Padding: core.Symmetric(0, 10), FontSize: 13.5, Color: colors.Text(),
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 9,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}},
		}},
		a.pressIcon(lucide.X, "结束搜索", 30, 14, nil, func() {
			a.findOpen.Set(false)
			a.findText.Set("")
		}, "mobile-find-close"),
	}}
}

// composer is the message bar under a transcript.
func (a *mobileApp) composer(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignEnd, Gap: 8, Padding: core.Symmetric(8, 10),
			PaddingEnv: core.EnvEdges{Bottom: core.EnvKeyboard},
			Background: colors.Surface(), Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Line()}}
	}, Children: []core.Node{
		core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), MinHeight: core.Pt(42)}, Children: []core.Node{
			core.Input{Value: a.draft.Get, OnChange: a.draft.Set, Placeholder: "发消息给 pi…", Label: "消息", TestID: "mobile-draft",
				OnSubmit: func(string) { a.sendMessage() },
				Style: core.Style{Height: core.Pt(42), Padding: core.Symmetric(0, 12), FontSize: 14, Color: colors.Text(),
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 12,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}},
		}},
		core.Dynamic(func(*core.Scope) core.Node {
			if a.running.Get() {
				return a.pressIcon(lucide.Square, "停止这一轮", 40, 15, nil, a.stopTurn, "mobile-stop")
			}
			empty := func() bool { return strings.TrimSpace(a.draft.Get()) == "" }
			return ui.Press{OnPress: a.sendMessage, Disabled: empty, Scale: 0.9, Role: core.RoleButton, Label: "发送", TestID: "mobile-send",
				StyleFunc: func() core.Style {
					st := core.Style{Width: core.Pt(40), Height: core.Pt(40), CornerRadius: 20, AlignItems: core.AlignCenter,
						JustifyContent: core.JustifyCenter, Background: colors.Light(), Transition: pressMotion}
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
				})}}
		}),
	}}
}

// sendMessage hands the composer's text to the desktop.
func (a *mobileApp) sendMessage() {
	id := a.active.GetUntracked()
	text := strings.TrimSpace(a.draft.GetUntracked())
	client := a.client
	if id == "" || text == "" || client == nil || a.sending.GetUntracked() {
		return
	}
	a.sending.Set(true)
	a.draft.Set("")
	a.transcriptErr.Set("")
	go func() {
		err := client.prompt(id, text)
		a.cx.Post(func() {
			a.sending.Set(false)
			if err != nil {
				a.draft.Set(text)
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

// mobileMessage draws one line of a remote transcript.
func mobileMessage(cx *core.Scope, m remoteWireMessage) core.Node {
	colors := ui.ColorsOf(cx)
	switch m.Role {
	case "user":
		return core.View{Style: core.Style{Direction: core.Row, JustifyContent: core.JustifyEnd}, Children: []core.Node{
			core.View{Style: core.Style{MaxWidth: core.Pct(86), Padding: core.Symmetric(9, 13), CornerRadius: 15,
				Background: colors.Light()}, Children: []core.Node{
				core.Text{Content: m.Text, Style: core.Style{FontSize: 14, LineHeight: 20}, StyleFunc: ui.Colored(colors.OnLight)},
			}},
		}}
	case "thinking":
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 7, Padding: core.Symmetric(7, 10), CornerRadius: 10,
			Background: colors.Inset()}, Children: []core.Node{
			ui.Icon(lucide.Brain, 13, colors.Faint),
			core.Text{Content: m.Text, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12, LineHeight: 18},
				StyleFunc: ui.Colored(colors.Muted)},
		}}
	case "tool":
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Padding: core.Symmetric(2, 4)}, Children: []core.Node{
			ui.Icon(lucide.Terminal, 12, colors.Faint),
			core.Text{Content: m.Text, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: ui.Mono, FontSize: 10.5, LineHeight: 16},
				StyleFunc: ui.Colored(colors.Faint)},
		}}
	case "note":
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, AlignSelf: core.AlignCenter}, Children: []core.Node{
			ui.Icon(lucide.Info, 11, colors.Faint),
			core.Text{Content: m.Text, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
		}}
	case "error":
		return core.View{Style: core.Style{Padding: core.Symmetric(9, 11), CornerRadius: 10, Background: ui.Alpha(colors.Danger(), 0.08)}, Children: []core.Node{
			core.Text{Content: m.Text, Style: core.Style{FontSize: 12, LineHeight: 18}, StyleFunc: ui.Colored(colors.Danger)},
		}}
	}
	return markdownView(m.Text, func() bool { return false }, false)
}

// findSession looks a session up in the last snapshot.
func (a *mobileApp) findSession(id string) (remoteWireSession, bool) {
	for _, p := range a.state.GetUntracked().Projects {
		for _, s := range p.Sessions {
			if s.ID == id {
				return s, true
			}
		}
	}
	return remoteWireSession{}, false
}

// sheetRow is one action in a phone sheet.
func (a *mobileApp) sheetRow(icon func() *core.SVG, label string, tone func() core.Color, press func(), testID string) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{OnPress: func(core.PressEvent) { press() }, Role: core.RoleButton, Label: label, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(48), Padding: core.Symmetric(0, 8),
				CornerRadius: 8, Transition: pressMotion, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{ui.Icon(icon, 17, tone), ui.Text(label, 14.5, ui.Medium, tone)}}
}

// actionSheet is a session's operations: rename, pin, delete.
func (a *mobileApp) actionSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.actionID.Get() != "" },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.actionID.Set("")
			}
		},
		TestID: "mobile-actions",
		Style:  core.Style{Width: core.Pt(340)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			id := a.actionID.Get()
			s, ok := a.findSession(id)
			if !ok {
				return nil
			}
			pinIcon, pinLabel := lucide.Pin, "置顶"
			if s.Pinned {
				pinIcon, pinLabel = lucide.PinOff, "取消置顶"
			}
			rows := []core.Node{
				core.View{Style: core.Style{Padding: core.Symmetric(4, 8), Gap: 2}, Children: []core.Node{
					core.Text{Content: s.Title, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 14, FontWeight: ui.Semibold, LineHeight: 20}, StyleFunc: ui.Colored(colors.Text)},
					ui.Text(mobileWhen(s.Updated), 10.5, ui.Regular, colors.Faint),
				}},
				a.sheetRow(lucide.SquarePen, "重命名", colors.Text, func() {
					a.actionID.Set("")
					a.renameText.Set(s.Title)
					a.renameID.Set(id)
				}, "mobile-act-rename"),
				a.sheetRow(pinIcon, pinLabel, colors.Text, func() {
					a.actionID.Set("")
					a.setPinned(id, !s.Pinned)
				}, "mobile-act-pin"),
			}
			if s.External {
				rows = append(rows, core.Text{Content: "pi 自己的会话只能在电脑上删除",
					Style: core.Style{FontSize: 11, Padding: core.Symmetric(8, 8)}, StyleFunc: ui.Colored(colors.Faint)})
			} else {
				rows = append(rows, a.sheetRow(lucide.Trash, "删除会话", colors.Danger, func() {
					a.actionID.Set("")
					a.deleteID.Set(id)
				}, "mobile-act-delete"))
			}
			return core.View{Style: core.Style{Gap: 2}, Children: rows}
		})},
	}
}

// renameSheet renames the session in renameID.
func (a *mobileApp) renameSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.renameID.Get() != "" },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.renameID.Set("")
			}
		},
		Title:  "重命名会话",
		TestID: "mobile-rename",
		Style:  core.Style{Width: core.Pt(340)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			return core.Input{Value: a.renameText.Get, OnChange: a.renameText.Set, Label: "会话名字", TestID: "mobile-rename-input",
				Placeholder: "给这个会话起个名字", OnSubmit: func(string) { a.saveRename() },
				Style: core.Style{Height: core.Pt(42), Padding: core.Symmetric(0, 10), FontSize: 14, Color: colors.Text(),
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 9,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}}
		})},
		Footer: []core.Node{
			ui.Button{Text: "保存", Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-rename-save", OnPress: a.saveRename},
			ui.Button{Text: "取消", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.renameID.Set("") }},
		},
	}
}

// deleteSheet confirms deleting a session from the phone.
func (a *mobileApp) deleteSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.deleteID.Get() != "" },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.deleteID.Set("")
			}
		},
		Title:       "删除会话",
		Description: "会话文件会移到电脑数据目录的 trash 里，需要时可以找回。",
		TestID:      "mobile-delete",
		Style:       core.Style{Width: core.Pt(340)},
		Footer: []core.Node{
			ui.Button{Text: "删除", Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-delete-yes",
				OnPress: func() { a.deleteSession(a.deleteID.GetUntracked()) }},
			ui.Button{Text: "取消", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.deleteID.Set("") }},
		},
	}
}

// newSessionSheet picks the project a new session belongs to.
func (a *mobileApp) newSessionSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.newOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.newOpen.Set(false)
			}
		},
		Title:  "在哪个项目里新建",
		TestID: "mobile-new",
		Style:  core.Style{Width: core.Pt(340)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			var rows []core.Node
			for _, p := range a.state.Get().Projects {
				project := p
				rows = append(rows, a.sheetRow(lucide.Folder, project.Name, colors.Text, func() {
					a.newOpen.Set(false)
					a.createSessionIn(project.Path)
				}, "mobile-new-project"))
			}
			if len(rows) == 0 {
				rows = append(rows, core.Text{Content: "电脑上还没有项目", Style: core.Style{FontSize: 12, Padding: core.Symmetric(8, 6)},
					StyleFunc: ui.Colored(colors.Faint)})
			}
			return core.View{Style: core.Style{Gap: 2}, Children: rows}
		})},
	}
}

// startNewSession creates a session, asking for the project when there are
// several.
func (a *mobileApp) startNewSession() {
	if a.creating.GetUntracked() {
		return
	}
	projects := a.state.GetUntracked().Projects
	switch len(projects) {
	case 0:
		a.err.Set("电脑上还没有项目，先在电脑端添加一个工作区")
	case 1:
		a.createSessionIn(projects[0].Path)
	default:
		a.newOpen.Set(true)
	}
}

// createSessionIn starts a session in one project and opens it.
func (a *mobileApp) createSessionIn(path string) {
	client := a.client
	if client == nil || a.creating.GetUntracked() {
		return
	}
	a.creating.Set(true)
	go func() {
		id, title, err := client.createSession(path)
		a.cx.Post(func() {
			a.creating.Set(false)
			if err != nil {
				a.err.Set(remoteErrorText(err))
				return
			}
			a.err.Set("")
			a.openSession(id, title)
			a.refreshState()
		})
	}()
}

// saveRename applies the rename sheet.
func (a *mobileApp) saveRename() {
	id := a.renameID.GetUntracked()
	name := strings.TrimSpace(a.renameText.GetUntracked())
	client := a.client
	if id == "" || name == "" || client == nil {
		return
	}
	a.renameID.Set("")
	go func() {
		err := client.rename(id, name)
		a.cx.Post(func() {
			if err != nil {
				a.err.Set(remoteErrorText(err))
				return
			}
			a.err.Set("")
			if a.active.GetUntracked() == id {
				a.activeTitle.Set(name)
			}
			a.refreshState()
		})
	}()
}

// setPinned pins or unpins a session.
func (a *mobileApp) setPinned(id string, pinned bool) {
	client := a.client
	if client == nil || id == "" {
		return
	}
	go func() {
		err := client.pin(id, pinned)
		a.cx.Post(func() {
			if err != nil {
				a.err.Set(remoteErrorText(err))
				return
			}
			a.err.Set("")
			a.refreshState()
		})
	}()
}

// deleteSession removes a session and returns to the list.
func (a *mobileApp) deleteSession(id string) {
	client := a.client
	if client == nil || id == "" {
		return
	}
	a.deleteID.Set("")
	go func() {
		err := client.deleteSession(id)
		a.cx.Post(func() {
			if err != nil {
				a.err.Set(remoteErrorText(err))
				return
			}
			a.err.Set("")
			if a.active.GetUntracked() == id {
				a.closeSession()
			}
			a.refreshState()
		})
	}()
}

// sessionBar is the model and thinking line over the composer.
func (a *mobileApp) sessionBar(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	label := func() string {
		opts := a.options.Get()
		name := opts.Model
		for _, m := range opts.Models {
			if m.ID == opts.Model {
				name = m.Name
				break
			}
		}
		if name == "" {
			name = "默认模型"
		}
		if opts.Thinking != "" {
			name += " · " + opts.Thinking
		}
		return name
	}
	return core.View{OnPress: func(core.PressEvent) { a.openOptions() }, Role: core.RoleButton, Label: "模型与思考等级",
		TestID: "mobile-options",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Padding: core.Symmetric(4, 12),
				Transition: pressMotion, Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.Icon(lucide.Brain, 11, colors.Faint),
			core.Text{ContentFunc: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexShrink: 1, FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
			ui.Icon(lucide.ChevronUp, 11, colors.Faint),
		}}
}

// openOptions reads the session's choices and shows them.
func (a *mobileApp) openOptions() {
	id := a.active.GetUntracked()
	if id == "" {
		return
	}
	a.optionsOpen.Set(true)
	a.loadOptions(id)
}

// loadOptions reads a session's models and thinking levels.
func (a *mobileApp) loadOptions(id string) {
	client := a.client
	if client == nil || id == "" {
		return
	}
	go func() {
		opts, err := client.options(id)
		a.cx.Post(func() {
			if a.active.GetUntracked() != id || err != nil {
				return
			}
			a.options.Set(opts)
		})
	}()
}

// optionsSheet picks the model or the thinking level.
func (a *mobileApp) optionsSheet() core.Node {
	return ui.Dialog{
		Open:         func() bool { return a.optionsOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) { a.optionsOpen.Set(open) },
		Title:        "模型与思考",
		TestID:       "mobile-options-sheet",
		Style:        core.Style{Width: core.Pt(360)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			opts := a.options.Get()
			var sections []core.Node
			if len(opts.Levels) > 0 {
				chips := make([]core.Node, 0, len(opts.Levels))
				for _, level := range opts.Levels {
					l := level
					on := l == opts.Thinking
					chips = append(chips, core.View{OnPress: func(core.PressEvent) { a.chooseThinking(l) },
						Role: core.RoleButton, Label: l, TestID: "mobile-level",
						StyleFunc: func() core.Style {
							st := core.Style{Padding: core.Symmetric(6, 12), CornerRadius: 14, BorderWidth: 1,
								BorderColor: colors.FieldBorder(), Transition: pressMotion,
								Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
							if on {
								st.Background = colors.Light()
								st.BorderColor = colors.Light()
							}
							return st
						},
						Children: []core.Node{ui.Text(l, 12, ui.Medium, func() core.Color {
							if on {
								return colors.OnLight()
							}
							return colors.Muted()
						})}})
				}
				sections = append(sections, core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					ui.Text("思考等级", 11, ui.Medium, colors.Faint),
					core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: chips},
				}})
			}
			if len(opts.Models) > 0 {
				rows := make([]core.Node, 0, len(opts.Models))
				for _, m := range opts.Models {
					model := m
					on := model.ID == opts.Model
					rows = append(rows, core.View{OnPress: func(core.PressEvent) { a.chooseModel(model) },
						Role: core.RoleButton, Label: model.Name, TestID: "mobile-model",
						StyleFunc: func() core.Style {
							return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(40),
								Padding: core.Symmetric(0, 8), CornerRadius: 7, Transition: pressMotion,
								Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
						},
						Children: []core.Node{
							core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
								core.Text{Content: model.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
									Style: core.Style{FontSize: 13.5}, StyleFunc: ui.Colored(colors.Text)},
								core.Text{Content: model.Provider, MaxLines: 1, Style: core.Style{FontSize: 10},
									StyleFunc: ui.Colored(colors.Faint)},
							}},
							core.Show{When: func() bool { return on }, Then: func(*core.Scope) core.Node {
								return ui.Icon(lucide.Check, 14, colors.Text)
							}},
						}})
				}
				sections = append(sections, core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					ui.Text("模型", 11, ui.Medium, colors.Faint),
					core.Scroll{Style: core.Style{MaxHeight: core.Pt(320)}, Children: []core.Node{
						core.View{Style: core.Style{Gap: 1}, Children: rows},
					}},
				}})
			}
			if len(sections) == 0 {
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(10, 4)},
					Children: []core.Node{
						ui.Spinner{Size: 13, Label: "正在读取"},
						ui.Text("正在读取模型列表…", 12, ui.Regular, colors.Faint),
					}}
			}
			return core.View{Style: core.Style{Gap: 14}, Children: sections}
		})},
	}
}

// chooseModel switches the open session's model.
func (a *mobileApp) chooseModel(m remoteWireModel) {
	id := a.active.GetUntracked()
	client := a.client
	if id == "" || client == nil {
		return
	}
	a.optionsOpen.Set(false)
	go func() {
		err := client.setModel(id, m.Provider, m.ID)
		a.cx.Post(func() {
			if err != nil {
				a.transcriptErr.Set(remoteErrorText(err))
				return
			}
			a.loadOptions(id)
		})
	}()
}

// chooseThinking switches the open session's reasoning level.
func (a *mobileApp) chooseThinking(level string) {
	id := a.active.GetUntracked()
	client := a.client
	if id == "" || client == nil {
		return
	}
	a.optionsOpen.Set(false)
	go func() {
		err := client.setThinking(id, level)
		a.cx.Post(func() {
			if err != nil {
				a.transcriptErr.Set(remoteErrorText(err))
				return
			}
			a.loadOptions(id)
		})
	}()
}

// --- saved connection ----------------------------------------------------

func mobileConfigPath(cx *core.Scope) string {
	dir := os.Getenv("PIDECK_LITE_HOME")
	if dir == "" {
		dir = cx.DataDir()
	}
	return filepath.Join(dir, "remote.json")
}

func loadMobileSaved(cx *core.Scope) mobileSaved {
	raw, err := os.ReadFile(mobileConfigPath(cx))
	if err != nil {
		return mobileSaved{}
	}
	var saved mobileSaved
	if json.Unmarshal(raw, &saved) != nil {
		return mobileSaved{}
	}
	return saved
}

func saveMobileSaved(cx *core.Scope, saved mobileSaved) {
	path := mobileConfigPath(cx)
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	raw, _ := json.Marshal(saved)
	_ = os.WriteFile(path, raw, 0o644)
}
