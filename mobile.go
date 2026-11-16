package main

// The phone build: it connects to a desktop PiDeck Lite server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_LITE_MOBILE=1 for a preview on a desktop).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/liyue201/goqr"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// mobileMode is the build the window should show.
func mobileMode() bool {
	if os.Getenv("PIDECK_LITE_MOBILE") == "1" {
		return true
	}
	return runtime.GOOS == "ios" || runtime.GOOS == "android"
}

// webMode is the browser build: WebAssembly has no processes and no disk,
// so it is a client of a desktop's server, like the phone.
func webMode() bool { return runtime.GOOS == "js" }

// clientMode says the window is a remote client, not the workbench.
func clientMode() bool { return mobileMode() || webMode() }

// mobileSaved is the last connection the phone used, and the ones before
// it so a second server is one tap away, beside the look, the language and
// the project it was left on.
type mobileSaved struct {
	Server     string         `json:"server"`
	Token      string         `json:"token"`
	Recent     []mobileRecent `json:"recent,omitempty"`
	Language   string         `json:"language,omitempty"`
	Appearance string         `json:"appearance,omitempty"`
	Project    string         `json:"project,omitempty"`
}

type mobileRecent struct {
	Server string `json:"server"`
	Token  string `json:"token"`
	Name   string `json:"name"`
	At     int64  `json:"at"`
}

type mobileApp struct {
	cx *core.Scope

	server *core.Signal[string]
	token  *core.Signal[string]
	recent *core.Signal[[]mobileRecent]
	busy   *core.Signal[bool]
	err    *core.Signal[string]

	connected  *core.Signal[bool]
	serverName *core.Signal[string]
	// desktopVersion is what the desktop's /api/ping reports, so a page can
	// tell when it predates the app it talks to.
	desktopVersion *core.Signal[string]
	state          *core.Signal[remoteWireSnapshot]

	active         *core.Signal[string]
	activeTitle    *core.Signal[string]
	messages       *core.Signal[[]remoteWireMessage]
	transcriptErr  *core.Signal[string]
	transcriptBusy *core.Signal[bool]
	// ask is the desktop's pending question, answerable from here.
	ask        *core.Signal[*remoteWireAsk]
	askText    *core.Signal[string]
	askSending *core.Signal[bool]

	// git is one project's repository, read-only.
	gitOpen         *core.Signal[bool]
	gitProject      *core.Signal[string]
	gitName         *core.Signal[string]
	gitState        *core.Signal[remoteWireGit]
	gitBusy         *core.Signal[bool]
	gitErr          *core.Signal[string]
	gitDiffOpen     *core.Signal[bool]
	gitDiffTitle    *core.Signal[string]
	gitDiffText     *core.Signal[string]
	gitDiffBusy     *core.Signal[bool]
	gitMsg          *core.Signal[string]
	gitSending      *core.Signal[bool]
	gitBranchesOpen *core.Signal[bool]

	// filesOpen browses a project's files, fileOpen shows one file's text.
	filesOpen    *core.Signal[bool]
	filesProject *core.Signal[string]
	filesName    *core.Signal[string]
	filesQuery   *core.Signal[string]
	filesList    *core.Signal[[]remoteWireFile]
	filesBusy    *core.Signal[bool]
	filesErr     *core.Signal[string]
	fileOpen     *core.Signal[bool]
	fileTitle    *core.Signal[string]
	fileText     *core.Signal[string]
	fileBusy     *core.Signal[bool]
	fileErr      *core.Signal[string]
	fileFind     *core.Signal[string]

	client *remoteClient
	gen    int

	// drawer is the rail over the page on a phone; initProject, initDraft
	// and initPending are the new-session page's choices, and railCollapsed
	// the projects folded in the rail.
	drawerOpen    *core.Signal[bool]
	railHidden    *core.Signal[bool]
	initProject   *core.Signal[string]
	initDraft     *core.Signal[string]
	initPending   *core.Signal[[]promptImage]
	initSending   *core.Signal[bool]
	railCollapsed *core.Signal[[]string]
	settingsOpen  *core.Signal[bool]
	projectOpen   *core.Signal[string]
	appearance    *core.Signal[string]
	language      *core.Signal[string]

	// The rail's lists: the ways of working a session can start with, the
	// desktop's cron tasks and its favorites.
	agents        *core.Signal[[]remoteWireAgent]
	agentsBusy    *core.Signal[bool]
	agentsErr     *core.Signal[string]
	agentsOpen    *core.Signal[bool]
	tasks         *core.Signal[[]remoteWireTask]
	tasksBusy     *core.Signal[bool]
	tasksErr      *core.Signal[string]
	tasksOpen     *core.Signal[bool]
	taskOpen      *core.Signal[string]
	taskBusy      *core.Signal[string]
	favorites     *core.Signal[[]remoteWireFavorite]
	favoritesBusy *core.Signal[bool]
	favoritesErr  *core.Signal[string]
	favoritesOpen *core.Signal[bool]
	favOpen       *core.Signal[string]

	// query filters the session list, findText the open transcript.
	query      *core.Signal[string]
	searchOpen *core.Signal[bool]
	findOpen   *core.Signal[bool]
	findText   *core.Signal[string]

	// draft is the composer's text, pending the pictures attached to it;
	// sending covers one request in flight.
	draft   *core.Signal[string]
	pending *core.Signal[[]promptImage]
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
	// addPath is the folder being added, removePath the project being
	// taken off the desktop.
	addPath    *core.Signal[string]
	addOpen    *core.Signal[bool]
	removePath *core.Signal[string]

	// options are the open session's models and thinking levels, shown in
	// the sheet over optionsOpen.
	options     *core.Signal[remoteWireOptions]
	optionsOpen *core.Signal[bool]

	// toolOpen is the key of the tool block the user unfolded, longOpen the
	// long user message that is fully shown.
	toolOpen *core.Signal[string]
	longOpen *core.Signal[string]

	// hits are the message matches for the list's query; searchSeq drops
	// answers for a query the user already changed.
	hits      *core.Signal[[]remoteWireHit]
	hitsBusy  *core.Signal[bool]
	searchSeq int
	hitsQuery string

	// scroll is the transcript's scroller; atBottom says it rests at the
	// end, notice is a short confirmation over the composer.
	scroll   *core.Ref
	atBottom *core.Signal[bool]
	notice   *core.Signal[string]

	stateLoading      bool
	transcriptLoading bool
	refreshing        *core.Signal[bool]
}

// newMobileApp builds the phone's state and reconnects to the last server.
func newMobileApp(cx *core.Scope) *mobileApp {
	cx.SetAppearance(core.AppearanceSystem)
	cx.SetTheme(pideckTheme())
	setting := strings.TrimSpace(os.Getenv("PIDECK_LITE_LANG"))
	setUILanguage(resolveLanguage(setting, cx.Env().Locale()))
	a := &mobileApp{
		cx:              cx,
		server:          core.NewSignal(cx, ""),
		recent:          core.NewSignalFunc(cx, []mobileRecent(nil), nil),
		token:           core.NewSignal(cx, ""),
		busy:            core.NewSignal(cx, false),
		err:             core.NewSignal(cx, ""),
		connected:       core.NewSignal(cx, false),
		serverName:      core.NewSignal(cx, "PiDeck Lite"),
		desktopVersion:  core.NewSignal(cx, ""),
		state:           core.NewSignalFunc(cx, remoteWireSnapshot{}, nil),
		active:          core.NewSignal(cx, ""),
		activeTitle:     core.NewSignal(cx, ""),
		messages:        core.NewSignalFunc(cx, []remoteWireMessage(nil), nil),
		transcriptErr:   core.NewSignal(cx, ""),
		transcriptBusy:  core.NewSignal(cx, false),
		ask:             core.NewSignalFunc(cx, (*remoteWireAsk)(nil), nil),
		askText:         core.NewSignal(cx, ""),
		askSending:      core.NewSignal(cx, false),
		gitOpen:         core.NewSignal(cx, false),
		gitProject:      core.NewSignal(cx, ""),
		gitName:         core.NewSignal(cx, ""),
		gitState:        core.NewSignalFunc(cx, remoteWireGit{}, nil),
		gitBusy:         core.NewSignal(cx, false),
		gitErr:          core.NewSignal(cx, ""),
		gitDiffOpen:     core.NewSignal(cx, false),
		gitDiffTitle:    core.NewSignal(cx, ""),
		gitDiffText:     core.NewSignal(cx, ""),
		gitDiffBusy:     core.NewSignal(cx, false),
		gitMsg:          core.NewSignal(cx, ""),
		gitSending:      core.NewSignal(cx, false),
		gitBranchesOpen: core.NewSignal(cx, false),
		filesOpen:       core.NewSignal(cx, false),
		filesProject:    core.NewSignal(cx, ""),
		filesName:       core.NewSignal(cx, ""),
		filesQuery:      core.NewSignal(cx, ""),
		filesList:       core.NewSignalFunc(cx, []remoteWireFile(nil), nil),
		filesBusy:       core.NewSignal(cx, false),
		filesErr:        core.NewSignal(cx, ""),
		fileOpen:        core.NewSignal(cx, false),
		fileTitle:       core.NewSignal(cx, ""),
		fileText:        core.NewSignal(cx, ""),
		fileBusy:        core.NewSignal(cx, false),
		fileErr:         core.NewSignal(cx, ""),
		fileFind:        core.NewSignal(cx, ""),
		refreshing:      core.NewSignal(cx, false),
		query:           core.NewSignal(cx, ""),
		searchOpen:      core.NewSignal(cx, false),
		findOpen:        core.NewSignal(cx, false),
		findText:        core.NewSignal(cx, ""),
		draft:           core.NewSignal(cx, ""),
		pending:         core.NewSignalFunc(cx, []promptImage(nil), nil),
		sending:         core.NewSignal(cx, false),
		running:         core.NewSignal(cx, false),
		actionID:        core.NewSignal(cx, ""),
		deleteID:        core.NewSignal(cx, ""),
		renameID:        core.NewSignal(cx, ""),
		renameText:      core.NewSignal(cx, ""),
		newOpen:         core.NewSignal(cx, false),
		creating:        core.NewSignal(cx, false),
		addPath:         core.NewSignal(cx, ""),
		addOpen:         core.NewSignal(cx, false),
		removePath:      core.NewSignal(cx, ""),
		options:         core.NewSignalFunc(cx, remoteWireOptions{}, nil),
		optionsOpen:     core.NewSignal(cx, false),
		toolOpen:        core.NewSignal(cx, ""),
		longOpen:        core.NewSignal(cx, ""),
		hits:            core.NewSignalFunc(cx, []remoteWireHit(nil), nil),
		hitsBusy:        core.NewSignal(cx, false),
		scroll:          &core.Ref{},
		atBottom:        core.NewSignal(cx, true),
		notice:          core.NewSignal(cx, ""),
		drawerOpen:      core.NewSignal(cx, false),
		railHidden:      core.NewSignal(cx, false),
		initProject:     core.NewSignal(cx, ""),
		initDraft:       core.NewSignal(cx, ""),
		initPending:     core.NewSignalFunc(cx, []promptImage(nil), nil),
		initSending:     core.NewSignal(cx, false),
		railCollapsed:   core.NewSignalFunc(cx, []string(nil), nil),
		settingsOpen:    core.NewSignal(cx, false),
		projectOpen:     core.NewSignal(cx, ""),
		appearance:      core.NewSignal(cx, appearanceSystem),
		language:        core.NewSignal(cx, langZhCN),
		agents:          core.NewSignalFunc(cx, []remoteWireAgent(nil), nil),
		agentsBusy:      core.NewSignal(cx, false),
		agentsErr:       core.NewSignal(cx, ""),
		agentsOpen:      core.NewSignal(cx, false),
		tasks:           core.NewSignalFunc(cx, []remoteWireTask(nil), nil),
		tasksBusy:       core.NewSignal(cx, false),
		tasksErr:        core.NewSignal(cx, ""),
		tasksOpen:       core.NewSignal(cx, false),
		taskOpen:        core.NewSignal(cx, ""),
		taskBusy:        core.NewSignal(cx, ""),
		favorites:       core.NewSignalFunc(cx, []remoteWireFavorite(nil), nil),
		favoritesBusy:   core.NewSignal(cx, false),
		favoritesErr:    core.NewSignal(cx, ""),
		favoritesOpen:   core.NewSignal(cx, false),
		favOpen:         core.NewSignal(cx, ""),
	}
	saved := loadMobileSaved(cx)
	// The saved look, language and last project win over the system's:
	// the user chose them here, not on this boot.
	if saved.Language != "" {
		setUILanguage(resolveLanguage(saved.Language, cx.Env().Locale()))
	}
	a.language.Set(resolveLanguage(setting, cx.Env().Locale()))
	a.appearance.Set(saved.Appearance)
	cx.SetAppearance(appearanceOf(saved.Appearance))
	a.initProject.Set(saved.Project)
	// A page is served by a desktop, so its origin is the server and a link's
	// ?token= the token; a saved connection wins only over the origin.
	if origin, linkToken := webStart(); origin != "" {
		if saved.Server == "" {
			saved.Server = origin
		}
		if linkToken != "" {
			saved.Token = linkToken
		}
	}
	if saved.Server != "" || len(saved.Recent) > 0 {
		a.recent.Set(saved.Recent)
		if saved.Server != "" {
			a.server.Set(saved.Server)
			a.token.Set(saved.Token)
			a.connect()
		}
	}
	cx.OnBackPress(func() bool {
		if a.drawerOpen.GetUntracked() {
			a.openDrawer(false)
			return true
		}
		if a.active.GetUntracked() != "" {
			a.closeSession()
			return true
		}
		return false
	})
	return a
}

// view is the whole phone screen, with the drawer and the sheets over it.
func (a *mobileApp) view() core.Node {
	return core.View{Style: ui.FillRest, Children: []core.Node{
		core.Dynamic(func(cx *core.Scope) core.Node {
			if a.connected.Get() {
				return a.shell(cx)
			}
			return a.connectView(cx)
		}),
		a.drawer(),
		a.actionSheet(),
		a.renameSheet(),
		a.deleteSheet(),
		a.newSessionSheet(),
		a.optionsSheet(),
		a.noticePill(),
		a.addProjectSheet(),
		a.removeProjectSheet(),
		a.projectSheet(),
		a.settingsSheet(),
		a.searchSheet(),
		a.agentsSheet(),
		a.tasksSheet(),
		a.favoritesSheet(),
		a.favoriteTextSheet(),
		a.gitSheet(),
		a.gitDiffSheet(),
		a.gitBranchesSheet(),
		a.filesSheet(),
		a.fileSheet(),
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
		field(T("连接地址"), "http://192.168.1.8:8787/?token=…", "mobile-server", a.server, a.connect),
		field(T("访问令牌"), "粘贴电脑端显示的令牌", "mobile-token", a.token, a.connect),
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
					return ui.Spinner{Size: 14, Label: T("连接中")}
				}
				return nil
			}),
			ui.Button{Text: T("连接"), Variant: ui.ButtonPrimary, Size: ui.SizeLarge, Flex: 1, TestID: "mobile-connect",
				Disabled: func() bool { return a.busy.Get() }, OnPress: a.connect},
		}},
		ui.Button{Text: T("扫码连接"), Variant: ui.ButtonSecondary, Size: ui.SizeLarge, TestID: "mobile-scan",
			OnPress: a.scanQR},
		ui.Button{Text: T("从相册选二维码"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "mobile-scan-library",
			OnPress: a.scanImage},
	}}
	column := core.View{Style: core.Style{Width: core.Pct(100), MaxWidth: core.Pt(480), Gap: 16}, Children: []core.Node{
		core.Image{Source: core.ImageSource{Data: logoPNG}, ResizeMode: core.Contain, Label: "PiDeck",
			Style: core.Style{Width: core.Pt(64), Height: core.Pt(64), CornerRadius: 18, AlignSelf: core.AlignCenter}},
		core.View{Style: core.Style{Gap: 4, AlignItems: core.AlignCenter}, Children: []core.Node{
			ui.Text("PiDeck Lite", 24, ui.Bold, colors.Text),
			ui.Text(T("连接电脑上的会话"), 13, ui.Regular, colors.Muted),
		}},
		card,
		a.recentList(),
		core.Text{Content: T("在电脑端打开 设置 → 远程，启用后扫码或复制连接链接；手机和电脑需要在同一局域网、Tailscale 或 EasyTier 网络里。"),
			Style: core.Style{FontSize: 11, LineHeight: 17, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Faint)},
	}}
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0),
		PaddingEnv: core.EnvEdges{Top: core.EnvSafeArea, Right: core.EnvSafeArea, Left: core.EnvSafeArea, Bottom: core.EnvKeyboard}},
		Children: []core.Node{core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, Padding: core.All(24), Gap: 16, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
				Children: []core.Node{column}},
		}}}}
}

// recentList shows the servers this phone has used, newest first.
func (a *mobileApp) recentList() core.Node {
	return core.Show{When: func() bool { return len(a.recent.Get()) > 0 }, Then: func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		rows := make([]core.Node, 0, len(a.recent.Get()))
		for _, item := range a.recent.Get() {
			r := item
			host := strings.TrimPrefix(strings.TrimPrefix(r.Server, "http://"), "https://")
			rows = append(rows, core.View{OnPress: func(core.PressEvent) {
				a.server.Set(r.Server)
				a.token.Set(r.Token)
				a.connect()
			}, Role: core.RoleButton, Label: r.Name, TestID: "mobile-recent",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(46),
						Padding: core.Symmetric(0, 10), CornerRadius: 10, Transition: pressMotion,
						Background: colors.Surface(), Hover: &core.Style{Background: colors.Hover()},
						Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					ui.Icon(lucide.Laptop, 15, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: r.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 13}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{Content: host, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
					}},
					ui.Icon(lucide.ChevronRight, 13, colors.Faint),
				}})
		}
		return core.View{Style: core.Style{Width: core.Pct(100), MaxWidth: core.Pt(480), Gap: 6}, Children: []core.Node{
			ui.Text(T("最近连接"), 11, ui.Medium, colors.Faint),
			core.View{Style: core.Style{Gap: 4}, Children: rows},
		}}
	}}
}

// scanImage reads a code from a picture already on the phone.
func (a *mobileApp) scanImage() {
	a.err.Set("")
	a.cx.PickFiles(core.PickFilesOptions{Types: []string{"image/*"}, Limit: 1}, func(files []core.File, err error) {
		if err != nil || len(files) == 0 {
			return
		}
		data, readErr := os.ReadFile(files[0].Path)
		if readErr != nil || len(data) == 0 {
			a.err.Set("读不到这张图片")
			return
		}
		a.useScanned(data)
	})
}

// useScanned decodes a picture and connects to what it holds.
func (a *mobileApp) useScanned(data []byte) {
	go func() {
		link, err := decodeQRLink(data)
		a.cx.Post(func() {
			if err != nil || link == "" {
				a.err.Set("这张图里没有二维码")
				return
			}
			client, token, cerr := newRemoteClient(link, "")
			if cerr != nil {
				a.err.Set(cerr.Error())
				return
			}
			a.server.Set(client.base)
			a.token.Set(token)
			a.connect()
		})
	}()
}

// scanQR reads a connection link from a photo of the desktop's code.
func (a *mobileApp) scanQR() {
	if !a.cx.Env().CanTakePhoto() {
		a.err.Set("这台设备没有可用的相机，用下面的链接和令牌连接吧")
		return
	}
	a.err.Set("")
	a.cx.TakePhoto(core.PhotoOptions{MaxDimension: 1600}, func(photo *core.PickedFile, err error) {
		if err != nil {
			a.err.Set("打开相机失败：" + err.Error())
			return
		}
		if photo == nil || len(photo.Data) == 0 {
			return
		}
		a.useScanned(photo.Data)
	})
}

// decodeQRLink reads the first QR code in a JPEG or PNG.
func decodeQRLink(data []byte) (string, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	codes, err := goqr.Recognize(img)
	if err != nil {
		return "", err
	}
	for _, code := range codes {
		if len(code.Payload) > 0 {
			return string(code.Payload), nil
		}
	}
	return "", errors.New("没有二维码")
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
			a.desktopVersion.Set(ping.Version)
			a.state.Set(snap)
			a.connected.Set(true)
			a.err.Set("")
			saved := rememberConnection(a.recent.GetUntracked(), mobileRecent{
				Server: client.base, Token: token, Name: a.serverName.Get(), At: time.Now().UnixMilli(),
			})
			a.recent.Set(saved.Recent)
			// The look, the language and the last project are kept beside the
			// connection, so saveLook writes all of them.
			a.saveLook()
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
	a.ask.Set(nil)
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
			// The model line fills in once pi is up, without opening the
			// sheet.
			if a.optionsOpen.GetUntracked() || a.options.GetUntracked().Model == "" {
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

// pageStale says the page was built before the desktop it talks to, which
// only a browser page can be: a reload takes the newer one.
func (a *mobileApp) pageStale() bool {
	return webMode() && a.desktopVersion.Get() != "" && a.desktopVersion.Get() != appVersion
}

// appNotice is the thin bar under a page's header: the connection's error,
// or a browser page older than the desktop it talks to.
func (a *mobileApp) appNotice(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{FlexShrink: 0}, Children: []core.Node{
		core.Show{When: func() bool { return a.err.Get() != "" }, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, Gap: 6, Padding: core.Symmetric(8, 14)},
				StyleFunc: func() core.Style { return core.Style{Background: ui.Alpha(colors.Danger(), 0.07)} },
				Children: []core.Node{
					ui.Icon(lucide.TriangleAlert, 12, colors.Danger),
					core.Text{ContentFunc: a.err.Get, MaxLines: 2, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11},
						StyleFunc: ui.Colored(colors.Danger)},
				}}
		}},
		// A page older than the desktop it talks to: a reload takes the
		// version the app serves now, which the build's own name marks.
		core.Show{When: func() bool { return a.pageStale() }, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(8, 14)},
				StyleFunc: func() core.Style { return core.Style{Background: ui.Alpha(colors.Accent(), 0.10)} },
				Children: []core.Node{
					ui.Icon(lucide.RefreshCw, 12, colors.Accent),
					core.Text{ContentFunc: func() string {
						return T("这个页面是 %s，电脑上是 %s；刷新后一起用新版本", appVersion, a.desktopVersion.Get())
					}, MaxLines: 2, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11},
						StyleFunc: ui.Colored(colors.Text)},
					ui.Button{Text: T("刷新页面"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "mobile-reload", OnPress: func() { webReload() }},
				}}
		}},
	}}
}

// mobileSessionRow is one session in the rail: a status dot, its title,
// and when it last did something.
func (a *mobileApp) mobileSessionRow(cx *core.Scope, s remoteWireSession) core.Node {
	colors := ui.ColorsOf(cx)
	tone := remoteStatusColor(s.Status, colors)
	if s.Ask != nil {
		tone = colors.Warn()
	}
	return core.View{OnPress: func(core.PressEvent) {
		a.openDrawer(false)
		a.openSession(s.ID, s.Title)
	}, Role: core.RoleButton, Label: s.Title, TestID: "mobile-session",
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(44),
				Padding: core.Edges{Left: 8, Right: 2}, CornerRadius: 8, Transition: pressMotion,
				Active: &core.Style{Background: colors.Pressed()}}
			if a.active.Get() == s.ID {
				st.Background = colors.Pressed()
			}
			return st
		},
		Children: []core.Node{
			core.View{Style: core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, Background: tone, FlexShrink: 0}},
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
				core.Text{Content: s.Title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 13, LineHeight: 18}, StyleFunc: ui.Colored(colors.Text)},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: []core.Node{
					core.Text{Content: mobileWhen(s.Updated), MaxLines: 1, Style: core.Style{FontSize: 10},
						StyleFunc: ui.Colored(colors.Faint)},
					core.Show{When: func() bool { return s.Running }, Then: func(*core.Scope) core.Node {
						return ui.Text(T("运行中"), 9.5, ui.Medium, colors.Accent)
					}},
					core.Show{When: func() bool { return s.Ask != nil }, Then: func(*core.Scope) core.Node {
						return ui.Text(T("待确认"), 9.5, ui.Medium, colors.Warn)
					}},
				}},
			}},
			core.Show{When: func() bool { return s.External }, Then: func(*core.Scope) core.Node {
				return core.View{Style: core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 4, Background: colors.Inset()},
					Children: []core.Node{ui.Text("pi", 9, ui.Medium, colors.Faint)}}
			}},
			core.Show{When: func() bool { return s.Pinned }, Then: func(*core.Scope) core.Node {
				return ui.Icon(lucide.Pin, 11, colors.Faint)
			}},
			a.pressIcon(lucide.Ellipsis, T("会话操作"), 30, 15, nil, func() { a.actionID.Set(s.ID) }, "mobile-session-actions"),
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

// openSession downloads a session's transcript.
func (a *mobileApp) openSession(id, title string) {
	a.active.Set(id)
	a.activeTitle.Set(title)
	a.messages.Set(nil)
	a.running.Set(false)
	a.findOpen.Set(false)
	a.findText.Set("")
	a.transcriptErr.Set("")
	a.ask.Set(nil)
	a.askText.Set("")
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
	a.ask.Set(nil)
	a.askText.Set("")
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
			a.ask.Set(t.Ask)
			a.transcriptErr.Set(t.Error)
		})
	}()
}

// transcriptView shows the messages of one session, with the composer
// under them.
func (a *mobileApp) transcriptView(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0)}, Children: []core.Node{
		a.pageHeader(cx, a.activeTitle.Get(), "",
			a.pressIcon(lucide.FolderOpen, T("浏览文件"), 34, 16, nil, a.openSessionFiles, "mobile-files"),
			a.pressIcon(lucide.Search, T("搜索会话内容"), 34, 16, nil, func() {
				a.findText.Set("")
				a.findOpen.Update(func(v bool) bool { return !v })
			}, "mobile-find"),
			a.pressIcon(lucide.Ellipsis, T("会话操作"), 34, 16, nil, func() { a.actionID.Set(a.active.Get()) }, "mobile-active-actions"),
		),
		a.appNotice(cx),
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
		core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Position: core.Relative}, Children: []core.Node{
			core.Scroll{Ref: a.scroll, Style: ui.FillRest, ScrollEventThrottle: 120 * time.Millisecond,
				OnScroll: func(e core.ScrollEvent) {
					at := e.Offset.Y+e.Size.Height >= e.ContentSize.Height-90
					if a.atBottom.GetUntracked() != at {
						a.atBottom.Set(at)
					}
				}, Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
					msgs := a.messages.Get()
					if a.transcriptBusy.Get() && len(msgs) == 0 {
						return core.View{Style: core.Style{Padding: core.All(18), Gap: 14}, Children: []core.Node{
							ui.Skeleton{Lines: 3, Avatar: true, Label: T("正在读取会话")},
							ui.Skeleton{Lines: 4, Avatar: true, Label: T("正在读取会话")},
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
							ui.Text(T("匹配 %d 条", matches), 11, ui.Medium, colors.Faint),
						}})
					}
					for i := 0; i < len(msgs); {
						if msgs[i].Role == "tool" {
							j := i
							for j < len(msgs) && msgs[j].Role == "tool" {
								j++
							}
							rows = append(rows, a.toolBlock(cx, msgs[i:j]))
							i = j
							continue
						}
						rows = append(rows, a.message(cx, msgs[i]))
						i++
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
					return core.View{Selectable: true, Style: core.Style{Padding: core.Edges{Top: 14, Bottom: 20, Left: 14, Right: 14}, Gap: 12}, Children: rows}
				})}},
			core.Show{When: func() bool { return !a.atBottom.Get() && len(a.messages.Get()) > 0 }, Then: func(cx *core.Scope) core.Node {
				colors := ui.ColorsOf(cx)
				return core.View{OnPress: func(core.PressEvent) { a.scroll.ScrollToEnd(true) }, Role: core.RoleButton,
					Label: T("回到最新"), TestID: "mobile-latest",
					StyleFunc: func() core.Style {
						return core.Style{Position: core.Absolute, Right: core.Pt(14), Bottom: core.Pt(12), Direction: core.Row,
							AlignItems: core.AlignCenter, Gap: 4, Padding: core.Symmetric(6, 10), CornerRadius: 16,
							Background: colors.Light(), Transition: pressMotion}
					},
					Children: []core.Node{
						ui.Icon(lucide.ChevronDown, 12, colors.OnLight),
						ui.Text(T("最新"), 11, ui.Medium, colors.OnLight),
					}}
			}},
		}},
		a.retryBar(cx),
		a.askBar(cx),
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
			core.Input{Value: a.findText.Get, OnChange: a.findText.Set, Placeholder: T("在这个会话里搜索"), Label: T("搜索会话内容"), TestID: "mobile-find-input",
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

// askBar is the desktop's pending question: a turn is waiting on it, so
// the phone can answer instead of leaving it stuck.
func (a *mobileApp) askBar(cx *core.Scope) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		ask := a.ask.Get()
		if ask == nil {
			return nil
		}
		colors := ui.ColorsOf(cx)
		title := ask.Title
		if title == "" {
			title = "电脑在等你确认"
		}
		sending := a.askSending.Get()
		button := func(text string, primary bool, testID string, body map[string]any) core.Node {
			variant := ui.ButtonSecondary
			if primary {
				variant = ui.ButtonPrimary
			}
			return ui.Button{Text: text, Variant: variant, Size: ui.SizeSmall, TestID: testID,
				Disabled: func() bool { return sending },
				OnPress:  func() { a.answer(body) }}
		}
		var actions []core.Node
		switch ask.Method {
		case "confirm":
			actions = append(actions,
				button("拒绝", false, "mobile-ask-deny", map[string]any{"confirmed": false}),
				button("允许", true, "mobile-ask-allow", map[string]any{"confirmed": true}))
		case "select":
			for i, opt := range ask.Options {
				actions = append(actions, button(opt, false, fmt.Sprintf("mobile-ask-option-%d", i), map[string]any{"value": opt}))
			}
			actions = append(actions, button(T("取消"), false, "mobile-ask-cancel", map[string]any{"cancelled": true}))
		default:
			actions = append(actions, core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
				core.Input{Value: a.askText.Get, OnChange: a.askText.Set, Placeholder: T("输入回答"), Label: T("回答"), TestID: "mobile-ask-input",
					Style: core.Style{Height: core.Pt(36), Padding: core.Symmetric(0, 10), FontSize: 13.5, Color: colors.Text(),
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 9,
						PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}},
			}})
			actions = append(actions,
				button(T("取消"), false, "mobile-ask-cancel", map[string]any{"cancelled": true}),
				button("确定", true, "mobile-ask-send", map[string]any{"value": a.askText.GetUntracked()}))
		}
		head := []core.Node{
			ui.Icon(lucide.ShieldAlert, 14, colors.Warn),
			core.Text{Content: title, MaxLines: 2, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, FontWeight: ui.Semibold},
				StyleFunc: ui.Colored(colors.Text)},
		}
		if sending {
			head = append(head, ui.Spinner{Size: 11})
		}
		children := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: head},
		}
		if ask.Message != "" {
			children = append(children, core.Text{Content: ask.Message, MaxLines: 4, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 11.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)})
		}
		children = append(children, core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 6},
			Children: actions})
		return core.View{TestID: "mobile-ask", StyleFunc: func() core.Style {
			return core.Style{Gap: 7, Padding: core.Symmetric(9, 12),
				Background:   ui.Alpha(colors.Warn(), 0.10),
				Borders:      core.Edges{Top: 1, Bottom: 1},
				BorderColors: core.EdgeColors{Top: ui.Alpha(colors.Warn(), 0.35), Bottom: ui.Alpha(colors.Warn(), 0.35)}}
		}, Children: children}
	})
}

// answer replies to the desktop's pending question.
func (a *mobileApp) answer(body map[string]any) {
	client := a.client
	id := a.active.GetUntracked()
	if client == nil || id == "" || a.askSending.GetUntracked() {
		return
	}
	a.askSending.Set(true)
	go func() {
		err := client.answer(id, body)
		a.cx.Post(func() {
			a.askSending.Set(false)
			if err != nil {
				a.transcriptErr.Set(remoteErrorText(err))
				return
			}
			a.ask.Set(nil)
			a.askText.Set("")
			a.refreshTranscript()
		})
	}()
}

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
				core.Input{Value: a.draft.Get, OnChange: a.draft.Set, Placeholder: T("发消息给 pi…"), Label: T("消息"), TestID: "mobile-draft",
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
				actions = append(actions, ui.Press{OnPress: a.sendMessage, Disabled: empty, Scale: 0.9, Role: core.RoleButton, Label: T("发送"), TestID: "mobile-send",
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
					})}})
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: actions}
			}),
		}},
	}}
}

// pendingStrip shows the pictures waiting to be sent; tapping one drops it.
func (a *mobileApp) pendingStrip(cx *core.Scope) core.Node {
	return a.pendingThumbs(cx, func() []promptImage { return a.pending.Get() }, func(index int) {
		a.pending.Update(func(list []promptImage) []promptImage { return withoutImage(list, index) })
	})
}

// pendingThumbs is the strip both composers show, each with its own list.
func (a *mobileApp) pendingThumbs(cx *core.Scope, images func() []promptImage, drop func(index int)) core.Node {
	colors := ui.ColorsOf(cx)
	return core.Show{When: func() bool { return len(images()) > 0 }, Then: func(*core.Scope) core.Node {
		list := images()
		thumbs := make([]core.Node, 0, len(list))
		for i, img := range list {
			index := i
			thumbs = append(thumbs, core.View{OnPress: func(core.PressEvent) { drop(index) },
				Role: core.RoleButton, Label: T("移除图片"), TestID: "mobile-pending",
				Style: core.Style{Width: core.Pt(46), Height: core.Pt(46), CornerRadius: 9, Overflow: core.Hidden,
					BorderWidth: 1, BorderColor: colors.Border()},
				Children: []core.Node{core.Image{Source: core.ImageSource{Data: img.Data}, ResizeMode: core.Cover,
					Label: T("待发送的图片"), Style: core.Style{Width: core.Pct(100), Height: core.Pct(100)}}},
			})
		}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: thumbs}
	}}
}

// withoutImage drops one picture from a list.
func withoutImage(list []promptImage, index int) []promptImage {
	out := make([]promptImage, 0, len(list))
	for i, img := range list {
		if i != index {
			out = append(out, img)
		}
	}
	return out
}

// readImageFile reads one picture from the phone, ready to send.
func readImageFile(path string) (promptImage, error) {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return promptImage{}, errors.New(T("图片读不出来"))
	}
	if len(data) > 6<<20 {
		return promptImage{}, errors.New(T("图片太大，上限 6 MB"))
	}
	mime := http.DetectContentType(data)
	if !strings.HasPrefix(mime, "image/") {
		mime = "image/png"
	}
	return promptImage{Data: data, MimeType: mime, Name: filepath.Base(path)}, nil
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
			a.pending.Update(func(list []promptImage) []promptImage { return append(list, img) })
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

// toolBlock folds a run of tool calls into one row that opens in place.
func (a *mobileApp) toolBlock(cx *core.Scope, lines []remoteWireMessage) core.Node {
	colors := ui.ColorsOf(cx)
	key := lines[0].Text
	open := a.toolOpen.Get() == key
	header := "调用了 " + fmt.Sprint(len(lines)) + " 个工具"
	if len(lines) == 1 {
		header = firstLine(lines[0].Text, 40)
	}
	children := []core.Node{
		core.View{OnPress: func(core.PressEvent) {
			if open {
				a.toolOpen.Set("")
			} else {
				a.toolOpen.Set(key)
			}
		}, Role: core.RoleButton, Label: header, TestID: "mobile-tools",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(4, 6),
					CornerRadius: 7, Transition: pressMotion, Hover: &core.Style{Background: colors.Hover()},
					Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{
				ui.Icon(lucide.Terminal, 12, colors.Faint),
				core.Text{Content: header, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: ui.Mono, FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Faint)},
				ui.Icon(map[bool]func() *core.SVG{true: lucide.ChevronUp, false: lucide.ChevronDown}[open], 12, colors.Faint),
			}},
	}
	if open {
		inner := make([]core.Node, 0, len(lines))
		for _, line := range lines {
			inner = append(inner, core.Text{Content: line.Text, MaxLines: 12,
				Style: core.Style{FontFamily: ui.Mono, FontSize: 10.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)})
		}
		children = append(children, core.View{Style: core.Style{Gap: 4, Padding: core.Edges{Left: 18, Top: 2, Bottom: 4}},
			Children: inner})
	}
	return core.View{Style: core.Style{Gap: 2}, Children: children}
}

// message draws one line of a remote transcript; holding it copies its
// text.
func (a *mobileApp) message(cx *core.Scope, m remoteWireMessage) core.Node {
	body := a.messageBody(cx, m)
	if strings.TrimSpace(m.Text) == "" {
		return body
	}
	return core.View{OnLongPress: func(core.PressEvent) {
		a.cx.SetClipboard(m.Text)
		a.flash("已复制")
	}, Children: []core.Node{body}}
}

// noticePill is the short confirmation every screen shows.
func (a *mobileApp) noticePill() core.Node {
	return core.Show{When: func() bool { return a.notice.Get() != "" }, Then: func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{Style: core.Style{Position: core.Absolute, Left: core.Pt(0), Right: core.Pt(0), Bottom: core.Pt(120),
			AlignItems: core.AlignCenter, PointerEvents: core.PointerEventsBoxNone}, Children: []core.Node{
			core.View{StyleFunc: func() core.Style {
				return core.Style{Padding: core.Symmetric(7, 15), CornerRadius: 16, Background: colors.Light()}
			}, Children: []core.Node{ui.Text(a.notice.Get(), 12, ui.Medium, colors.OnLight)}},
		}}
	}}
}

// flash shows a short confirmation over the composer.
func (a *mobileApp) flash(text string) {
	a.notice.Set(text)
	a.cx.AfterFunc(1600*time.Millisecond, func() {
		if a.notice.GetUntracked() == text {
			a.notice.Set("")
		}
	})
}

// messageBody draws one line, without the copy gesture.
func (a *mobileApp) messageBody(cx *core.Scope, m remoteWireMessage) core.Node {
	colors := ui.ColorsOf(cx)
	switch m.Role {
	case "user":
		// A pasted attachment or a long system block would fill the screen:
		// show its head, and open it in place when asked.
		text := m.Text
		runes := []rune(text)
		if len(runes) > 400 {
			key := string(runes[:64])
			if a.longOpen.Get() != key {
				text = string(runes[:400]) + "…"
			}
			return core.View{OnPress: func(core.PressEvent) {
				if a.longOpen.Get() == key {
					a.longOpen.Set("")
				} else {
					a.longOpen.Set(key)
				}
			}, Role: core.RoleButton, Label: T("长消息"), TestID: "mobile-long",
				Style: core.Style{Direction: core.Row, JustifyContent: core.JustifyEnd}, Children: []core.Node{
					core.View{Style: core.Style{MaxWidth: core.Pct(86), Padding: core.Symmetric(9, 13), CornerRadius: 15,
						Background: colors.Light()}, Children: []core.Node{
						core.Text{Content: text, Style: core.Style{FontSize: 14, LineHeight: 20}, StyleFunc: ui.Colored(colors.OnLight)},
						core.Text{Content: func() string {
							if a.longOpen.Get() == key {
								return "收起"
							}
							return fmt.Sprintf("展开全文（%d 字）", len(runes))
						}(), Style: core.Style{FontSize: 10.5, Padding: core.Edges{Top: 6}},
							StyleFunc: ui.Colored(func() core.Color { return ui.Alpha(colors.OnLight(), 0.6) })},
					}},
				}}
		}
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
		Style:  core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
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
			}
			if a.active.Get() == id {
				rows = append(rows, a.sheetRow(lucide.PanelLeft, T("回到新建页"), colors.Text, func() {
					a.actionID.Set("")
					a.closeSession()
				}, "mobile-act-home"))
			}
			rows = append(rows,
				a.sheetRow(lucide.SquarePen, T("重命名"), colors.Text, func() {
					a.actionID.Set("")
					a.renameText.Set(s.Title)
					a.renameID.Set(id)
				}, "mobile-act-rename"),
				a.sheetRow(pinIcon, pinLabel, colors.Text, func() {
					a.actionID.Set("")
					a.setPinned(id, !s.Pinned)
				}, "mobile-act-pin"),
			)
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
		Title:  T("重命名会话"),
		TestID: "mobile-rename",
		Style:  core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			return core.Input{Value: a.renameText.Get, OnChange: a.renameText.Set, Label: T("会话名字"), TestID: "mobile-rename-input",
				Placeholder: T("给这个会话起个名字"), OnSubmit: func(string) { a.saveRename() },
				Style: core.Style{Height: core.Pt(42), Padding: core.Symmetric(0, 10), FontSize: 14, Color: colors.Text(),
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 9,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}}
		})},
		Footer: []core.Node{
			ui.Button{Text: T("保存"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-rename-save", OnPress: a.saveRename},
			ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.renameID.Set("") }},
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
		Title:       T("删除会话"),
		Description: T("会话文件会移到电脑数据目录的 trash 里，需要时可以找回。"),
		TestID:      "mobile-delete",
		Style:       core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Footer: []core.Node{
			ui.Button{Text: T("删除"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-delete-yes",
				OnPress: func() { a.deleteSession(a.deleteID.GetUntracked()) }},
			ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.deleteID.Set("") }},
		},
	}
}

// newSessionSheet picks the project the new session page starts in.
func (a *mobileApp) newSessionSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.newOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.newOpen.Set(false)
			}
		},
		Title:  T("在哪个项目里新建"),
		TestID: "mobile-new",
		Style:  core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			chosen := a.initProjectPath()
			var rows []core.Node
			for _, p := range a.state.Get().Projects {
				project := p
				on := project.Path == chosen
				row := core.View{OnPress: func(core.PressEvent) {
					a.newOpen.Set(false)
					a.initProject.Set(project.Path)
					a.saveLook()
				}, Role: core.RoleButton, Label: project.Name, TestID: "mobile-new-project",
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(46),
							Padding: core.Symmetric(0, 8), CornerRadius: 8, Transition: pressMotion,
							Active: &core.Style{Background: colors.Pressed()}}
					},
					Children: []core.Node{
						ui.Icon(lucide.Folder, 17, colors.Muted),
						core.Text{Content: project.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FlexGrow: 1, FontSize: 14}, StyleFunc: ui.Colored(colors.Text)},
						core.Show{When: func() bool { return on }, Then: func(*core.Scope) core.Node {
							return ui.Icon(lucide.Check, 15, colors.Text)
						}},
					}}
				rows = append(rows, row)
			}
			if len(rows) == 0 {
				rows = append(rows, core.Text{Content: "电脑上还没有项目，先添加一个文件夹。", Style: core.Style{FontSize: 12, Padding: core.Symmetric(8, 6)},
					StyleFunc: ui.Colored(colors.Faint)})
			}
			rows = append(rows, core.View{Style: core.Style{Margin: core.Edges{Top: 6}}, Children: []core.Node{
				a.sheetRow(lucide.FolderPlus, "添加项目…", colors.Accent, func() {
					a.newOpen.Set(false)
					a.addPath.Set("")
					a.addOpen.Set(true)
				}, "mobile-add-project"),
			}})
			return core.View{Style: core.Style{Gap: 2}, Children: rows}
		})},
	}
}

// addProjectSheet asks for a folder to put on the desktop's rail.
func (a *mobileApp) addProjectSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.addOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.addOpen.Set(false)
			}
		},
		Title:       T("添加项目"),
		Description: T("填电脑上的文件夹路径，和电脑端「添加工作区」是同一件事。"),
		TestID:      "mobile-add-project-sheet",
		Style:       core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			return core.Input{Value: a.addPath.Get, OnChange: a.addPath.Set, Label: T("文件夹路径"), TestID: "mobile-add-path",
				Placeholder: T("例如 C:/Users/me/project"), OnSubmit: func(string) { a.addProject() },
				Style: core.Style{Height: core.Pt(42), Padding: core.Symmetric(0, 10), FontSize: 13.5, Color: colors.Text(),
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 9,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}}
		})},
		Footer: []core.Node{
			ui.Button{Text: T("添加"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-add-yes", OnPress: a.addProject},
			ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.addOpen.Set(false) }},
		},
	}
}

// removeProjectSheet confirms taking a project off the desktop's rail.
func (a *mobileApp) removeProjectSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.removePath.Get() != "" },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.removePath.Set("")
			}
		},
		Title:       T("移除项目"),
		Description: T("只是从电脑端的侧栏移除，会话文件和项目目录都还在。"),
		TestID:      "mobile-remove-project-sheet",
		Footer: []core.Node{
			ui.Button{Text: T("移除"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-remove-yes",
				OnPress: func() { a.changeProject(a.removePath.GetUntracked(), true) }},
			ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.removePath.Set("") }},
		},
	}
}

// addProject applies the add sheet.
func (a *mobileApp) addProject() {
	path := strings.TrimSpace(a.addPath.GetUntracked())
	if path == "" {
		return
	}
	a.addOpen.Set(false)
	a.changeProject(path, false)
}

// changeProject adds or removes a folder on the desktop.
func (a *mobileApp) changeProject(path string, remove bool) {
	client := a.client
	if client == nil || path == "" {
		return
	}
	a.removePath.Set("")
	go func() {
		err := client.addProject(path, remove)
		a.cx.Post(func() {
			if err != nil {
				a.err.Set(remoteErrorText(err))
				return
			}
			a.err.Set("")
			if remove {
				a.flash("已移除项目")
			} else {
				a.flash("已添加项目")
			}
			a.refreshState()
		})
	}()
}

// startNewSession goes back to the new-session page, which is where a
// session starts: pick a project, write the first line.
func (a *mobileApp) startNewSession() {
	a.openDrawer(false)
	a.closeSession()
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

// retryBar offers the last prompt again after a failed turn.
func (a *mobileApp) retryBar(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.Show{When: func() bool {
		msgs := a.messages.Get()
		return len(msgs) > 0 && msgs[len(msgs)-1].Role == "error" && a.lastPrompt() != ""
	}, Then: func(*core.Scope) core.Node {
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(2, 12)},
			Children: []core.Node{
				ui.Button{Text: T("重试上一条"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "mobile-retry",
					OnPress: func() {
						text := a.lastPrompt()
						if text == "" {
							return
						}
						a.draft.Set(text)
						a.sendMessage()
					}},
				ui.Text(T("这一轮失败了"), 10.5, ui.Regular, colors.Faint),
			}}
	}}
}

// lastPrompt is the newest user message, the one a retry re-sends.
func (a *mobileApp) lastPrompt() string {
	msgs := a.messages.GetUntracked()
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			return strings.TrimSpace(msgs[i].Text)
		}
	}
	return ""
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
	return core.View{OnPress: func(core.PressEvent) { a.openOptions() }, Role: core.RoleButton, Label: T("模型与思考等级"),
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
			a.usageChip(),
		}}
}

// sessionStatsLabel names a session's context use and cost.
func sessionStatsLabel(tokenCount, context, window int, cost float64) string {
	var parts []string
	switch {
	case window > 0 && context > 0:
		parts = append(parts, tokens(context)+" / "+tokens(window))
	case tokenCount > 0:
		parts = append(parts, tokens(tokenCount)+" tokens")
	}
	if cost > 0 {
		parts = append(parts, fmt.Sprintf("$%.2f", cost))
	}
	return strings.Join(parts, " · ")
}

// usageChip shows the active session's context and cost.
func (a *mobileApp) usageChip() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		id := a.active.Get()
		var found *remoteWireSession
		for _, p := range a.state.Get().Projects {
			for i := range p.Sessions {
				if p.Sessions[i].ID == id {
					cp := p.Sessions[i]
					found = &cp
					break
				}
			}
		}
		if found == nil {
			return nil
		}
		label := sessionStatsLabel(found.Tokens, found.Context, found.ContextWindow, found.Cost)
		if label == "" {
			return nil
		}
		return core.View{TestID: "mobile-usage", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
			ui.Icon(lucide.Gauge, 10, colors.Faint),
			core.Text{Content: label, MaxLines: 1, Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
		}}
	})
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
		Title:        T("模型与思考"),
		TestID:       "mobile-options-sheet",
		Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
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
					ui.Text(T("思考等级"), 11, ui.Medium, colors.Faint),
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
					ui.Text(T("模型"), 11, ui.Medium, colors.Faint),
					core.Scroll{Style: core.Style{MaxHeight: core.Pt(320)}, Children: []core.Node{
						core.View{Style: core.Style{Gap: 1}, Children: rows},
					}},
				}})
			}
			if len(sections) == 0 {
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(10, 4)},
					Children: []core.Node{
						ui.Spinner{Size: 13, Label: T("正在读取")},
						ui.Text(T("正在读取模型列表…"), 12, ui.Regular, colors.Faint),
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

// scheduleSearch asks the desktop for message matches, once typing pauses.
func (a *mobileApp) scheduleSearch() {
	query := strings.TrimSpace(a.query.GetUntracked())
	if len([]rune(query)) < 2 {
		a.searchSeq++
		a.hits.Set(nil)
		a.hitsBusy.Set(false)
		return
	}
	a.searchSeq++
	seq := a.searchSeq
	a.hitsBusy.Set(true)
	a.cx.AfterFunc(320*time.Millisecond, func() {
		if seq != a.searchSeq || a.client == nil {
			return
		}
		client := a.client
		go func() {
			hits, err := client.search(query, "")
			a.cx.Post(func() {
				if seq != a.searchSeq {
					return
				}
				a.hitsBusy.Set(false)
				if err != nil {
					return
				}
				a.hits.Set(hits)
				a.hitsQuery = query
			})
		}()
	})
}

// hitRows are the message matches under the title matches.
func (a *mobileApp) hitRows(cx *core.Scope, query string) []core.Node {
	colors := ui.ColorsOf(cx)
	hits := a.hits.Get()
	if a.hitsBusy.Get() && len(hits) == 0 {
		return []core.Node{core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Padding: core.Symmetric(8, 16)},
			Children: []core.Node{ui.Spinner{Size: 12, Label: T("搜索消息")}, ui.Text(T("正在搜索消息…"), 11, ui.Regular, colors.Faint)}}}
	}
	if len(hits) == 0 {
		return nil
	}
	rows := make([]core.Node, 0, len(hits))
	for _, hit := range hits {
		h := hit
		rows = append(rows, core.View{OnPress: func(core.PressEvent) {
			a.searchOpen.Set(false)
			a.query.Set("")
			a.hits.Set(nil)
			a.openSession(h.Session, h.Title)
			// Land on the matches rather than the top of a long history.
			a.findText.Set(strings.TrimSpace(a.hitsQuery))
			a.findOpen.Set(true)
		}, Role: core.RoleButton, Label: h.Title, TestID: "mobile-hit",
			StyleFunc: func() core.Style {
				return core.Style{Gap: 2, Padding: core.Symmetric(7, 12), CornerRadius: 8, Transition: pressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Icon(lucide.MessageSquare, 11, colors.Faint),
					core.Text{Content: h.Title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexGrow: 1, FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
					ui.Text(h.Project, 9.5, ui.Regular, colors.Faint),
				}},
				core.Text{Content: h.Snippet, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)},
			}})
	}
	return []core.Node{core.View{Style: core.Style{Gap: 1, Margin: core.Edges{Bottom: 14}}, Children: append([]core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Padding: core.Symmetric(8, 16)}, Children: []core.Node{
			ui.Icon(lucide.Search, 13, colors.Muted),
			core.Text{Content: T("消息匹配"), MaxLines: 1, Style: core.Style{FlexGrow: 1, FontSize: 12, FontWeight: ui.Semibold},
				StyleFunc: ui.Colored(colors.Text)},
			ui.Text(fmt.Sprint(len(hits)), 10, ui.Regular, colors.Faint),
		}},
	}, rows...)}}
}

// --- saved connection ----------------------------------------------------

func loadMobileSaved(cx *core.Scope) mobileSaved {
	raw, err := readMobileStore(cx)
	if err != nil {
		return mobileSaved{}
	}
	var saved mobileSaved
	if json.Unmarshal(raw, &saved) != nil {
		return mobileSaved{}
	}
	return saved
}

// rememberConnection puts one server first in the list, keeping five.
func rememberConnection(list []mobileRecent, item mobileRecent) mobileSaved {
	out := make([]mobileRecent, 0, 5)
	out = append(out, item)
	for _, old := range list {
		if old.Server == item.Server || len(out) >= 5 {
			continue
		}
		out = append(out, old)
	}
	return mobileSaved{Server: item.Server, Token: item.Token, Recent: out}
}

func saveMobileSaved(cx *core.Scope, saved mobileSaved) {
	raw, _ := json.Marshal(saved)
	_ = writeMobileStore(cx, raw)
}
