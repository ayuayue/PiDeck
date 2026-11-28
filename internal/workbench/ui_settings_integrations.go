//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
	"strconv"
	"strings"
)

// settingsIntegrations configures the Feishu group bot.
func (a *app) settingsIntegrations() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// Redrawn when any setting changes: their values live in the config.
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		field := func(value func() string, set func(string), placeholder, label, testID string, masked bool) core.Node {
			return core.Input{Value: value, OnChange: set, Placeholder: placeholder, Label: label, Masked: masked,
				TestID: testID,
				Style: core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
					FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder()}}
		}
		setCfg := func(fn func(*config)) {
			fn(&a.cfg)
			a.st.edit(fn)
		}
		return a.scrollStashFor("settingsIntegrations:1").Bind(cx, core.Scroll{TestID: "settings-page", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: scrollbarGutter}, Gap: 4}, Children: []core.Node{
				a.wechatSettings(),
				setGroup("飞书",
					setRow("飞书机器人", "一轮结束时，把会话标题、状态和一句摘要发到群里的自定义机器人。",
						ui.Switch{Checked: func() bool { return a.cfg.FeishuEnabled }, Label: apptext.T("飞书机器人"), TestID: "feishu-enabled",
							OnChange: func(on bool) {
								setCfg(func(c *config) { c.FeishuEnabled = on })
								a.bumpSettings()
							}}),
					setDivider(),
					setRow("Webhook 地址", "飞书群 → 设置 → 群机器人 → 自定义机器人，复制它的 Webhook 地址。",
						field(func() string { return a.cfg.FeishuWebhook }, func(v string) {
							setCfg(func(c *config) { c.FeishuWebhook = v })
						}, "https://open.feishu.cn/open-apis/bot/v2/hook/…", "Webhook 地址", "feishu-webhook", false)),
					setDivider(),
					setRow("签名密钥", "机器人开启签名校验时填写；不校验就留空。",
						field(func() string { return a.cfg.FeishuSecret }, func(v string) {
							setCfg(func(c *config) { c.FeishuSecret = v })
						}, "可留空", "签名密钥", "feishu-secret", true)),
					setDivider(),
					setRow("接收群消息", "飞书开放平台的「事件订阅」地址填 http://<本机地址>:<远程端口>/api/feishu；先在「远程」里开启服务。",
						ui.Switch{Checked: func() bool { return a.cfg.FeishuInbound }, Label: apptext.T("接收群消息"), TestID: "feishu-inbound",
							OnChange: func(on bool) {
								setCfg(func(c *config) { c.FeishuInbound = on })
								a.bumpSettings()
							}}),
					setDivider(),
					setRow("验证 Token", "飞书应用「事件订阅」里的 Verification Token；不填就不接收。",
						field(func() string { return a.cfg.FeishuVerifyToken }, func(v string) {
							setCfg(func(c *config) { c.FeishuVerifyToken = v })
						}, "Verification Token", "验证 Token", "feishu-verify-token", true)),
					setDivider(),
					setRow("把回答发回群", "收到群消息后，把这一轮的回答也发到群里（用上面的 Webhook）。",
						ui.Switch{Checked: func() bool { return a.cfg.FeishuReply }, Label: apptext.T("把回答发回群"), TestID: "feishu-reply",
							OnChange: func(on bool) {
								setCfg(func(c *config) { c.FeishuReply = on })
								a.bumpSettings()
							}}),
					setDivider(),
					setRow("测试", "发一条测试消息，确认地址与签名都对。",
						ui.Button{Text: apptext.T("发一条"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "feishu-test",
							OnPress: a.testFeishu}),
				),
				setGroup("语音输入",
					setRow("本地 Whisper", "填写本机兼容 OpenAI 的 Whisper 服务地址。留空使用火山语音。",
						field(func() string { return a.cfg.VoiceLocalURL }, func(v string) {
							setCfg(func(c *config) { c.VoiceLocalURL = strings.TrimSpace(v) })
						}, "http://127.0.0.1:8080", "Whisper", "voice-local-url", false)),
					setDivider(),
					setRow("火山语音", "手机端录一段话，交给这台电脑调用火山引擎识别，结果显示在手机输入框里。凭据只存在这台电脑上。",
						nil),
					setDivider(),
					setRow("App ID", "火山引擎控制台 → 语音技术 → 语音识别大模型 → 应用管理里的 App ID。",
						field(func() string { return a.cfg.VoiceAppID }, func(v string) {
							setCfg(func(c *config) { c.VoiceAppID = v })
						}, apptext.T("例如 1234567890"), apptext.T("火山 App ID"), "voice-app-id", false)),
					setDivider(),
					setRow("Access Token", "同一个应用的 Access Token；手机不会拿到它，所有识别都由这台电脑发出。",
						field(func() string { return a.cfg.VoiceAccessToken }, func(v string) {
							setCfg(func(c *config) { c.VoiceAccessToken = v })
						}, apptext.T("粘贴 Access Token"), apptext.T("火山 Access Token"), "voice-access-token", true)),
					setDivider(),
					setRow("在手机上说话", "手机连上后，输入框那一行左边的麦克风按一次开始录音，再按一次结束并转成文字。", nil),
				),
				setGroup("ACP 预设",
					setRow("自定义预设", "检测或安装内置 ACP 工具，也可以添加自己的启动命令。",
						ui.Button{Text: apptext.T("管理预设…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "acp-manage-open",
							OnPress: func() { a.openACPPresetManager() }}),
					setDivider(),
					setRow("ACP 无输出超时", "运行中连续没有输出达到这个时长时，先请求停止；未响应则结束进程。等待你审批时不计时。",
						choiceChips(acpSilenceChoices(), func() int { return acpSilenceSeconds(a.cfg.ACPSilenceSec) }, func(sec int) {
							a.cfg.ACPSilenceSec = sec
							a.st.change(func(c *config) { c.ACPSilenceSec = sec })
							a.bumpSettings()
							go func() {
								if err := a.st.save(); err != nil {
									a.cx.Post(func() { a.toast(ui.ToastError, "保存失败", err.Error()) })
								}
							}()
						})),
				),
				setGroup("自动化与整理",
					setRow("定时任务", "按 cron 在后台开始新会话并发送提示词；可选 pi 或 ACP，运行记录写进数据目录 tasks.json。",
						ui.Button{Text: apptext.T("打开定时任务…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "tasks-open",
							OnPress: func() { a.openTaskDialog() }}),
					setDivider(),
					setRow("智能体", "把一段工作方式放在每个提问前面；内置、自定义与插件带来的智能体都能管理，ACP 会话同样适用。",
						ui.Button{Text: apptext.T("管理智能体…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "agents-open",
							OnPress: func() { a.openAgentManager() }}),
					setDivider(),
					setRow("收藏夹", "回复保存为正文快照，会话保存为引用；写进数据目录 favorites.json。",
						ui.Button{Text: apptext.T("打开收藏夹…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "favorites-open",
							OnPress: func() { a.openFavorites() }}),
				),
				core.Text{Content: apptext.T("默认只发会话标题、状态与一句摘要；开启「把回答发回群」后，回答最多发 1500 字。"), Style: core.Style{FontSize: 11, LineHeight: 17},
					StyleFunc: ui.Colored(colors.Faint)},
			}},
		}})
	})
}

func acpSilenceChoices() []choice[int] {
	var choices []choice[int]
	for _, sec := range []int{30, 60, 120, 300, 600, 900} {
		choices = append(choices, choice[int]{sec, strconv.Itoa(sec) + "s"})
	}
	return choices
}
