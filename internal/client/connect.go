package client

// The phone build: it connects to a desktop PiDeck server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_V2_MOBILE=1 for a preview on a desktop).

import (
	"bytes"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	"example.com/pideck/assets"
	"example.com/pideck/internal/appinfo"
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/relaywire"
	"example.com/pideck/internal/remotewire"
	"example.com/pideck/internal/viewkit"
	"github.com/makiuchi-d/gozxing"
	"github.com/makiuchi-d/gozxing/qrcode"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

const maxScanImageBytes = 6 << 20
const maxScanImagePixels = 20_000_000

var errScanImageTooLarge = errors.New("scan image exceeds limit")
var errScanImageDimensionsTooLarge = errors.New("scan image dimensions exceed limit")

// connectView asks for the desktop's link and token.
func (a *mobileApp) connectView(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	field := func(label, placeholder, testID string, value *core.Signal[string], submit func(), extra core.Node) core.Node {
		input := core.Input{
			Value: value.Get, OnChange: value.Set, Placeholder: placeholder, Label: label, TestID: testID,
			OnSubmit: func(string) { submit() },
			Style:    core.Style{Height: core.Pt(44), Padding: core.Symmetric(0, 12), FontSize: 14, Color: colors.Text()},
			StyleFunc: func() core.Style {
				return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 10,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
			},
		}
		row := []core.Node{core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{input}}}
		if extra != nil {
			row = append(row, extra)
		}
		return core.View{Style: core.Style{Gap: 5}, Children: []core.Node{
			ui.Text(label, 11, ui.Medium, colors.Muted),
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: row},
		}}
	}
	card := core.View{StyleFunc: func() core.Style {
		return core.Style{Gap: 12, Padding: core.All(16), CornerRadius: 14, Background: colors.Surface(),
			BorderWidth: 1, BorderColor: colors.Border()}
	}, Children: []core.Node{
		field(apptext.T("连接地址"), "http://192.168.1.8:8787/?token=…", "mobile-server", a.server, a.onConnectPress,
			ui.Button{Text: apptext.T("连接"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "mobile-connect-inline",
				Disabled: func() bool { return a.busy.Get() }, OnPress: a.onConnectPress}),
		field(apptext.T("访问令牌"), "粘贴电脑端显示的令牌", "mobile-token", a.token, a.onConnectPress, nil),
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
					return ui.Spinner{Size: 14, Label: apptext.T("连接中")}
				}
				return nil
			}),
			ui.Button{Text: apptext.T("连接"), Variant: ui.ButtonPrimary, Size: ui.SizeLarge, Flex: 1, TestID: "mobile-connect",
				Disabled: func() bool { return a.busy.Get() }, OnPress: a.onConnectPress},
		}},
		core.Show{When: func() bool { return a.busy.Get() }, Then: func(cx *core.Scope) core.Node {
			return core.Text{Content: apptext.T("正在连接，首次可能要多等几秒…"), MaxLines: 2,
				Style:     core.Style{FontSize: 10.5, LineHeight: 15, TextAlign: core.TextAlignCenter},
				StyleFunc: ui.Colored(colors.Faint)}
		}},
		ui.Button{Text: apptext.T("粘贴并连接"), Variant: ui.ButtonSecondary, Size: ui.SizeLarge, TestID: "mobile-paste-connect",
			OnPress: a.pasteAndConnect},
		ui.Button{Text: apptext.T("扫码连接"), Variant: ui.ButtonSecondary, Size: ui.SizeLarge, TestID: "mobile-scan",
			OnPress: a.scanQR},
		ui.Button{Text: apptext.T("从相册选二维码"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "mobile-scan-library",
			OnPress: a.scanImage},
	}}
	column := core.View{Style: core.Style{Width: core.Pct(100), MaxWidth: core.Pt(480), Gap: 16}, Children: []core.Node{
		core.Image{Source: core.ImageSource{Data: assets.LogoPNG}, ResizeMode: core.Contain, Label: "PiDeck",
			Style: core.Style{Width: core.Pt(64), Height: core.Pt(64), CornerRadius: 18, AlignSelf: core.AlignCenter}},
		core.View{Style: core.Style{Gap: 4, AlignItems: core.AlignCenter}, Children: []core.Node{
			ui.Text("PiDeck", 24, ui.Bold, colors.Text),
			ui.Text(apptext.T("连接电脑上的会话"), 13, ui.Regular, colors.Muted),
		}},
		card,
		a.recentList(),
		core.Text{Content: apptext.T("在电脑端打开 设置 → 远程，启用后扫码或复制连接链接；局域网、Tailscale、EasyTier 或中继任选其一。"),
			Style: core.Style{FontSize: 11, LineHeight: 17, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Faint)},
	}}
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0),
		PaddingEnv: core.EnvEdges{Top: core.EnvSafeArea, Right: core.EnvSafeArea, Left: core.EnvSafeArea, Bottom: core.EnvKeyboard}},
		Children: []core.Node{core.Scroll{Style: ui.FillRest, Behavior: core.ScrollBehavior{KeyboardDismissMode: core.KeyboardDismissOnDrag}, Children: []core.Node{
			// A form taller than the phone must scroll from the top: a
			// centered flex child that overflows hides its buttons under
			// the keyboard.
			core.View{Style: core.Style{Padding: core.Edges{Top: 36, Bottom: 24, Left: 24, Right: 24}, Gap: 16, AlignItems: core.AlignCenter},
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
			host := serverHostLabel(r.Server)
			rows = append(rows, core.View{OnPress: func(core.PressEvent) {
				a.server.Set(r.Server)
				a.token.Set(r.Token)
				a.connect()
			}, Role: core.RoleButton, Label: r.Name, TestID: "mobile-recent",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(46),
						Padding: core.Symmetric(0, 10), CornerRadius: 10, Transition: viewkit.PressMotion,
						Background: colors.Surface(), Hover: &core.Style{Background: colors.Hover()},
						Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					ui.Icon(lucide.Laptop, 15, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: r.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 13}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{Content: host, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
					}},
					ui.Icon(lucide.ChevronRight, 13, colors.Faint),
				}})
		}
		return core.View{Style: core.Style{Width: core.Pct(100), MaxWidth: core.Pt(480), Gap: 6}, Children: []core.Node{
			ui.Text(apptext.T("最近连接"), 11, ui.Medium, colors.Faint),
			core.View{Style: core.Style{Gap: 4}, Children: rows},
		}}
	}}
}

// scanImage reads a code from a picture already on the phone.
func (a *mobileApp) scanImage() {
	a.err.Set("")
	a.cx.PickFiles(core.PickFilesOptions{Types: []string{"image/*"}, Limit: 1}, func(files []core.File, err error) {
		if err != nil {
			a.err.Set(apptext.T("打开相册失败") + "：" + err.Error())
			return
		}
		if len(files) == 0 {
			return
		}
		path := files[0].Path
		go func() {
			data, readErr := readScanImage(path)
			a.cx.Post(func() {
				if errors.Is(readErr, errScanImageTooLarge) {
					a.err.Set(apptext.T("图片太大，上限 6 MB"))
					return
				}
				if readErr != nil || len(data) == 0 {
					a.err.Set(apptext.T("读不到这张图片"))
					return
				}
				a.useScanned(data)
			})
		}()
	})
}

// readScanImage bounds gallery input before decoding an untrusted image.
func readScanImage(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if info, err := f.Stat(); err == nil && info.Size() > maxScanImageBytes {
		return nil, errScanImageTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(f, maxScanImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxScanImageBytes {
		return nil, errScanImageTooLarge
	}
	return data, nil
}

// useScanned decodes a picture and connects to what it holds.
func (a *mobileApp) useScanned(data []byte) {
	go func() {
		link, err := decodeQRLink(data)
		a.cx.Post(func() {
			if errors.Is(err, errScanImageTooLarge) {
				a.err.Set(apptext.T("图片太大，上限 6 MB"))
				return
			}
			if errors.Is(err, errScanImageDimensionsTooLarge) {
				a.err.Set(apptext.T("图片尺寸过大，无法识别二维码"))
				return
			}
			if err != nil || link == "" {
				a.err.Set(apptext.T("这张图里没有二维码"))
				return
			}
			a.connectScanned(link)
		})
	}()
}

// connectScanned validates untrusted QR text before putting it in the form.
func (a *mobileApp) connectScanned(text string) {
	client, token, err := newRemoteClient(text, "")
	if err != nil {
		a.err.Set(err.Error())
		return
	}
	if token == "" {
		client.close()
		a.server.Set(client.source)
		a.token.Set("")
		a.err.Set(apptext.T("请填写访问令牌，或粘贴完整的连接链接"))
		return
	}
	client.close()
	a.server.Set(client.source)
	a.token.Set(token)
	a.connect()
}

// scanQR prefers the live scanner and keeps photo capture as a platform fallback.
func (a *mobileApp) scanQR() {
	a.err.Set("")
	env := a.cx.Env()
	if env.CanScanCode() {
		a.cx.ScanCode(core.ScanOptions{}, func(code *core.ScannedCode, err error) {
			if errors.Is(err, core.ErrNoScanner) && a.cx.Env().CanTakePhoto() {
				a.scanQRPhoto()
				return
			}
			if err != nil {
				a.err.Set(apptext.T("扫码失败：%s", err.Error()))
				return
			}
			if code == nil {
				return
			}
			a.connectScanned(code.Text)
		})
		return
	}
	if !env.CanTakePhoto() {
		a.err.Set(apptext.T("这台设备没有可用的相机，用下面的链接和令牌连接吧"))
		return
	}
	a.scanQRPhoto()
}

// scanQRPhoto reads a code from a single photo on platforms without live scanning.
func (a *mobileApp) scanQRPhoto() {
	a.cx.TakePhoto(core.PhotoOptions{MaxDimension: 1600}, func(photo *core.PickedFile, err error) {
		if err != nil {
			a.err.Set(apptext.T("打开相机失败：%s", err.Error()))
			return
		}
		if photo == nil || len(photo.Data) == 0 {
			return
		}
		a.useScanned(photo.Data)
	})
}

// noQRCode is what a picture without a readable code says.
var noQRCode = errors.New("没有二维码")

// decodeQRLink reads the first QR code in a JPEG or PNG.
func decodeQRLink(data []byte) (string, error) {
	if len(data) > maxScanImageBytes {
		return "", errScanImageTooLarge
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxScanImagePixels {
		return "", errScanImageDimensionsTooLarge
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	bitmap, err := gozxing.NewBinaryBitmapFromImage(img)
	if err != nil {
		return "", err
	}
	// TRY_HARDER is a phone photo of a screen at an angle: it costs the
	// cheap passes nothing and is what finds the code in a poor capture.
	read, err := qrcode.NewQRCodeReader().Decode(bitmap, map[gozxing.DecodeHintType]interface{}{
		gozxing.DecodeHintType_TRY_HARDER: true,
	})
	if err != nil {
		return "", noQRCode
	}
	if read == nil || read.GetText() == "" {
		return "", noQRCode
	}
	return read.GetText(), nil
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
		a.err.Set(apptext.T("请填写访问令牌，或粘贴完整的连接链接"))
		return
	}
	gen := a.gen
	a.busy.Set(true)
	a.err.Set("")
	// A relay desktop may be redialing the relay right now; give it a few
	// tries instead of failing on the first 409.
	attempts := 1
	if relaywire.IsLink(client.source) {
		attempts = 2
	}
	go func() {
		var ping remotePing
		var snap remotewire.Snapshot
		var err error
		for i := 0; i < attempts; i++ {
			ping, err = client.ping()
			if err == nil {
				snap, err = client.state()
			}
			if err == nil || errors.Is(err, errRemoteAuth) {
				break
			}
			if i+1 < attempts {
				time.Sleep(1500 * time.Millisecond)
			}
		}
		a.cx.Post(func() {
			if gen != a.gen {
				client.close()
				return
			}
			a.busy.Set(false)
			if err != nil {
				client.close()
				a.err.Set(remoteErrorText(err))
				return
			}
			// A desktop may have rotated its token while this connect was in
			// flight, and the reply already carried the new one.
			token = client.currentToken()
			client.onToken = func(token string) { a.rememberRotatedToken(client, token) }
			a.client = client
			a.server.Set(client.source)
			a.token.Set(token)
			a.serverName.Set(mobileServerName(ping, snap))
			a.desktopVersion.Set(ping.Version)
			a.state.Set(snap)
			a.connected.Set(true)
			a.err.Set("")
			saved := rememberConnection(a.recent.GetUntracked(), mobileRecent{
				Server: client.source, Token: token, Name: a.serverName.Get(), At: time.Now().UnixMilli(),
			})
			a.recent.Set(saved.Recent)
			// The look, the language and the last project are kept beside the
			// connection, so saveLook writes all of them.
			a.saveLook()
			a.startPolling()
			// A reload or a shared link names a session; the state that
			// lists it is here now, so the page lands on it.
			a.resumeWebRoute()
			// The token was read from the address on the way in. Now that it
			// works, the address keeps only the route, so it does not sit in
			// the browser's history, a bookmark or a screenshot of this
			// window.
			a.syncWebAddress(false)
		})
	}()
}

// rememberRotatedToken keeps the token a desktop issued while the phone was
// connected: the saved connection and the recent list would otherwise hold
// the one the rotation replaced, and reopening the app would be refused.
func (a *mobileApp) rememberRotatedToken(client *remoteClient, token string) {
	a.cx.Post(func() {
		if a.client != client || token == "" || token == a.token.GetUntracked() {
			return
		}
		a.token.Set(token)
		saved := rememberConnection(a.recent.GetUntracked(), mobileRecent{
			Server: a.server.GetUntracked(), Token: token, Name: a.serverName.GetUntracked(), At: time.Now().UnixMilli(),
		})
		a.recent.Set(saved.Recent)
		a.saveLook()
	})
}

// pasteAndConnect takes the link from the clipboard, so a phone can
// connect without opening the keyboard.
func (a *mobileApp) pasteAndConnect() {
	a.cx.ReadClipboard(func(text string) {
		text = strings.TrimSpace(text)
		if text == "" {
			a.err.Set(apptext.T("剪贴板里没有链接"))
			return
		}
		if client, token, err := newRemoteClient(text, ""); err == nil {
			client.close()
			if token != "" {
				a.token.Set(token)
			}
		}
		a.server.Set(text)
		a.connect()
	})
}

// onConnectPress hides the keyboard and connects, so the attempt has the
// whole screen.
func (a *mobileApp) onConnectPress() {
	a.cx.DismissKeyboard()
	a.connect()
}

// serverHostLabel is the second line of a recent connection: its address,
// or the relay a pairing link goes through.
func serverHostLabel(server string) string {
	if relaywire.IsLink(server) {
		if link, err := relaywire.Parse(server); err == nil {
			if u, err := url.Parse(link.Relay); err == nil && u.Host != "" {
				return apptext.T("中继 · %s", u.Host)
			}
		}
		return apptext.T("中继")
	}
	return strings.TrimPrefix(strings.TrimPrefix(server, "http://"), "https://")
}

func mobileServerName(ping remotePing, snap remotewire.Snapshot) string {
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
	a.sessionSeq++
	a.disconnectFileViews()
	a.client.close()
	a.client = nil
	a.busy.Set(false)
	a.stateLoading = false
	a.refreshing.Set(false)
	a.connected.Set(false)
	a.active.Set("")
	a.messages.Set(nil)
	a.transcriptErr.Set("")
	a.transcriptBusy.Set(false)
	a.olderBusy.Set(false)
	a.ask.Set(nil)
	a.state.Set(remotewire.Snapshot{})
	a.syncWebAddress(false)
	a.err.Set(message)
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
			// sheet. Once the desktop has answered with a ready session there
			// is nothing left to wait for: every user action that changes a
			// choice reads the options itself, so a sheet left open is not
			// rebuilt under the reader twice a second.
			if a.options.GetUntracked().Model == "" {
				a.loadOptions(a.active.GetUntracked())
			}
		}
		wait := 2500 * time.Millisecond
		if a.running.GetUntracked() {
			wait = 1200 * time.Millisecond
		}
		// A phone in the background is not being read; poll rarely and let
		// the resume effect catch up.
		if a.cx.Env().Lifecycle() == core.LifecycleBackground {
			wait = 20 * time.Second
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
			// The old server cannot publish data, errors or loading state
			// after disconnecting or switching to another connection.
			if a.client != client {
				return
			}
			a.stateLoading = false
			a.refreshing.Set(false)
			if err != nil {
				if errors.Is(err, errRemoteAuth) {
					a.disconnectWith(remoteErrorText(err))
				} else {
					a.err.Set(pollErrorText(err))
				}
				return
			}
			a.state.Set(snap)
			a.syncMode(snap)
			a.err.Set("")
		})
	}()
}

// pageStale says the page was built before the desktop it talks to, which
// only a browser page can be: a reload takes the newer one.
func (a *mobileApp) pageStale() bool {
	return webMode() && a.desktopVersion.Get() != "" && a.desktopVersion.Get() != appinfo.Version
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
						return apptext.T("这个页面是 %s，电脑上是 %s；刷新后一起用新版本", appinfo.Version, a.desktopVersion.Get())
					}, MaxLines: 2, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11},
						StyleFunc: ui.Colored(colors.Text)},
					ui.Button{Text: apptext.T("刷新页面"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "mobile-reload", OnPress: func() { webReload() }},
				}}
		}},
	}}
}
