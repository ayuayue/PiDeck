//go:build !js && !android && !ios

package workbench

// The "Remote" settings section: the phone server's switch, port and
// token, and the addresses the phone can use over the LAN, Tailscale or
// EasyTier.

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// selfHostDocsURL is the step-by-step guide for a user's own tunnel or
// Worker.
const selfHostDocsURL = "https://github.com/ayuayue/PiDeck-V2/blob/main/docs/remote-self-host.md"

// settingsRemote draws the remote access section.
func (a *app) settingsRemote() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		if a.remote == nil {
			return core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(apptext.T("远程服务不可用"), 12.5, ui.Regular, colors.Muted)}}
		}
		st := a.remote.state.Get()
		status := "未开启"
		if st.Running {
			status = fmt.Sprintf("运行中 · 端口 %d", st.Port)
		}
		if st.Error != "" {
			status = "启动失败：" + st.Error
		}
		statusTone := colors.Faint
		if st.Running {
			statusTone = colors.Up
		}
		if st.Error != "" {
			statusTone = colors.Danger
		}
		if st.Detecting {
			status, statusTone = "正在检测网络…", colors.Faint
		}
		copyLink := func(testID string, ip string) core.Node {
			return ui.Button{Text: apptext.T("复制链接"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: testID,
				Disabled: func() bool { return !st.Running },
				OnPress:  func() { a.copyText(a.remote.link(ip), "连接链接") }}
		}
		qrButton := func(ip string) core.Node {
			return hintOf(func() string { return apptext.T("显示二维码") }, ui.IconButton{Icon: lucide.QrCode, Label: apptext.T("显示二维码"), Size: 24, IconSize: 13,
				Disabled: func() bool { return !st.Running }, OnPress: func() { a.showQR(a.remote.link(ip)) }})
		}
		addressRow := func(name, detail, ip, testID string) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(30)},
				Children: []core.Node{
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: ip, MaxLines: 1, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11},
							StyleFunc: ui.Colored(colors.Text)},
						core.Text{Content: detail, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
					}},
					ui.Text(name, 9.5, ui.Regular, colors.Faint),
					qrButton(ip),
					copyLink(testID, ip),
				}}
		}
		var lanRows []core.Node
		for i, address := range st.LAN {
			detail := "局域网"
			if address.Interface != "" {
				detail = "局域网 · " + address.Interface
			}
			lanRows = append(lanRows, addressRow("", detail, address.Address, fmt.Sprintf("remote-lan-%d", i)))
		}
		if len(lanRows) == 0 {
			lanRows = append(lanRows, core.Text{Content: apptext.T("没有可用的局域网地址"), Style: core.Style{FontSize: 11, Padding: core.Symmetric(3, 2)},
				StyleFunc: ui.Colored(colors.Faint)})
		}

		channel := func(icon func() *core.SVG, name, note string, ch remoteChannel, rows ...core.Node) core.Node {
			tone := colors.Faint
			label := "未检测到"
			switch {
			case ch.Ready:
				tone, label = colors.Up, "可用"
			case ch.Installed:
				tone, label = colors.Warn, "未就绪"
			}
			children := []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
					ui.Icon(icon, 13, colors.Muted),
					ui.Text(name, 12, ui.Semibold, colors.Text),
					core.View{StyleFunc: func() core.Style {
						return core.Style{Padding: core.Symmetric(1, 6), CornerRadius: 8, Background: ui.Alpha(tone(), 0.10)}
					}, Children: []core.Node{ui.Text(label, 9, ui.Medium, tone)}},
					core.View{Style: core.Style{FlexGrow: 1}},
				}},
				core.Text{Content: note, Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)},
			}
			if ch.Detail != "" {
				children = append(children, core.Text{Content: ch.Detail, MaxLines: 1, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10},
					StyleFunc: ui.Colored(colors.Muted)})
			}
			if ch.Error != "" {
				children = append(children, core.Text{Content: ch.Error, MaxLines: 2, Style: core.Style{FontSize: 10.5, LineHeight: 15},
					StyleFunc: ui.Colored(colors.Danger)})
			}
			if ch.Ready && ch.Address != "" {
				children = append(children, addressRow("", "虚拟地址", ch.Address, "remote-"+strings.ToLower(name)))
			}
			children = append(children, rows...)
			return core.View{StyleFunc: func() core.Style {
				return core.Style{Gap: 5, Padding: core.All(10), CornerRadius: 8, BorderWidth: 1,
					BorderColor: colors.Now().Line, Background: colors.Inset()}
			}, Children: children}
		}

		token := st.Token
		emptyToken := token == ""
		if emptyToken {
			token = "启用后生成"
		}
		manualET := core.Input{
			Value: func() string { return a.cfg.RemoteEasyTierIP }, OnChange: func(v string) { a.cfg.RemoteEasyTierIP = v },
			OnSubmit:    func(v string) { a.remote.setEasyTierIP(v) },
			Placeholder: apptext.T("手动填写 EasyTier 虚拟 IP"), Label: apptext.T("EasyTier 虚拟 IP"), TestID: "remote-easytier-ip",
			Style: core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 8), FontSize: 11, Color: colors.Text(),
				Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6},
		}

		publicLink := a.remote.publicLink()
		relayLink := a.remote.relayLink()
		relayStatus, relayTone := apptext.T("未开启"), colors.Faint
		switch {
		case st.Relay.Address == "":
			relayStatus = apptext.T("先填写中继地址")
		case st.RelayOn && st.Relay.Error != "":
			relayStatus, relayTone = st.Relay.Error, colors.Danger
		case st.RelayOn && st.Relay.Ready:
			relayStatus, relayTone = apptext.T("已连接中继，等待手机连接"), colors.Up
		case st.RelayOn:
			relayStatus, relayTone = apptext.T("正在连接中继…"), colors.Warn
		}
		publicInput := core.Input{
			Value: func() string { return a.cfg.RemotePublicURL }, OnChange: func(v string) { a.cfg.RemotePublicURL = v },
			OnSubmit:    func(v string) { a.remote.setPublicURL(v) },
			Placeholder: "https://pideck.example.com", Label: apptext.T("自定义公网地址"), TestID: "remote-public-url",
			Style: core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 8), FontSize: 11, Color: colors.Text(),
				Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6},
		}
		relayInput := core.Input{
			Value: func() string { return a.cfg.RemoteRelayURL }, OnChange: func(v string) { a.cfg.RemoteRelayURL = v },
			OnSubmit:    func(v string) { a.remote.setRelayURL(v) },
			Placeholder: "wss://relay.example.com/v1/tunnel", Label: apptext.T("中继地址"), TestID: "remote-relay-url",
			Style: core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 8), FontSize: 11, Color: colors.Text(),
				Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6},
		}

		return a.scrollStashFor("settingsRemote:1").Bind(cx, core.Scroll{TestID: "settings-page", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 0}, Children: []core.Node{
				setGroup("服务",
					setRow("远程访问", "让手机端连接这台电脑上的项目和会话；关闭后所有手机连接立即断开。",
						ui.Switch{Checked: func() bool { return st.Enabled }, Label: apptext.T("允许手机连接"), TestID: "remote-enabled",
							OnChange: func(on bool) { a.remote.setEnabled(on) }}),
					setDivider(),
					setRow("端口", "手机连接地址里的端口，需在防火墙中放行。",
						ui.NumberInput{Value: func() float64 { return float64(st.Port) }, Min: 1024, Max: 65535, Step: 1,
							Label: apptext.T("远程端口"), TestID: "remote-port",
							OnChange: func(v float64) { a.remote.setPort(int(v)) },
							Style:    core.Style{Width: core.Pt(92)}}),
					setDivider(),
					core.View{Style: core.Style{Gap: 5, Padding: core.Symmetric(6, 2)}, Children: []core.Node{
						setRow("访问令牌", "手机端连接时需要；重新生成会让旧手机失效。", nil),
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
							core.Text{Content: token, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
								Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Muted)},
							ui.Button{Text: apptext.T("复制"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, Disabled: func() bool { return emptyToken },
								OnPress: func() { a.copyText(a.remote.state.GetUntracked().Token, "访问令牌") }},
							ui.Button{Text: apptext.T("重新生成"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
								a.remote.rotateToken()
								a.toast(ui.ToastInfo, "访问令牌已重新生成", "旧手机会在下一次请求时断开。")
							}},
						}},
					}},
					core.Dynamic(func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(4, 2)}, Children: []core.Node{
							core.View{Style: core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, Background: statusTone()}},
							ui.Text(status, 10.5, ui.Regular, statusTone),
							core.View{Style: core.Style{FlexGrow: 1}},
							ui.Button{Text: apptext.T("重新检测网络"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "remote-refresh",
								OnPress: func() { a.remote.refresh() }},
						}}
					}),
				),
				setGroup("连接方式",
					core.View{Style: core.Style{Padding: core.Edges{Bottom: 4}}, Children: []core.Node{
						ui.Text(apptext.T("手机与电脑需能互通；复制链接后粘贴到手机端即可。"), 10.5, ui.Regular, colors.Faint)}},
					channel(lucide.Wifi, "局域网", "同一 Wi-Fi 或路由器下直连。", remoteChannel{Installed: true, Ready: len(st.LAN) > 0}, lanRows...),
					channel(lucide.Smartphone, "Android 模拟器", "在电脑上的 Android 模拟器里运行时，用 10.0.2.2 指向这台电脑，不依赖局域网。",
						remoteChannel{Installed: true, Ready: true},
						addressRow("", "模拟器专用", "10.0.2.2", "remote-emulator")),
					channel(lucide.Waypoints, "Tailscale", "同一 tailnet 内使用 100.x 虚拟地址直连。", st.Tailscale),
					channel(lucide.Network, "EasyTier", "同一 EasyTier 网络内使用虚拟地址直连。", st.EasyTier,
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
							core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{manualET}},
							ui.Button{Text: apptext.T("应用 IP"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
								a.remote.setEasyTierIP(a.cfg.RemoteEasyTierIP)
							}},
						}},
					),
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(4, 2)}, Children: []core.Node{
						core.Text{Content: apptext.T("用自己的 Cloudflare Tunnel、Worker 或反向代理？"), MaxLines: 2,
							Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 10, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)},
						ui.Button{Text: apptext.T("自建步骤"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "remote-self-host-docs",
							OnPress: func() { a.cx.OpenURL(selfHostDocsURL, nil) }},
					}},
				),
				setGroup("自定义公网地址",
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(4, 2)}, Children: []core.Node{
						core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{publicInput}},
						ui.Button{Text: apptext.T("应用地址"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "remote-public-apply",
							OnPress: func() { a.remote.setPublicURL(a.cfg.RemotePublicURL) }},
					}},
					core.Show{When: func() bool { return publicLink != "" }, Then: func(cx *core.Scope) core.Node {
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(3, 2)},
							Children: []core.Node{
								core.Text{Content: publicLink, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
									Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Muted)},
								ui.Button{Text: apptext.T("复制链接"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "remote-public-copy",
									OnPress: func() { a.copyText(a.remote.publicLink(), "连接链接") }},
								hintOf(func() string { return apptext.T("显示二维码") }, ui.IconButton{Icon: lucide.QrCode, Label: apptext.T("显示二维码"),
									Size: 24, IconSize: 13, TestID: "remote-public-qr",
									OnPress: func() { a.showQR(a.remote.publicLink()) }}),
							}}
					}},
					core.View{Style: core.Style{Padding: core.Symmetric(2, 2)}, Children: []core.Node{
						core.Text{Content: apptext.T("把 Cloudflare Tunnel、反向代理或自己的域名转发到上面的端口，再填这里；建议用 https。"),
							Style: core.Style{FontSize: 10, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)}}},
				),
				setGroup("外网访问",
					setRow("中继连接", "手机不用装 VPN：电脑主动连到中继，手机扫码即可；中继只转发加密流量。",
						ui.Switch{Checked: func() bool { return st.RelayOn }, Label: apptext.T("中继连接"), TestID: "remote-relay",
							OnChange: func(on bool) { a.remote.setRelayEnabled(on) }}),
					setDivider(),
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(4, 2)}, Children: []core.Node{
						core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{relayInput}},
						ui.Button{Text: apptext.T("应用地址"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "remote-relay-apply",
							OnPress: func() { a.remote.setRelayURL(a.cfg.RemoteRelayURL) }},
					}},
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(3, 2)}, Children: []core.Node{
						core.View{Style: core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, Background: relayTone()}},
						core.Text{Content: relayStatus, MaxLines: 3, EllipsizeMode: core.EllipsizeTail,
							Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 10.5, LineHeight: 15},
							StyleFunc: ui.Colored(relayTone)},
						ui.Button{Text: apptext.T("测试连接"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "remote-relay-test",
							OnPress: a.testRelay},
						core.Show{When: func() bool {
							return defaultRelayURL != "" && normalizeRelayURL(a.cfg.RemoteRelayURL) != normalizeRelayURL(defaultRelayURL)
						}, Then: func(*core.Scope) core.Node {
							return ui.Button{Text: apptext.T("恢复默认"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "remote-relay-default",
								OnPress: func() {
									a.cfg.RemoteRelayURL = defaultRelayURL
									a.remote.setRelayURL(defaultRelayURL)
								}}
						}},
					}},
					core.Show{When: func() bool { return relayLink != "" }, Then: func(cx *core.Scope) core.Node {
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(4, 2)},
							Children: []core.Node{
								core.Text{Content: relayLink, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
									Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Faint)},
								ui.Button{Text: apptext.T("复制配对链接"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "remote-relay-copy",
									OnPress: func() { a.copyText(a.remote.relayLink(), "配对链接") }},
								hintOf(func() string { return apptext.T("显示二维码") }, ui.IconButton{Icon: lucide.QrCode, Label: apptext.T("显示二维码"),
									Size: 24, IconSize: 13, TestID: "remote-relay-qr",
									OnPress: func() { a.showQR(a.remote.relayLink()) }}),
							}}
					}},
					core.View{Style: core.Style{Padding: core.Symmetric(2, 2)}, Children: []core.Node{
						core.Text{Content: apptext.T("可以换成自己的 Cloudflare Worker：部署 infra/relay-worker 后，把 wss://…/v1/tunnel 填在上面。配对链接里含访问令牌，只发给可信设备。"),
							Style: core.Style{FontSize: 10, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)}}},
				),
				setGroup("手机端",
					core.View{Style: core.Style{Gap: 4, Padding: core.Symmetric(4, 2)}, Children: []core.Node{
						core.Text{Content: apptext.T("手机打开 PiDeck V2，把上面的「复制链接」粘贴到地址栏并连接。手机端当前可浏览项目和会话历史。"),
							Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Muted)},
						core.Text{Content: apptext.T("链接里包含访问令牌，不要转发给不可信的设备。"), Style: core.Style{FontSize: 10.5, LineHeight: 16},
							StyleFunc: ui.Colored(colors.Faint)},
					}},
				),
			}},
		}})
	})
}

// testRelay dials the address in the field as a throwaway desktop, so a
// self-hosted relay can be checked before the switch is turned on.
func (a *app) testRelay() {
	raw := strings.TrimSpace(a.cfg.RemoteRelayURL)
	if raw == "" {
		a.toast(ui.ToastError, "中继不可用", "先填写中继地址")
		return
	}
	go func() {
		err := a.remote.probeRelay(raw)
		a.cx.Post(func() {
			if err != nil {
				a.toast(ui.ToastError, "中继不可用", err.Error())
				return
			}
			a.toast(ui.ToastSuccess, "中继可用", "已连上中继，可以打开开关了")
		})
	}()
}

// showQR opens the dialog with a link's QR code.
func (a *app) showQR(link string) {
	a.qrLink.Set(link)
	a.qrPNG = qrPNGFor(link)
	a.qrOpen.Set(true)
}

// remoteQRDialog draws the link as a code the phone can scan.
func (a *app) remoteQRDialog() core.Node {
	colors := ui.ColorsOf(a.cx)
	return ui.Dialog{
		Open:         a.qrOpen.Get,
		OnOpenChange: func(open bool, _ base.Reason) { a.qrOpen.Set(open) },
		Title:        apptext.T("扫码连接"),
		Description:  apptext.T("手机端打开 PiDeck V2，点「扫码连接」对着这里扫。"),
		TestID:       "remote-qr",
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			png := a.qrPNG
			if len(png) == 0 {
				return ui.Text(apptext.T("这个链接太长，二维码装不下；用「复制链接」吧。"), 11.5, ui.Regular, colors.Faint)
			}
			return core.View{Style: core.Style{Gap: 10, AlignItems: core.AlignCenter}, Children: []core.Node{
				core.View{Style: core.Style{Padding: core.All(10), CornerRadius: 10, Background: core.RGBA(0xFFFFFF, 1)},
					Children: []core.Node{core.Image{Source: core.ImageSource{Data: png}, ResizeMode: core.Contain,
						Label: apptext.T("连接二维码"), Style: core.Style{Width: core.Pt(240), Height: core.Pt(240)}}}},
				core.Text{Content: a.qrLink.Get(), MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Faint)},
			}}
		})},
	}
}
