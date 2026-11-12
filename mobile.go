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

// view is the whole phone screen.
func (a *mobileApp) view() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		if a.connected.Get() {
			if a.active.Get() != "" {
				return a.transcriptView(cx)
			}
			return a.sessionsView(cx)
		}
		return a.connectView(cx)
	})
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
		}
		a.cx.AfterFunc(2500*time.Millisecond, loop)
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
		a.mobileHeader(cx, a.serverName.Get(), a.server.Get(), false),
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
				var sections []core.Node
				for _, project := range snap.Projects {
					if len(project.Sessions) == 0 {
						continue
					}
					p := project
					rows := make([]core.Node, 0, len(p.Sessions))
					for _, session := range p.Sessions {
						s := session
						rows = append(rows, a.mobileSessionRow(cx, s))
					}
					sections = append(sections, core.View{Style: core.Style{Gap: 2, Margin: core.Edges{Bottom: 14}}, Children: []core.Node{
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Padding: core.Symmetric(8, 16)}, Children: []core.Node{
							ui.Icon(lucide.Folder, 13, colors.Muted),
							core.Text{Content: p.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
								Style: core.Style{FlexGrow: 1, FontSize: 12, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)},
							ui.Text(fmt.Sprint(len(p.Sessions)), 10, ui.Regular, colors.Faint),
						}},
						core.View{Style: core.Style{Gap: 1}, Children: rows},
					}})
				}
				if len(sections) == 0 {
					sections = append(sections, core.View{Style: core.Style{Padding: core.All(32), AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
						ui.Icon(lucide.Laptop, 30, colors.Faint),
						ui.Text("电脑上还没有会话", 13, ui.Medium, colors.Muted),
						ui.Text("在电脑端新建一个会话，再回来刷新。", 11.5, ui.Regular, colors.Faint),
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
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(50), Padding: core.Symmetric(4, 8),
				CornerRadius: 9, Transition: pressMotion, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			core.View{Style: core.Style{Width: core.Pt(7), Height: core.Pt(7), CornerRadius: 4, Background: tone, FlexShrink: 0}},
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
				core.Text{Content: s.Title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 14, LineHeight: 19}, StyleFunc: ui.Colored(colors.Text)},
				core.Text{Content: mobileWhen(s.Updated), MaxLines: 1, Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Faint)},
			}},
			core.Show{When: func() bool { return s.External }, Then: func(*core.Scope) core.Node {
				return core.View{Style: core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 4, Background: colors.Inset()},
					Children: []core.Node{ui.Text("pi", 9, ui.Medium, colors.Faint)}}
			}},
			ui.Icon(lucide.ChevronRight, 14, colors.Faint),
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

// mobileHeader is the bar over the list and the transcript.
func (a *mobileApp) mobileHeader(cx *core.Scope, title, subtitle string, back bool) core.Node {
	colors := ui.ColorsOf(cx)
	var leading []core.Node
	if back {
		leading = append(leading, a.pressIcon(lucide.ChevronLeft, "返回", 36, 20, nil, a.closeSession, "mobile-back"))
	}
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(52), Padding: core.Symmetric(0, 12),
			Background: colors.Surface(), Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}
	}, Children: append(leading, []core.Node{
		core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
			core.Text{Content: title, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontSize: 15, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)},
			core.Show{When: func() bool { return subtitle != "" }, Then: func(*core.Scope) core.Node {
				return core.Text{Content: subtitle, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
			}},
		}},
		core.Dynamic(func(*core.Scope) core.Node {
			if a.transcriptBusy.Get() || a.refreshing.Get() {
				return ui.Spinner{Size: 12, Label: "刷新"}
			}
			return nil
		}),
		a.pressIcon(lucide.RefreshCw, "刷新", 34, 16, nil, func() {
			if a.active.GetUntracked() != "" {
				a.refreshTranscript()
			} else {
				a.refreshState()
			}
		}, "mobile-refresh"),
		a.pressIcon(lucide.Unplug, "断开连接", 34, 16, nil, func() { a.disconnect() }, "mobile-disconnect"),
	}...)}
}

// openSession downloads a session's transcript.
func (a *mobileApp) openSession(id, title string) {
	a.active.Set(id)
	a.activeTitle.Set(title)
	a.messages.Set(nil)
	a.transcriptErr.Set("")
	a.refreshTranscript()
}

func (a *mobileApp) closeSession() {
	a.active.Set("")
	a.messages.Set(nil)
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
			a.transcriptErr.Set(t.Error)
		})
	}()
}

// transcriptView shows the messages of one session.
func (a *mobileApp) transcriptView(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0),
		PaddingEnv: core.EnvAll(core.EnvSafeArea)}, Children: []core.Node{
		a.mobileHeader(cx, a.activeTitle.Get(), "", true),
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
			var rows []core.Node
			for _, m := range msgs {
				rows = append(rows, mobileMessage(cx, m))
			}
			if len(rows) == 0 {
				rows = append(rows, core.View{Style: core.Style{Padding: core.All(32), AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
					ui.Icon(lucide.MessageSquare, 26, colors.Faint),
					ui.Text("这个会话还没有消息", 12.5, ui.Regular, colors.Muted),
				}})
			}
			return core.Scroll{Style: ui.FillRest, Children: []core.Node{
				core.View{Selectable: true, Style: core.Style{Padding: core.Edges{Top: 14, Bottom: 28, Left: 14, Right: 14}, Gap: 12}, Children: rows},
			}}
		}),
	}}
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
