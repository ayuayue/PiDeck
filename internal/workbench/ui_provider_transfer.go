//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
	"strings"
)

type providerTransferForm struct {
	text, problem, summary            *core.Signal[string]
	busy, replace, secrets, previewed *core.Signal[bool]
	ids                               []string
}

func (a *app) openProviderTransfer(mode string, ids []string) {
	h := a.providerManagerState()
	h.loadSeq++
	f := &providerTransferForm{text: core.NewSignal(a.cx, ""), problem: core.NewSignal(a.cx, ""), summary: core.NewSignal(a.cx, ""), busy: core.NewSignal(a.cx, false), replace: core.NewSignal(a.cx, false), secrets: core.NewSignal(a.cx, false), previewed: core.NewSignal(a.cx, false), ids: append([]string(nil), ids...)}
	h.transferForm = f
	h.transfer.Set(mode)
	a.providerID.Set("")
	a.providerOpen.Set(true)
	if mode == "export" {
		a.prepareProviderExport(f)
	}
}
func (a *app) prepareProviderExport(f *providerTransferForm) {
	if f.busy.GetUntracked() {
		return
	}
	f.busy.Set(true)
	include := f.secrets.GetUntracked()
	go func() {
		out, err := exportProviderConfigs(f.ids, include)
		a.cx.Post(func() {
			f.busy.Set(false)
			if err != nil {
				f.problem.Set(err.Error())
				return
			}
			f.problem.Set("")
			f.text.Set(out)
		})
	}()
}
func (a *app) providerTransferDialog(cx *core.Scope) core.Node {
	h := a.providerManagerState()
	f := h.transferForm
	colors := ui.ColorsOf(cx)
	if f == nil {
		return core.View{}
	}
	exporting := h.transfer.Get() == "export"
	close := func() {
		if h.transferForm != f || h.transfer.GetUntracked() == "" {
			return
		}
		if f.busy.GetUntracked() {
			return
		}
		a.providerOpen.Set(false)
		h.transfer.Set("")
		f.text.Set("")
		f.secrets.Set(false)
	}
	title, help := apptext.T("导入供应商"), apptext.T("粘贴 models.json 内容，先预览，再确认导入。现有供应商默认不会被覆盖。")
	var controls []core.Node
	if exporting {
		title, help = apptext.T("导出供应商"), apptext.T("复制配置以备份或迁移。默认移除密钥和认证请求头，导入后需重新填写。")
		controls = append(controls, ui.Checkbox{Text: apptext.T("包含密钥和认证信息（请勿公开分享）"), TestID: "provider-export-secrets", Checked: f.secrets.Get, Disabled: f.busy.Get, OnChange: func(v bool) { f.secrets.Set(v); a.prepareProviderExport(f) }})
	}
	controls = append(controls, ui.Input{Value: f.text.Get, OnChange: func(v string) { f.text.Set(v); f.previewed.Set(false); f.summary.Set(""); f.problem.Set("") }, Readonly: exporting, Multiline: true, Label: apptext.T("供应商 JSON"), TestID: "provider-transfer-json", Style: core.Style{MinHeight: core.Pt(220), Height: core.Pt(300)}, Disabled: f.busy.Get})
	if !exporting {
		controls = append(controls, ui.Checkbox{Text: apptext.T("允许替换同名供应商（只替换本次导入的项目）"), TestID: "provider-import-replace", Checked: f.replace.Get, OnChange: f.replace.Set, Disabled: f.busy.Get})
	}
	controls = append(controls, core.Text{ContentFunc: f.summary.Get, TestID: "provider-transfer-preview", Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)}, core.Text{ContentFunc: f.problem.Get, TestID: "provider-transfer-error", Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Danger)})
	actions := []core.Node{ui.Button{Text: apptext.T("关闭"), TestID: "provider-transfer-close", OnPress: close, Disabled: f.busy.Get}, core.View{Style: core.Style{FlexGrow: 1}}}
	if exporting {
		actions = append(actions, ui.Button{Text: apptext.T("复制配置"), Variant: ui.ButtonPrimary, TestID: "provider-export-copy", Disabled: func() bool { return f.busy.Get() || f.text.Get() == "" }, OnPress: func() { a.cx.SetClipboard(f.text.GetUntracked()); a.toast(ui.ToastSuccess, "配置已复制", "") }})
	} else {
		actions = append(actions, ui.Button{Text: apptext.T("预览导入"), TestID: "provider-import-preview", Disabled: f.busy.Get, OnPress: func() {
			input := f.text.GetUntracked()
			f.busy.Set(true)
			go func() {
				p, err := previewProviderImport(input)
				a.cx.Post(func() {
					f.busy.Set(false)
					if err != nil {
						f.problem.Set(err.Error())
						f.previewed.Set(false)
						return
					}
					f.problem.Set("")
					f.summary.Set(apptext.T("供应商：%s；模型：%d；同名冲突：%d", strings.Join(p.Providers, ", "), p.Models, len(p.Conflicts)))
					f.previewed.Set(true)
				})
			}()
		}}, ui.Button{Text: apptext.T("确认导入"), Variant: ui.ButtonPrimary, TestID: "provider-import-save", Disabled: func() bool { return f.busy.Get() || !f.previewed.Get() }, OnPress: func() {
			input, replace := f.text.GetUntracked(), f.replace.GetUntracked()
			perform := func() {
				f.busy.Set(true)
				go func() {
					err := importProviderConfigs(input, replace)
					a.cx.Post(func() {
						f.busy.Set(false)
						if err != nil {
							f.problem.Set(err.Error())
							return
						}
						close()
						a.refreshProviders()
						a.toast(ui.ToastSuccess, "供应商已导入", "")
					})
				}()
			}
			if replace {
				a.askConfirm(apptext.T("替换同名供应商？"), apptext.T("本次导入的同名连接、密钥和模型将被替换，请确认已备份。"), apptext.T("替换并导入"), perform)
			} else {
				perform()
			}
		}})
	}
	return ui.Dialog{Open: a.providerOpen.Get, OnOpenChange: func(open bool, _ base.Reason) {
		if !open {
			close()
		}
	}, TestID: "provider-transfer-dialog", Style: core.Style{Width: core.Pct(90), MaxWidth: core.Pt(760), MaxHeight: core.Pct(92), Gap: 12}, Children: []core.Node{ui.Text(title, 17, ui.Semibold, colors.Text), ui.Text(help, 11, ui.Regular, colors.Muted), core.Scroll{TestID: "provider-transfer-scroll", Style: core.Style{MaxHeight: core.Pt(470)}, Children: []core.Node{core.View{Style: core.Style{Gap: 12, Padding: core.Edges{Right: scrollbarGutter}}, Children: controls}}}, core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8, AlignItems: core.AlignCenter}, Children: actions}}}
}

func (a *app) providerBatchActions() core.Node {
	h := a.providerManagerState()
	return core.Dynamic(func(cx *core.Scope) core.Node {
		selected := h.selectedProviders.Get()
		var ids []string
		for _, p := range a.providers.Get() {
			if p.Configured && selected[p.ID] {
				ids = append(ids, p.ID)
			}
		}
		return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8, AlignItems: core.AlignCenter}, Children: []core.Node{
			ui.Button{Text: apptext.T("导入配置"), Size: ui.SizeSmall, Variant: ui.ButtonSecondary, TestID: "provider-import", OnPress: func() { a.openProviderTransfer("import", nil) }},
			ui.Button{Text: apptext.T("导出全部"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-export-all", OnPress: func() {
				var all []string
				for _, p := range a.providers.GetUntracked() {
					if p.Configured {
						all = append(all, p.ID)
					}
				}
				a.openProviderTransfer("export", all)
			}},
			ui.Button{Text: apptext.T("导出所选（%d）", len(ids)), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-export-selected", Disabled: func() bool { return len(ids) == 0 }, OnPress: func() { a.openProviderTransfer("export", ids) }},
			ui.Button{Text: apptext.T("删除所选（%d）", len(ids)), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-delete-selected", Disabled: func() bool { return len(ids) == 0 || h.busy.Get() }, OnPress: func() { a.deleteSelectedProviders(ids) }},
			ui.Button{Text: apptext.T("清空选择"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-clear-selection", Disabled: func() bool { return len(ids) == 0 }, OnPress: func() { h.selectedProviders.Set(map[string]bool{}) }},
		}}
	})
}
func (a *app) deleteSelectedProviders(ids []string) {
	h := a.providerManagerState()
	a.askConfirm(apptext.T("删除所选供应商？"), apptext.T("将移除以下供应商的连接和模型：%s。会话记录与 pi 登录凭据会保留。", strings.Join(ids, ", ")), apptext.T("删除所选供应商"), func() {
		if h.busy.GetUntracked() {
			return
		}
		h.busy.Set(true)
		go func() {
			err := mutateModelsDocument(false, func(providers map[string]any) error {
				for _, id := range ids {
					if _, err := providerDocument(providers, id); err != nil {
						return err
					}
				}
				for _, id := range ids {
					delete(providers, id)
				}
				return nil
			})
			a.cx.Post(func() {
				h.busy.Set(false)
				if err != nil {
					a.toast(ui.ToastError, "删除失败", err.Error())
					return
				}
				for _, id := range ids {
					a.migrateProviderPreferences(id, "", "", "")
				}
				h.selectedProviders.Set(map[string]bool{})
				a.refreshProviders()
				a.toast(ui.ToastSuccess, "供应商已删除", "")
			})
		}()
	})
}
