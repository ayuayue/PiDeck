//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
	"strings"
)

func (a *app) modelBatchActions(provider providerInfo) core.Node {
	h := a.providerManagerState()
	return core.Dynamic(func(cx *core.Scope) core.Node {
		selected := h.selectedModels.Get()
		query := strings.ToLower(h.modelQuery.Get())
		ids := []string{}
		for _, m := range provider.Models {
			if selected[m.ID] {
				ids = append(ids, m.ID)
			}
		}
		return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
			ui.Button{Text: apptext.T("选择搜索结果"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-model-select-visible", OnPress: func() {
				for _, m := range provider.Models {
					if query == "" || strings.Contains(strings.ToLower(m.ID+" "+m.Name), query) {
						selectionSet(h.selectedModels, m.ID, true)
					}
				}
			}},
			ui.Button{Text: apptext.T("清空选择"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-model-clear-selection", OnPress: func() { h.selectedModels.Set(map[string]bool{}) }},
			ui.Button{Text: apptext.T("删除所选模型（%d）", len(ids)), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-model-delete-selected", Disabled: func() bool { return len(ids) == 0 || h.busy.Get() }, OnPress: func() {
				a.askConfirm(apptext.T("删除所选模型？"), apptext.T("将从 %s 删除以下模型：%s。会话记录会保留。", provider.ID, strings.Join(ids, ", ")), apptext.T("删除所选模型"), func() {
					a.runProviderModelMutation(provider.ID, "所选模型已删除", func() error {
						if err := deleteProviderModels(provider.ID, ids); err != nil {
							return err
						}
						for _, id := range ids {
							if err := migrateModelThinkingReferences(provider.ID, id, ""); err != nil {
								detail := err.Error()
								a.cx.Post(func() { a.toast(ui.ToastError, "思考档位清理失败", detail) })
							}
						}
						return nil
					}, func() {
						for _, id := range ids {
							a.migrateProviderPreferences(provider.ID, id, "", "")
						}
						h.selectedModels.Set(map[string]bool{})
					})
				})
			}},
		}}
	})
}
func (a *app) providerRenameFields() core.Node {
	h := a.providerManagerState()
	return core.Dynamic(func(cx *core.Scope) core.Node {
		name := core.NewSignal(cx, a.providerID.GetUntracked())
		return core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
			providerFormField("供应商 ID", "改名会同步迁移 pi 登录凭据、用量配置及默认模型引用。请先保存连接更改。", ui.Input{Value: name.Get, OnChange: name.Set, Label: apptext.T("供应商 ID"), TestID: "provider-rename-id", Disabled: h.busy.Get}),
			ui.Button{Text: apptext.T("重命名供应商"), TestID: "provider-rename-save", Size: ui.SizeSmall, Disabled: func() bool {
				return h.busy.Get() || h.dirty.Get() || strings.TrimSpace(name.Get()) == a.providerID.Get()
			}, OnPress: func() {
				from, to := a.providerID.GetUntracked(), strings.TrimSpace(name.GetUntracked())
				if !validProviderID(to) {
					h.problem.Set(apptext.T("供应商 ID 只能包含英文字母、数字、点、短横线和下划线。"))
					return
				}
				a.askConfirmPrimary(apptext.T("重命名供应商？"), apptext.T("将 %s 改为 %s，并迁移相关配置。", from, to), apptext.T("确认重命名"), func() {
					h.busy.Set(true)
					go func() {
						err := renameProviderConfig(from, to)
						a.cx.Post(func() {
							h.busy.Set(false)
							if err != nil {
								h.problem.Set(err.Error())
								return
							}
							a.migrateProviderPreferences(from, "", to, "")
							a.refreshProviders()
							a.openProviderSection(to, "connection", nil)
							a.toast(ui.ToastSuccess, "供应商已重命名", to)
						})
					}()
				})
			}},
		}}
	})
}
