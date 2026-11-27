//go:build !js && !android && !ios

package workbench

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// Usage credentials are separate from chat credentials. Editing or testing a
// draft does not persist it, and a failed read never becomes an empty save.
type providerUsageForm struct {
	enabled, dirty, busy                         *core.Signal[bool]
	template, timeout, interval, result, problem *core.Signal[string]
	fields                                       map[string]*core.Signal[string]
	readErr                                      error
	saved                                        usageProbeConfig
	configured                                   bool
	refreshTimer                                 *time.Timer
}

func (a *app) newProviderUsageForm(provider providerConfig, cfg usageProbeConfig, configured bool, readErr error) *providerUsageForm {
	enabled, _, timeout, interval := effectiveUsageProbe(provider, cfg)
	f := &providerUsageForm{enabled: core.NewSignal(a.cx, enabled), dirty: core.NewSignal(a.cx, false), busy: core.NewSignal(a.cx, false), template: core.NewSignal(a.cx, cfg.Template), timeout: core.NewSignal(a.cx, strconv.Itoa(timeout)), interval: core.NewSignal(a.cx, strconv.Itoa(interval)), result: core.NewSignal(a.cx, ""), problem: core.NewSignal(a.cx, ""), fields: map[string]*core.Signal[string]{}, readErr: readErr, saved: cfg, configured: configured}
	values := map[string]string{"baseUrl": cfg.BaseURL, "apiKey": cfg.APIKey, "accessToken": cfg.AccessToken, "userId": cfg.UserID, "cookie": cfg.Cookie, "cookiePath": cfg.CookiePath, "valuePath": cfg.ValuePath, "currencyPath": cfg.CurrencyPath, "accessKeyId": cfg.AccessKeyID, "secretAccessKey": cfg.SecretAccessKey, "panelJwt": cfg.PanelJWT, "panelRefreshToken": cfg.PanelRefreshToken}
	for key, value := range values {
		f.fields[key] = core.NewSignal(a.cx, value)
	}
	if readErr != nil {
		f.problem.Set(apptext.T("无法读取 usage-probes.json：%s", readErr.Error()))
	}
	return f
}

func (f *providerUsageForm) config() (usageProbeConfig, error) {
	timeout, err := strconv.Atoi(strings.TrimSpace(f.timeout.GetUntracked()))
	if err != nil || timeout < 1 || timeout > 300 {
		return usageProbeConfig{}, fmt.Errorf("%s", apptext.T("超时必须是 1 到 300 秒的整数。"))
	}
	interval, err := strconv.Atoi(strings.TrimSpace(f.interval.GetUntracked()))
	if err != nil || interval < 0 || interval > 1440 {
		return usageProbeConfig{}, fmt.Errorf("%s", apptext.T("刷新间隔必须是 0 到 1440 分钟的整数，0 表示仅手动。"))
	}
	enabled := f.enabled.GetUntracked()
	get := func(key string) string { return strings.TrimSpace(f.fields[key].GetUntracked()) }
	return usageProbeConfig{Enabled: &enabled, Template: f.template.GetUntracked(), TimeoutSecs: timeout, IntervalMinutes: &interval, BaseURL: get("baseUrl"), APIKey: get("apiKey"), AccessToken: get("accessToken"), UserID: get("userId"), Cookie: get("cookie"), CookiePath: get("cookiePath"), ValuePath: get("valuePath"), CurrencyPath: get("currencyPath"), AccessKeyID: get("accessKeyId"), SecretAccessKey: get("secretAccessKey"), PanelJWT: get("panelJwt"), PanelRefreshToken: get("panelRefreshToken")}, nil
}

func (a *app) providerUsagePanel(cx *core.Scope) core.Node {
	h := a.providerManagerState()
	colors := ui.ColorsOf(cx)
	f := h.usage
	if f == nil {
		return ui.Text(apptext.T("请先加载供应商连接配置。"), 11, ui.Regular, colors.Muted)
	}
	field := func(key, label, help string, secret bool) core.Node {
		return providerFormField(label, help, ui.Input{Value: f.fields[key].Get, OnChange: func(v string) { f.fields[key].Set(v); f.dirty.Set(true) }, Label: apptext.T(label), Masked: secret, TestID: "provider-usage-" + key, Disabled: func() bool { return h.busy.Get() || f.busy.Get() }})
	}
	scalar := func(label, help, id string, s *core.Signal[string]) core.Node {
		return providerFormField(label, help, ui.Input{Value: s.Get, OnChange: func(v string) { s.Set(v); f.dirty.Set(true) }, Label: apptext.T(label), TestID: id, Disabled: func() bool { return h.busy.Get() || f.busy.Get() }})
	}
	return core.View{Style: core.Style{Gap: 14}, Children: []core.Node{
		core.Text{Content: apptext.T("余额、套餐额度和订阅窗口由供应商接口提供。这里的配置不会改变聊天使用的密钥。"), Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
		ui.Checkbox{Text: apptext.T("启用用量查询"), TestID: "provider-usage-enabled", Disabled: func() bool { return h.busy.Get() || f.busy.Get() }, Checked: f.enabled.Get, OnChange: func(v bool) { f.enabled.Set(v); f.dirty.Set(true) }},
		providerFormField("查询方式", "自动识别支持的供应商；第三方中转可选择对应面板模板。", ui.Select[string]{Label: apptext.T("查询方式"), TestID: "provider-usage-template", Disabled: func() bool { return h.busy.Get() || f.busy.Get() }, Value: f.template.Get, OnChange: func(v string) { f.template.Set(v); f.dirty.Set(true) }, Options: []ui.Option[string]{
			{Value: "", Label: apptext.T("自动识别（推荐）")}, {Value: "general", Label: apptext.T("通用余额接口")}, {Value: "newapi", Label: "New API"}, {Value: "cookie", Label: apptext.T("Cookie 登录态")}, {Value: "volcengine", Label: apptext.T("火山引擎（AK / SK）")}, {Value: "sub2api", Label: "Sub2API"},
		}, Style: core.Style{Width: core.Pct(100)}}),
		core.Dynamic(func(cx *core.Scope) core.Node {
			template := f.template.Get()
			var fields []core.Node
			if template == "" {
				recognized := recognizedUsageTemplate(a.providerFromDialog())
				message := apptext.T("未匹配专用查询方式，将尝试通用 /v1/usage 接口。可选择其他模板或填写查询地址。")
				if recognized != "" {
					message = apptext.T("已识别查询方式：%s", recognized)
				}
				fields = append(fields, core.Text{Content: message, TestID: "provider-usage-detected", Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)})
			}
			fields = append(fields, field("baseUrl", "用量查询地址（可选）", "默认填写服务根地址；通用模板指定余额字段路径时，可填写完整查询 URL。", false))
			switch template {
			case "newapi":
				fields = append(fields, field("accessToken", "面板访问令牌", "使用面板个人设置中的访问令牌，通常与聊天 API Key 不同。", true), field("userId", "用户 ID", "New API 面板用户 ID，用于 New-Api-User 请求头。", false))
			case "cookie":
				fields = append(fields, field("cookie", "Cookie", "填写完整的登录 Cookie，仅用于该面板的查询请求。", true), field("cookiePath", "查询接口路径", "例如 /api/user/self；这是网站接口路径，不是本地文件。", false))
			case "volcengine":
				fields = append(fields, field("accessKeyId", "Access Key ID", "火山引擎访问密钥 ID。", true), field("secretAccessKey", "Secret Access Key", "用于签名查询，请勿填写聊天 API Key。", true))
			case "sub2api":
				fields = append(fields, field("apiKey", "用量专用 API Key（可选）", "留空使用聊天凭据；面板登录令牌用于查询订阅与充值。", true), field("panelJwt", "面板 JWT（可选）", "只用于面板套餐查询。", true), field("panelRefreshToken", "面板刷新令牌（可选）", "允许面板令牌过期后刷新；更新后的令牌会安全保存。", true))
			default:
				fields = append(fields, field("apiKey", "用量专用 API Key（可选）", "留空使用供应商连接或 pi 登录凭据。", true))
			}
			if template == "general" || template == "cookie" || template == "" {
				fields = append(fields, field("valuePath", "余额字段路径（可选）", "例如 data.balance；留空按常见响应格式识别。", false), field("currencyPath", "币种字段路径（可选）", "例如 data.currency；按接口返回的币种显示。", false))
			}
			return core.View{Style: core.Style{Gap: 14}, Children: fields}
		}),
		scalar("请求超时（秒）", "默认 10 秒；允许 1 到 300 秒。", "provider-usage-timeout", f.timeout),
		scalar("自动刷新间隔（分钟）", "查看用量时按此间隔刷新；0 表示仅手动刷新。", "provider-usage-interval", f.interval),
		core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
			ui.Button{Text: apptext.T("测试查询"), Variant: ui.ButtonSecondary, TestID: "provider-balance", Disabled: func() bool { return f.busy.Get() || h.loading.Get() || f.readErr != nil }, OnPress: a.testProviderUsage},
			core.Text{ContentFunc: func() string {
				if f.busy.Get() {
					return apptext.T("正在查询…")
				}
				return ""
			}, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
		}},
		core.Text{ContentFunc: f.result.Get, TestID: "provider-usage-result", Style: core.Style{FontSize: 12, LineHeight: 18}, StyleFunc: ui.Colored(colors.Text)},
		core.Text{ContentFunc: f.problem.Get, TestID: "provider-usage-error", Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Danger)},
		core.Show{When: func() bool { return a.providerBalURL.Get() != "" || a.providerBalPath.Get() != "" }, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				ui.Text(apptext.T("旧版余额配置"), 12, ui.Medium, colors.Text),
				core.Text{Content: apptext.T("原有余额配置会保留。保存上方的用量配置后，新的查询方式优先。"), Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
				ui.Input{Label: apptext.T("余额接口 URL"), TestID: "provider-balance-url", Value: a.providerBalURL.Get, Readonly: true},
				ui.Input{Label: apptext.T("余额字段路径"), TestID: "provider-balance-path", Value: a.providerBalPath.Get, Readonly: true},
			}}
		}},
	}}
}

func (a *app) saveProviderUsage() {
	h := a.providerManagerState()
	f := h.usage
	if f == nil || h.busy.GetUntracked() || f.busy.GetUntracked() || f.readErr != nil {
		return
	}
	cfg, err := f.config()
	if err != nil {
		f.problem.Set(err.Error())
		return
	}
	id, seq := a.providerID.GetUntracked(), h.loadSeq
	h.busy.Set(true)
	f.problem.Set("")
	go func() {
		err := saveUsageProbeConfig(id, cfg)
		a.cx.Post(func() {
			if h.loadSeq != seq || h.usage != f {
				return
			}
			h.busy.Set(false)
			if err != nil {
				f.problem.Set(err.Error())
				return
			}
			f.saved = cfg
			f.configured = true
			f.dirty.Set(false)
			a.toast(ui.ToastSuccess, "用量配置已保存", "可点击测试查询，确认供应商返回的余额或额度。")
		})
	}()
}

func (a *app) testProviderUsage() {
	h := a.providerManagerState()
	f := h.usage
	if f == nil || h.busy.GetUntracked() || f.busy.GetUntracked() || f.readErr != nil {
		return
	}
	cfg, err := f.config()
	if err != nil {
		f.problem.Set(err.Error())
		return
	}
	if f.refreshTimer != nil {
		f.refreshTimer.Stop()
		f.refreshTimer = nil
	}
	provider := a.providerFromDialog()
	seq := h.loadSeq
	piPath := a.piPath()
	legacy := a.dialogBalanceSpec()
	useLegacy := !f.configured && !f.dirty.GetUntracked()
	f.busy.Set(true)
	f.problem.Set("")
	f.result.Set("")
	go func() {
		ctx, cancel := context.WithTimeout(a.lifetime, time.Duration(cfg.TimeoutSecs)*time.Second)
		defer cancel()
		credential, credentialErr := resolveProviderDraftCredential(ctx, piPath, provider)
		var result usageProbeResult
		err := credentialErr
		if err == nil {
			result, err = queryProviderUsage(ctx, appHTTPClient, provider, credential, cfg)
		}
		// Keep existing installations' custom balance paths usable until the user
		// explicitly saves a usage-probes.json configuration.
		if err != nil && credentialErr == nil && useLegacy && legacy != nil && cfg.Template == "" && cfg.BaseURL == "" && cfg.APIKey == "" {
			result.Summary, err = providerBalanceWith(provider, legacy)
		}
		a.cx.Post(func() {
			f.busy.Set(false)
			if h.loadSeq != seq || h.usage != f {
				return
			}
			if err != nil {
				f.problem.Set(err.Error())
				a.providerBalance.Set(apptext.T("失败：%s", err.Error()))
				return
			}
			message := result.Summary
			for _, detail := range result.Details {
				if detail != "" && detail != result.Summary {
					message += "\n" + detail
				}
			}
			message += "\n" + apptext.T("更新于 %s", time.Now().Format("15:04:05"))
			f.result.Set(message)
			a.providerBalance.Set(result.Summary)
			if !f.dirty.GetUntracked() && cfg.IntervalMinutes != nil && *cfg.IntervalMinutes > 0 {
				delay := time.Duration(*cfg.IntervalMinutes) * time.Minute
				f.refreshTimer = time.AfterFunc(delay, func() {
					a.cx.Post(func() {
						if h.loadSeq == seq && h.usage == f && a.providerOpen.GetUntracked() && h.tab.GetUntracked() == "usage" && !f.dirty.GetUntracked() {
							a.testProviderUsage()
						}
					})
				})
			}
		})
	}()
}
