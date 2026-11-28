//go:build !js && !android && !ios

package workbench

import (
	"fmt"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	uidiff "github.com/nsgo-dev/nsgo/ui/diff"
)

// reviewPatchPane keeps the diff mounted during a refresh and always offers
// a path back. Only a successful, nonempty patch is eligible for copying.
func (a *app) reviewPatchPane() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.langRev.Get()
		cx.OnBackPress(func() bool { a.openPane(paneReview); return true })
		colors := ui.ColorsOf(cx)
		title := core.NewMemo(cx, func() string {
			if d := a.review.state.Get().Detail; d != nil {
				return fmt.Sprintf("#%d %s", d.Item.Number, d.Item.Title)
			}
			return apptext.T("补丁")
		})
		busy := func() bool { return a.review.state.Get().PatchBusy }
		patch := core.NewMemo(cx, func() string { return a.review.state.Get().Patch })
		empty := core.NewMemo(cx, func() bool { return patch.Get() == "" })
		loaded := core.NewMemo(cx, func() bool { return a.review.state.Get().PatchLoaded })
		body := core.Dynamic(func(cx *core.Scope) core.Node {
			if loaded.Get() {
				if empty.Get() {
					return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter}, Children: []core.Node{
						ui.Text(apptext.T("没有可显示的差异"), 12, ui.Regular, colors.Muted),
					}}
				}
				return core.View{TestID: "review-patch-content", Style: ui.FillRest, Children: []core.Node{
					uidiff.View{Patch: patch.Get, Unified: true, Selectable: true, SoftWrap: true, Style: ui.FillRest},
				}}
			}
			return core.Dynamic(func(cx *core.Scope) core.Node {
				s := a.review.state.Get()
				if s.PatchError != "" && !s.PatchBusy {
					return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 12, Padding: core.All(24)}, Children: []core.Node{
						ui.Icon(lucide.TriangleAlert, 24, colors.Danger),
						core.Text{Content: s.PatchError, MaxLines: 5, Style: core.Style{FontSize: 12, LineHeight: 18, MaxWidth: core.Pt(560)}, StyleFunc: ui.Colored(colors.Danger)},
						ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "review-patch-retry", OnPress: a.review.loadPatch},
					}}
				}
				return reviewLoading(cx, apptext.T("正在读取补丁…"), "review-patch-loading")
			})
		})
		page := core.View{Style: ui.FillRest, Children: []core.Node{
			core.Dynamic(func(*core.Scope) core.Node {
				return a.paneHeader(title.Get(), apptext.T("拉取请求的完整改动"),
					ui.Button{Text: apptext.T("刷新"), Icon: lucide.RefreshCw, Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						Busy: busy, Disabled: busy, TestID: "review-patch-refresh", OnPress: a.review.loadPatch},
					ui.Button{Text: apptext.T("复制补丁"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "review-patch-copy",
						Disabled: func() bool {
							s := a.review.state.Get()
							return !s.PatchLoaded || s.Patch == "" || s.PatchBusy || s.PatchError != ""
						},
						OnPress: func() {
							s := a.review.state.GetUntracked()
							if s.PatchLoaded && !s.PatchBusy && s.PatchError == "" && s.Patch != "" {
								a.copyText(s.Patch, "补丁")
							}
						}},
				)
			}),
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(36)}, Children: []core.Node{
				ui.Button{Text: apptext.T("评审"), Icon: lucide.ChevronLeft, Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "review-patch-back",
					OnPress: func() { a.openPane(paneReview) }},
				core.Show{When: func() bool { s := a.review.state.Get(); return s.PatchBusy && s.PatchLoaded }, Then: func(*core.Scope) core.Node {
					return ui.Text(apptext.T("正在读取补丁…"), 11, ui.Regular, colors.Muted)
				}},
				core.Show{When: func() bool { s := a.review.state.Get(); return s.PatchLoaded && s.PatchError != "" }, Then: func(*core.Scope) core.Node {
					return core.Text{ContentFunc: func() string { return a.review.state.Get().PatchError }, MaxLines: 2, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11}, StyleFunc: ui.Colored(colors.Danger)}
				}},
			}},
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), BorderWidth: 1, BorderColor: colors.Border(), CornerRadius: 8, Overflow: core.Hidden}, Children: []core.Node{body}},
		}}
		return a.reviewTransition(cx, page, true)
	})
}
