//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

const piVersionMetadata = "https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest"

func (a *app) startModelCatalogRefresh() {
	var refresh func()
	refresh = func() {
		if a.cfg.AutoModelCatalog {
			a.refreshModelCatalog(false)
		}
		a.cx.AfterFunc(24*time.Hour, refresh)
	}
	a.cx.AfterFunc(30*time.Second, refresh)
}

func (a *app) refreshModelCatalog(announce bool) {
	info := a.env.GetUntracked()
	if a.modelCatalogBusy.GetUntracked() || info.PiPath == "" || info.PiError != "" {
		return
	}
	a.modelCatalogBusy.Set(true)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		cmd := piCommand(ctx, info.PiPath, "update", "--models", "--no-approve")
		cmd.Dir = loginDir()
		cmd.Env = append(cmd.Environ(), agentProxy.env()...)
		out, err := cmd.CombinedOutput()
		a.cx.Post(func() {
			a.modelCatalogBusy.Set(false)
			if err != nil {
				if announce {
					detail := viewkit.FirstLine(strings.TrimSpace(string(out)), 240)
					if detail == "" {
						detail = err.Error()
					}
					a.toast(ui.ToastError, "刷新模型目录失败", detail)
				} else {
					a.diagf("warn", "model catalog refresh: %v", err)
				}
				return
			}
			a.refreshProviders()
			for _, s := range a.all {
				if !s.Target.remote() && s.engine != nil {
					a.refreshSessionModels(s, false)
				}
			}
			if announce {
				a.toast(ui.ToastSuccess, "模型目录已刷新", "")
			}
		})
	}()
}

func latestPiVersion(ctx context.Context, endpoint string, client *http.Client) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("npm HTTP %d", res.StatusCode)
	}
	var result struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 512<<10)).Decode(&result); err != nil {
		return "", err
	}
	if result.Version == "" || len(result.Version) > 64 || strings.ContainsAny(result.Version, "\r\n\t ") {
		return "", errors.New("npm metadata did not contain a version")
	}
	return result.Version, nil
}

func (a *app) checkPiVersion() {
	if a.piUpdate.GetUntracked().busy() {
		return
	}
	info := a.env.GetUntracked()
	if info.PiPath == "" || info.PiError != "" || info.Probing {
		return
	}
	state := piUpdateState{Path: info.PiPath, Installed: info.PiVersion, Checking: true}
	a.piUpdate.Set(state)
	go func() {
		base := a.lifetime
		if base == nil {
			base = context.Background()
		}
		ctx, cancel := context.WithTimeout(base, 15*time.Second)
		defer cancel()
		latest, err := latestPiVersion(ctx, piVersionMetadata, appHTTPClient)
		a.cx.Post(func() {
			state.Checking = false
			if err != nil {
				state.Error = err.Error()
			} else {
				state.Latest = latest
			}
			a.piUpdate.Set(state)
		})
	}()
}

func (a *app) modelCatalogSettings() core.Node {
	return setGroup("模型目录",
		setRow("自动刷新模型目录", "启动后与每天在后台刷新 pi 的模型目录。", ui.Switch{
			Checked: func() bool { return a.cfg.AutoModelCatalog }, Label: apptext.T("自动刷新模型目录"), TestID: "model-catalog-auto",
			OnChange: func(on bool) {
				a.cfg.AutoModelCatalog = on
				a.st.edit(func(c *config) { c.AutoModelCatalog = on })
				a.bumpSettings()
				if on {
					a.refreshModelCatalog(false)
				}
			},
		}),
		setDivider(),
		setRow("刷新模型目录", "让 pi 拉取供应商和模型的最新资料。", ui.Button{
			Text: apptext.T("立即刷新"), TestID: "model-catalog-refresh", Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
			Disabled: func() bool { return a.modelCatalogBusy.Get() || a.env.Get().PiPath == "" },
			OnPress:  func() { a.refreshModelCatalog(true) },
		}))
}

func (a *app) piUpdateSetting(piOK bool) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		state, info := a.piUpdate.Get(), a.env.Get()
		detail := apptext.T("对比本机安装与 npm 最新发布。")
		if state.matches(info) && state.Latest != "" {
			detail = apptext.T("已安装 %s，npm 最新版 %s。", info.PiVersion, state.Latest)
		}
		if state.Checking {
			detail = apptext.T("正在检查 pi 版本…")
		}
		actions := []core.Node{ui.Button{
			Text: apptext.T("检查 pi 版本"), TestID: "pi-version-check", Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
			Disabled: func() bool { return !piOK || state.busy() }, OnPress: a.checkPiVersion,
		}}
		if state.available(info) {
			label := apptext.T("更新到 %s", state.Latest)
			if state.Updating {
				label = apptext.T("正在更新 pi…")
			}
			actions = append(actions, ui.Button{Text: label, TestID: "pi-version-update", Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
				Disabled: state.busy, OnPress: a.updatePiRuntime})
		}
		children := []core.Node{setRow("检查 pi 版本", detail,
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: actions})}
		if state.matches(info) && state.Error != "" {
			title := apptext.T("检查 pi 版本失败")
			if state.Latest != "" {
				title = apptext.T("更新 pi 失败")
			}
			children = append(children, core.Text{TestID: "pi-update-error", Content: title + "\n" + state.Error,
				Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(ui.ColorsOf(cx).Danger)})
		}
		return core.View{Style: core.Style{Gap: 6, MinWidth: core.Pt(0)}, Children: children}
	})
}
