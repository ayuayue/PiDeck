//go:build !js && !android && !ios

package workbench

// One pull request or issue: what it says, its checks and files, the
// conversation, and the actions the pane can take on it — comment, merge,
// close or reopen, and hand it to a session to evaluate.

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// reviewDetail is the open item's page.
func (a *app) reviewDetail(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	detail := core.NewMemoFunc(cx, func() *reviewDetail { return a.review.state.Get().Detail },
		func(a, b *reviewDetail) bool { return reflect.DeepEqual(a, b) })
	ready := core.NewMemo(cx, func() bool { return detail.Get() != nil })
	return core.Dynamic(func(cx *core.Scope) core.Node {
		if !ready.Get() {
			return core.View{Style: ui.FillRest, Children: []core.Node{
				core.View{Style: core.Style{AlignItems: core.AlignStart, Padding: core.Symmetric(8, 20)}, Children: []core.Node{
					ui.Button{Text: apptext.T("返回列表"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "review-back", OnPress: a.review.closeItem},
				}},
				core.Dynamic(func(cx *core.Scope) core.Node {
					st := a.review.state.Get()
					if st.DetailError != "" && !st.DetailBusy {
						return reviewNotice(colors, lucide.TriangleAlert, apptext.T("读不到这一条"), st.DetailError,
							apptext.T("重试"), a.review.reopenItem)
					}
					return reviewLoading(cx, apptext.T("正在读取详情…"), "review-detail-loading")
				}),
			}}
		}
		body := []core.Node{
			core.Dynamic(func(*core.Scope) core.Node { return a.reviewDetailHead(colors, detail.Get().Item) }),
			core.Dynamic(func(*core.Scope) core.Node { return a.reviewDetailMeta(colors, detail.Get()) }),
			core.Dynamic(func(*core.Scope) core.Node { return a.reviewActions(colors, detail.Get()) }),
			core.Dynamic(func(*core.Scope) core.Node {
				d := detail.Get()
				return core.View{Style: core.Style{Gap: 12}, Children: []core.Node{
					a.reviewChecks(colors, d), a.reviewFiles(colors, d), a.reviewBody(colors, d), a.reviewConversation(colors, d),
				}}
			}),
			a.reviewCommentBox(colors),
		}
		return core.Scroll{TestID: "review-detail-scroll", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Gap: 12, Padding: core.Edges{Left: 20, Right: 20, Top: 10, Bottom: 24}, MaxWidth: core.Pt(860)},
				Children: body}}}
	})
}

// reviewDetailHead is the way back, the number and the title.
func (a *app) reviewDetailHead(colors ui.Colors, item reviewItem) core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
		core.View{OnPress: func(core.PressEvent) { a.review.closeItem() }, Role: core.RoleButton,
			Label: apptext.T("返回列表"), TestID: "review-back",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(26),
					Padding: core.Symmetric(0, 8), CornerRadius: 6, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			}, Children: []core.Node{
				ui.Icon(lucide.ChevronLeft, 13, colors.Muted),
				ui.Text(apptext.T("列表"), 11.5, ui.Medium, colors.Muted)}},
		ui.IconOf(reviewIcon(item), 15, func() core.Color { return reviewStateColor(colors, item) }),
		ui.Text("#"+strconv.Itoa(item.Number), 12, ui.Medium, colors.Faint),
		reviewStateBadge(item),
		core.View{Style: core.Style{FlexGrow: 1}},
		ui.Text(viewkit.WhenText(item.Updated, a.cx.Now()), 11, ui.Regular, colors.Faint),
	}}
}

// reviewDetailMeta is the author, the branches and the labels.
func (a *app) reviewDetailMeta(colors ui.Colors, d *reviewDetail) core.Node {
	item := d.Item
	meta := item.Author
	if item.Kind == reviewPR && item.Branch != "" {
		meta += " · " + item.Branch
		if item.Base != "" {
			meta += " → " + item.Base
		}
	}
	if d.Merge != "" {
		meta += " · " + mergeStateText(d.Merge)
	}
	return core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
		core.Text{Content: meta, MaxLines: 2, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
		core.View{Style: core.Style{Direction: core.Row, Gap: 4, Wrap: core.Wrap}, Children: []core.Node{
			reviewLabelChips(colors, item.Labels)}},
		core.Text{Content: item.Title, Style: core.Style{FontSize: 16, FontWeight: ui.Semibold, LineHeight: 23},
			StyleFunc: ui.Colored(colors.Text)},
	}}
}

// reviewActions are the item's buttons: the AI hand-off, merge, and the
// state change.
func (a *app) reviewActions(colors ui.Colors, d *reviewDetail) core.Node {
	// These pickers change independently of a GitHub detail refresh.
	// Keep their state reads in a reactive region, not the Show constructor.
	return core.Dynamic(func(*core.Scope) core.Node {
		item := d.Item
		open := item.State == "OPEN"
		busy := func() bool { st := a.review.state.Get(); return st.Writing || st.DetailBusy }
		mergeOpen := func() bool { return a.review.mergeOpen.Get() }
		reviewOpen := func() bool { return a.review.reviewOpen.Get() }
		var mergeRow []core.Node
		if item.Kind == reviewPR && open {
			if mergeOpen() {
				mergeRow = []core.Node{
					ui.Button{Text: apptext.T("压缩合并"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
						Disabled: busy, TestID: "review-merge-squash", OnPress: func() { a.reviewMerge(item, "squash") }},
					ui.Button{Text: apptext.T("合并提交"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						Disabled: busy, OnPress: func() { a.reviewMerge(item, "merge") }},
					ui.Button{Text: apptext.T("变基合并"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						Disabled: busy, OnPress: func() { a.reviewMerge(item, "rebase") }},
					ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						OnPress: func() { a.animateNextLayout(); a.review.mergeOpen.Set(false) }},
				}
			} else {
				mergeRow = []core.Node{ui.Button{Text: apptext.T("合并…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					Disabled: busy, Busy: func() bool { st := a.review.state.Get(); return st.Writing && st.WriteAction == reviewActMerge },
					TestID: "review-merge", OnPress: func() { a.animateNextLayout(); a.review.mergeOpen.Set(true) }}}
			}
		}
		var reviewRow []core.Node
		if item.Kind == reviewPR && open {
			if reviewOpen() {
				reviewRow = []core.Node{
					ui.Button{Text: apptext.T("批准"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
						Disabled: busy, TestID: "review-verdict-approve", OnPress: func() { a.reviewVerdict(item, verdictApprove) }},
					ui.Button{Text: apptext.T("请求修改"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						Disabled: busy, TestID: "review-verdict-changes", OnPress: func() { a.reviewVerdict(item, verdictRequestChanges) }},
					ui.Button{Text: apptext.T("只评论"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						Disabled: busy, TestID: "review-verdict-comment", OnPress: func() { a.reviewVerdict(item, verdictComment) }},
					ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						OnPress: func() { a.animateNextLayout(); a.review.reviewOpen.Set(false) }},
				}
			} else {
				reviewRow = []core.Node{ui.Button{Text: apptext.T("提交评审…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					Disabled: busy, Busy: func() bool { st := a.review.state.Get(); return st.Writing && st.WriteAction == reviewActReview },
					TestID: "review-verdict", OnPress: func() { a.animateNextLayout(); a.review.reviewOpen.Set(true) }}}
			}
		}
		stateLabel, stateIcon := apptext.T("关闭"), lucide.CircleSlash
		if !open {
			stateLabel, stateIcon = apptext.T("重新打开"), lucide.RotateCcw
		}
		buttons := []core.Node{
			ui.Button{Text: apptext.T("AI 评估"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, Icon: lucide.Sparkles,
				Disabled: busy, TestID: "review-evaluate", OnPress: func() { a.evaluateReviewItem() }},
		}
		buttons = append(buttons, reviewRow...)
		buttons = append(buttons, mergeRow...)
		if item.State != "MERGED" {
			buttons = append(buttons, ui.Button{Text: stateLabel, Variant: ui.ButtonGhost, Size: ui.SizeSmall, Icon: stateIcon,
				Disabled: busy, Busy: func() bool {
					st := a.review.state.Get()
					return st.Writing && (st.WriteAction == reviewActClose || st.WriteAction == reviewActReopen)
				},
				TestID: "review-state-change", OnPress: func() { a.reviewChangeState(item) }})
		}
		if item.URL != "" {
			buttons = append(buttons, ui.Button{Text: apptext.T("浏览器"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				Icon: lucide.ExternalLink, OnPress: func() { a.cx.OpenURL(item.URL, nil) }})
		}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Wrap: core.Wrap},
			Children: buttons}
	})
}

// reviewChecks lists the checks, folded away when there are many.
func (a *app) reviewChecks(colors ui.Colors, d *reviewDetail) core.Node {
	if len(d.Checks) == 0 {
		return nil
	}
	rows := make([]core.Node, 0, len(d.Checks))
	for _, c := range d.Checks {
		check := c
		tint := colors.Muted
		switch check.State {
		case checksPass:
			tint = colors.Up
		case checksFail:
			tint = colors.Danger
		case checksPending:
			tint = colors.Warn
		}
		tintOf := func() core.Color { return tint() }
		row := []core.Node{
			ui.Icon(reviewCheckIcon(check.State), 12, tintOf),
			core.Text{Content: check.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
		}
		if check.URL != "" {
			row = append(row, a.pressIcon(lucide.ExternalLink, "打开检查", 24, 12, nil,
				func() { a.cx.OpenURL(check.URL, nil) }, ""))
		}
		rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: row})
	}
	summary := reviewChecksSummary(d.Checks)
	return reviewSection(colors, summary, rows)
}

// reviewSection is one titled block of the detail.
func reviewSection(colors ui.Colors, title string, rows []core.Node) core.Node {
	return core.View{Style: core.Style{Gap: 6, Padding: core.Symmetric(10, 12), CornerRadius: 9, Background: colors.Surface(),
		BorderWidth: 1, BorderColor: colors.Border()}, Children: append([]core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
			ui.Text(title, 11.5, ui.Semibold, colors.Muted)}},
	}, rows...)}
}

// reviewFiles lists the changed paths with their line counts.
func (a *app) reviewFiles(colors ui.Colors, d *reviewDetail) core.Node {
	if len(d.Files) == 0 {
		return nil
	}
	shown := d.Files
	if len(shown) > 40 {
		shown = shown[:40]
	}
	rows := make([]core.Node, 0, len(shown)+1)
	for _, f := range shown {
		rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
			core.Text{Content: f.Path, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 11},
				StyleFunc: ui.Colored(colors.Muted)},
			ui.Text("+"+strconv.Itoa(f.Adds), 10.5, ui.Medium, colors.Up),
			ui.Text("-"+strconv.Itoa(f.Deletes), 10.5, ui.Medium, colors.Danger),
		}})
	}
	if len(d.Files) > len(shown) {
		rows = append(rows, core.Text{Content: fmt.Sprintf(apptext.T("还有 %d 个文件"), len(d.Files)-len(shown)),
			MaxLines: 1, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
	}
	rows = append([]core.Node{a.patchButton(colors)}, rows...)
	return reviewSection(colors, fmt.Sprintf(apptext.T("改动 %d 个文件"), len(d.Files)), rows)
}

// patchButton opens the pull request's whole diff.
func (a *app) patchButton(colors ui.Colors) core.Node {
	return core.View{Style: core.Style{AlignSelf: core.AlignStart}, Children: []core.Node{
		ui.Button{Text: apptext.T("查看补丁"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, Icon: lucide.FileDiff,
			TestID: "review-patch",
			OnPress: func() {
				a.openPane(paneReviewPatch)
				if !a.review.state.GetUntracked().PatchLoaded {
					a.review.loadPatch()
				}
			}}}}
}

// reviewBody is the item's description.
func (a *app) reviewBody(colors ui.Colors, d *reviewDetail) core.Node {
	if d.Body == "" {
		return nil
	}
	return reviewSection(colors, apptext.T("描述"), []core.Node{
		viewkit.MarkdownSized(d.Body, func() bool { return false }, false, a.readingFont(), a.readingLine(), core.Style{}),
	})
}

// reviewConversation is the comments and reviews, oldest first.
func (a *app) reviewConversation(colors ui.Colors, d *reviewDetail) core.Node {
	if len(d.Comments) == 0 {
		return nil
	}
	rows := make([]core.Node, 0, len(d.Comments))
	for _, c := range d.Comments {
		comment := c
		row := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Text(comment.Author, 11.5, ui.Semibold, colors.Text),
				core.Text{Content: viewkit.WhenText(comment.At, a.cx.Now()), MaxLines: 1,
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
				reviewReviewBadge(comment.State),
			}},
		}
		if comment.Body != "" {
			row = append(row, viewkit.MarkdownSized(comment.Body, func() bool { return false }, false,
				a.readingFont(), a.readingLine(), core.Style{}))
		}
		rows = append(rows, core.View{Style: core.Style{Gap: 4, Padding: core.Edges{Top: 8, Bottom: 8},
			Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Line()}}, Children: row})
	}
	return reviewSection(colors, fmt.Sprintf(apptext.T("讨论 %d 条"), len(d.Comments)), rows)
}

// reviewCommentBox posts a comment on the open item.
func (a *app) reviewCommentBox(colors ui.Colors) core.Node {
	return core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
		core.Input{Value: a.review.commentText.Get, OnChange: a.review.commentText.Set, Multiline: true,
			Placeholder: apptext.T("写评论…"), Label: apptext.T("评论"), TestID: "review-comment",
			Style: core.Style{MinHeight: core.Pt(64), MaxHeight: core.Pt(180), Padding: core.Symmetric(7, 9), FontSize: 12.5, Color: colors.Text()},
			StyleFunc: func() core.Style {
				return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 8,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
			}},
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
			core.Text{ContentFunc: func() string {
				if d := a.review.state.Get().Detail; d != nil && d.Item.State != "OPEN" {
					return apptext.T("这一条已经关闭，评论仍会发到 GitHub。")
				}
				return apptext.T("写一条评论，回车换行，发出去会直接贴到 GitHub。")
			}, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
			ui.Button{Text: apptext.T("发表评论"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "review-comment-send",
				Busy: func() bool { st := a.review.state.Get(); return st.Writing && st.WriteAction == reviewActComment },
				Disabled: func() bool {
					st := a.review.state.Get()
					return st.Writing || st.DetailBusy || strings.TrimSpace(a.review.commentText.Get()) == ""
				},
				OnPress: func() { a.commentOnReview(a.review.commentText.GetUntracked()) }},
		}},
	}}
}

// reviewStateBadge is the item's state as one chip.
func reviewStateBadge(item reviewItem) core.Node {
	label, variant := apptext.T("打开"), ui.BadgeAccent
	switch item.State {
	case "MERGED":
		label, variant = apptext.T("已合并"), ui.BadgeAccent
	case "CLOSED":
		label, variant = apptext.T("已关闭"), ui.BadgeNeutral
	}
	if item.Draft && item.State == "OPEN" {
		label, variant = apptext.T("草稿"), ui.BadgeNeutral
	}
	return ui.Badge{Text: label, Variant: variant}
}

// reviewReviewBadge is a review's verdict as one chip, "" for a comment.
func reviewReviewBadge(state string) core.Node {
	switch state {
	case "APPROVED":
		return ui.Badge{Text: apptext.T("已批准"), Variant: ui.BadgeAccent}
	case "CHANGES_REQUESTED":
		return ui.Badge{Text: apptext.T("请求修改"), Variant: ui.BadgeWarn}
	case "DISMISSED":
		return ui.Badge{Text: apptext.T("已驳回"), Variant: ui.BadgeNeutral}
	}
	return nil
}

// reviewCheckIcon is one check's glyph.
func reviewCheckIcon(state string) func() *core.SVG {
	return viewkit.ReviewCheckGlyph(state)
}

// reviewChecksSummary counts the checks by state.
func reviewChecksSummary(checks []reviewCheck) string {
	pass, fail, pending := 0, 0, 0
	for _, c := range checks {
		switch c.State {
		case checksPass:
			pass++
		case checksFail:
			fail++
		default:
			pending++
		}
	}
	if fail > 0 {
		return fmt.Sprintf(apptext.T("检查：%d 通过，%d 失败，%d 进行中"), pass, fail, pending)
	}
	return fmt.Sprintf(apptext.T("检查：%d 通过，%d 进行中"), pass, pending)
}

// mergeStateText says what GitHub thinks of a merge.
func mergeStateText(state string) string {
	switch state {
	case "CLEAN":
		return apptext.T("可合并")
	case "BLOCKED":
		return apptext.T("被分支保护挡住")
	case "BEHIND":
		return apptext.T("落后于目标分支")
	case "DIRTY", "CONFLICTING":
		return apptext.T("有冲突")
	case "UNSTABLE":
		return apptext.T("检查未通过")
	case "HAS_HOOKS":
		return apptext.T("等待钩子")
	case "MERGEABLE":
		return apptext.T("可合并")
	case "UNKNOWN", "":
		return ""
	}
	return state
}
