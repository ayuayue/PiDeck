package client

// The phone's review screen: a project's pull requests and issues, one
// item's conversation, and the same actions the desktop pane offers —
// comment, merge, close or reopen, and hand it to a session on the
// desktop to evaluate. The desktop runs gh and owns the credential; this
// file only asks it to.

import (
	"fmt"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// msTime turns a Unix millisecond count the desktop sends into a time.
func msTime(ms int64) time.Time {
	if ms <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}

// reviewProjectFor is the project the review screen reads: the open
// session's, or the first one the desktop lists.
func (a *mobileApp) reviewProjectFor() (string, string) {
	if path, name := a.projectOf(a.active.GetUntracked()); path != "" {
		return path, name
	}
	for _, p := range a.state.Get().Projects {
		return p.Path, p.Name
	}
	return "", ""
}

// openReview shows the project's pull requests.
func (a *mobileApp) openReview() {
	path, name := a.reviewProjectFor()
	if path == "" {
		a.flash(apptext.T("先选一个项目"))
		return
	}
	a.openDrawer(false)
	a.reviewProject.Set(path)
	a.reviewName.Set(name)
	a.reviewKind.Set("pr")
	a.reviewFilter.Set("open")
	a.reviewQuery.Set("")
	a.reviewItems.Set(nil)
	a.reviewErr.Set("")
	a.reviewMissing.Set(false)
	a.reviewDetailOpen.Set(false)
	a.reviewOpen.Set(true)
	a.loadReview()
}

// loadReview reads the list the screen is showing.
func (a *mobileApp) loadReview() {
	client := a.client
	project := a.reviewProject.GetUntracked()
	if client == nil || project == "" || a.reviewBusy.GetUntracked() {
		return
	}
	kind, filter, query := a.reviewKind.GetUntracked(), a.reviewFilter.GetUntracked(), strings.TrimSpace(a.reviewQuery.GetUntracked())
	a.reviewBusy.Set(true)
	a.reviewErr.Set("")
	go func() {
		list, err := client.review(project, kind, filter, query)
		a.cx.Post(func() {
			a.reviewBusy.Set(false)
			if err != nil {
				a.reviewErr.Set(remoteErrorText(err))
				return
			}
			a.reviewMissing.Set(list.Missing)
			a.reviewErr.Set(list.Error)
			a.reviewItems.Set(list.Items)
		})
	}()
}

// setReviewKind switches between pull requests and issues.
func (a *mobileApp) setReviewKind(kind string) {
	if a.reviewKind.GetUntracked() == kind {
		return
	}
	a.reviewKind.Set(kind)
	a.reviewItems.Set(nil)
	a.loadReview()
}

// setReviewFilter switches the state filter.
func (a *mobileApp) setReviewFilter(filter string) {
	if a.reviewFilter.GetUntracked() == filter {
		return
	}
	a.reviewFilter.Set(filter)
	a.reviewItems.Set(nil)
	a.loadReview()
}

// openReviewDetail reads one item and shows its page.
func (a *mobileApp) openReviewDetail(item remotewire.ReviewItem) {
	client := a.client
	project := a.reviewProject.GetUntracked()
	if client == nil || project == "" {
		return
	}
	a.reviewDetail.Set(remotewire.ReviewDetail{Item: item})
	a.reviewDetailErr.Set("")
	a.reviewComment.Set("")
	a.reviewPending.Set("")
	a.reviewDetailOpen.Set(true)
	a.reviewDetailBusy.Set(true)
	kind, number := item.Kind, item.Number
	go func() {
		detail, err := client.reviewDetail(project, kind, number)
		a.cx.Post(func() {
			a.reviewDetailBusy.Set(false)
			if err != nil {
				a.reviewDetailErr.Set(remoteErrorText(err))
				return
			}
			a.reviewDetail.Set(detail)
		})
	}()
}

// refreshReviewDetail rereads the open item.
func (a *mobileApp) refreshReviewDetail() {
	detail := a.reviewDetail.GetUntracked()
	if detail.Item.Number == 0 {
		return
	}
	a.openReviewDetail(detail.Item)
}

// sendReviewComment posts the comment box on the open item.
func (a *mobileApp) sendReviewComment() {
	client := a.client
	project := a.reviewProject.GetUntracked()
	detail := a.reviewDetail.GetUntracked()
	body := strings.TrimSpace(a.reviewComment.GetUntracked())
	if client == nil || project == "" || detail.Item.Number == 0 || body == "" {
		return
	}
	a.reviewSending.Set(true)
	number, kind := detail.Item.Number, detail.Item.Kind
	go func() {
		err := client.reviewWrite(project, kind, number, "comment", body, "")
		a.cx.Post(func() {
			a.reviewSending.Set(false)
			if err != nil {
				a.flash(remoteErrorText(err))
				return
			}
			a.reviewComment.Set("")
			a.flash(apptext.T("评论已发出"))
			a.refreshReviewDetail()
			a.loadReview()
		})
	}()
}

// reviewConfirm asks for the next write on the open item.
func (a *mobileApp) reviewConfirm(action string) {
	a.reviewPending.Set(action)
}

// runReviewPending performs the write the confirm bar asked about.
func (a *mobileApp) runReviewPending() {
	client := a.client
	project := a.reviewProject.GetUntracked()
	detail := a.reviewDetail.GetUntracked()
	pending := a.reviewPending.GetUntracked()
	if client == nil || project == "" || detail.Item.Number == 0 || pending == "" || a.reviewSending.GetUntracked() {
		return
	}
	action, method, body := pending, "", ""
	switch {
	case strings.HasPrefix(pending, "merge:"):
		action, method = "merge", strings.TrimPrefix(pending, "merge:")
	case strings.HasPrefix(pending, "review:"):
		action, method, body = "review", strings.TrimPrefix(pending, "review:"), strings.TrimSpace(a.reviewComment.GetUntracked())
	}
	a.reviewPending.Set("")
	a.reviewSending.Set(true)
	number, kind := detail.Item.Number, detail.Item.Kind
	go func() {
		err := client.reviewWrite(project, kind, number, action, body, method)
		a.cx.Post(func() {
			a.reviewSending.Set(false)
			if err != nil {
				a.flash(remoteErrorText(err))
				return
			}
			switch action {
			case "merge":
				a.flash(apptext.T("已合并"))
			case "close":
				a.flash(apptext.T("已关闭"))
			case "review":
				a.flash(apptext.T("评审已提交"))
				a.reviewComment.Set("")
			default:
				a.flash(apptext.T("已重新打开"))
			}
			a.refreshReviewDetail()
			a.loadReview()
		})
	}()
}

// evaluateReview asks the desktop to hand the item to a session, then
// opens that session so the answer shows where it lands.
func (a *mobileApp) evaluateReview() {
	client := a.client
	project := a.reviewProject.GetUntracked()
	detail := a.reviewDetail.GetUntracked()
	if client == nil || project == "" || detail.Item.Number == 0 || a.reviewSending.GetUntracked() {
		return
	}
	a.reviewSending.Set(true)
	number, kind, title := detail.Item.Number, detail.Item.Kind, detail.Item.Title
	go func() {
		id, err := client.reviewEvaluate(project, kind, number)
		a.cx.Post(func() {
			a.reviewSending.Set(false)
			if err != nil {
				a.flash(remoteErrorText(err))
				return
			}
			a.reviewDetailOpen.Set(false)
			a.reviewOpen.Set(false)
			a.openSession(id, fmt.Sprintf("#%d %s", number, title))
			a.refreshState()
		})
	}()
}

// openReviewPatch reads the open pull request's diff.
func (a *mobileApp) openReviewPatch() {
	client := a.client
	project := a.reviewProject.GetUntracked()
	detail := a.reviewDetail.GetUntracked()
	if client == nil || project == "" || detail.Item.Number == 0 {
		return
	}
	a.reviewPatch.Set("")
	a.reviewPatchErr.Set("")
	a.reviewPatchBusy.Set(true)
	a.reviewPatchOpen.Set(true)
	number := detail.Item.Number
	go func() {
		patch, err := client.reviewDiff(project, number)
		a.cx.Post(func() {
			a.reviewPatchBusy.Set(false)
			if err != nil {
				a.reviewPatchErr.Set(remoteErrorText(err))
				return
			}
			a.reviewPatch.Set(patch)
		})
	}()
}

// reviewPatchSheet shows the pull request's whole diff.
func (a *mobileApp) reviewPatchSheet() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		title := apptext.T("补丁")
		if detail := a.reviewDetail.Get(); detail.Item.Number > 0 {
			title = fmt.Sprintf("#%d", detail.Item.Number)
		}
		var body core.Node
		switch {
		case a.reviewPatchBusy.Get():
			body = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.All(16)}, Children: []core.Node{
				ui.Spinner{Size: 12}, ui.Text(apptext.T("正在读取补丁…"), 12, ui.Regular, colors.Muted)}}
		case a.reviewPatchErr.Get() != "":
			body = core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(a.reviewPatchErr.Get(), 12, ui.Regular, colors.Danger)}}
		case strings.TrimSpace(a.reviewPatch.Get()) == "":
			body = core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(apptext.T("没有可显示的差异"), 12, ui.Regular, colors.Faint)}}
		default:
			body = patchBody(func() string { return a.reviewPatch.Get() }, "mobile-review-patch-body")
		}
		return ui.Dialog{
			Open:         a.reviewPatchOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.reviewPatchOpen.Set(open) },
			Title:        title,
			TestID:       "mobile-review-patch",
			Style:        core.Style{Width: core.Pct(100), MaxWidth: patchSheetWidth(cx)},
			Children:     []core.Node{body},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.reviewPatchOpen.Set(false) }},
			},
		}
	})
}

// reviewSheet lists the project's pull requests and issues.
func (a *mobileApp) reviewSheet() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		kind := a.reviewKind.Get()
		var rows []core.Node
		switch {
		case a.reviewMissing.Get():
			rows = append(rows, a.reviewNote(colors, apptext.T("这台机器上没有 GitHub CLI"),
				apptext.T("装好 gh 并在终端运行 gh auth login，评审面板就会列出项目里的拉取请求与议题。")))
		case a.reviewErr.Get() != "":
			rows = append(rows, a.reviewNote(colors, apptext.T("读不到 GitHub"), a.reviewErr.Get()))
		case a.reviewBusy.Get() && len(a.reviewItems.Get()) == 0:
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.All(12)},
				Children: []core.Node{ui.Spinner{Size: 12}, ui.Text(apptext.T("正在读取…"), 12, ui.Regular, colors.Muted)}})
		case len(a.reviewItems.Get()) == 0:
			rows = append(rows, a.reviewNote(colors, apptext.T("没有符合条件的条目"), apptext.T("换一个状态筛选，或清空搜索再试。")))
		default:
			for _, item := range a.reviewItems.Get() {
				rows = append(rows, a.reviewRow(colors, item))
			}
		}
		return ui.Dialog{
			Open:         a.reviewOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.reviewOpen.Set(open) },
			Title:        apptext.T("评审") + " · " + a.reviewName.Get(),
			TestID:       "mobile-review",
			Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(560)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, Gap: 6, Wrap: core.Wrap}, Children: []core.Node{
					a.reviewChip(colors, "pr", "拉取请求", kind == "pr", func() { a.setReviewKind("pr") }, "mobile-review-kind-pr"),
					a.reviewChip(colors, "issue", "议题", kind == "issue", func() { a.setReviewKind("issue") }, "mobile-review-kind-issue"),
					core.View{Style: core.Style{Width: core.Pt(6)}},
					a.reviewFilterChip(colors, "open", "打开"),
					a.reviewFilterChip(colors, "closed", "已关闭"),
					a.reviewFilterChip(colors, "all", "全部"),
				}},
				core.Input{Value: a.reviewQuery.Get, OnChange: a.reviewQuery.Set, OnSubmit: func(string) { a.loadReview() },
					Placeholder: apptext.T("搜索标题、编号或标签"), Label: apptext.T("搜索"),
					TestID: "mobile-review-search",
					Style:  core.Style{Height: core.Pt(34), Padding: core.Symmetric(0, 9), FontSize: 12.5, Color: colors.Text()},
					StyleFunc: func() core.Style {
						return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 8,
							PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
					}},
				core.Scroll{Style: core.Style{MaxHeight: core.Pt(420)}, Children: []core.Node{
					core.View{Style: core.Style{Gap: 2}, Children: rows}}},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("刷新"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: a.loadReview},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.reviewOpen.Set(false) }},
			},
		}
	})
}

// reviewRow is one pull request or issue.
func (a *mobileApp) reviewRow(colors ui.Colors, item remotewire.ReviewItem) core.Node {
	marks := []core.Node{a.reviewCheckMark(colors, item.Checks)}
	if item.Kind == "pr" && (item.Adds > 0 || item.Deletes > 0) {
		marks = append(marks, ui.Text(fmt.Sprintf("+%d", item.Adds), 10, ui.Medium, colors.Up),
			ui.Text(fmt.Sprintf("-%d", item.Deletes), 10, ui.Medium, colors.Danger))
	}
	meta := item.Author
	if item.Kind == "pr" && item.Branch != "" {
		meta += " · " + item.Branch
	}
	return core.View{OnPress: func(core.PressEvent) { a.openReviewDetail(item) }, Role: core.RoleButton,
		Label: fmt.Sprintf("#%d %s", item.Number, item.Title), TestID: fmt.Sprintf("mobile-review-row-%d", item.Number),
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(48),
				Padding: core.Symmetric(5, 4), CornerRadius: 8, Active: &core.Style{Background: colors.Pressed()}}
		}, Children: []core.Node{
			ui.Icon(a.reviewIcon(item), 14, func() core.Color { return a.reviewColor(colors, item) }),
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: []core.Node{
					ui.Text("#"+fmt.Sprint(item.Number), 11, ui.Medium, colors.Faint),
					core.Text{Content: item.Title, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
				}},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: append([]core.Node{
					core.Text{Content: meta, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
				}, marks...)},
			}},
			ui.Icon(lucide.ChevronRight, 13, colors.Faint),
		}}
}

// reviewDetailSheet is one item's page.
func (a *mobileApp) reviewDetailSheet() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		detail := a.reviewDetail.Get()
		item := detail.Item
		var body []core.Node
		switch {
		case a.reviewDetailErr.Get() != "" && len(detail.Comments) == 0 && detail.Body == "":
			body = append(body, a.reviewNote(colors, apptext.T("读不到这一条"), a.reviewDetailErr.Get()))
		case a.reviewDetailBusy.Get() && detail.Body == "" && len(detail.Comments) == 0 && len(detail.Checks) == 0:
			body = append(body, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.All(12)},
				Children: []core.Node{ui.Spinner{Size: 12}, ui.Text(apptext.T("正在读取详情…"), 12, ui.Regular, colors.Muted)}})
		default:
			body = append(body, a.reviewDetailBody(colors, detail)...)
		}
		return ui.Dialog{
			Open:         a.reviewDetailOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.reviewDetailOpen.Set(open) },
			Title:        fmt.Sprintf("#%d", item.Number),
			TestID:       "mobile-review-detail",
			Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(620)},
			Children:     []core.Node{core.View{Style: core.Style{Gap: 8}, Children: body}},
			Footer:       a.reviewDetailFooter(colors, detail),
		}
	})
}

// reviewDetailBody is the item's conversation and actions.
func (a *mobileApp) reviewDetailBody(colors ui.Colors, detail remotewire.ReviewDetail) []core.Node {
	item := detail.Item
	out := []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
			ui.Icon(a.reviewIcon(item), 14, func() core.Color { return a.reviewColor(colors, item) }),
			ui.Text("#"+fmt.Sprint(item.Number), 11.5, ui.Medium, colors.Faint),
			core.Text{Content: a.reviewStateLabel(item), MaxLines: 1, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
		}},
		core.Text{Content: item.Title, Style: core.Style{FontSize: 15, FontWeight: ui.Semibold, LineHeight: 21}, StyleFunc: ui.Colored(colors.Text)},
	}
	meta := item.Author
	if item.Branch != "" {
		meta += " · " + item.Branch
		if item.Base != "" {
			meta += " → " + item.Base
		}
	}
	out = append(out, core.Text{Content: meta, MaxLines: 2, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
	if detail.Body != "" {
		out = append(out, viewkit.MarkdownSized(detail.Body, func() bool { return false }, false, 12.5, 19, core.Style{}))
	}
	if len(detail.Checks) > 0 {
		checkRows := make([]core.Node, 0, len(detail.Checks))
		for _, c := range detail.Checks {
			check := c
			checkRows = append(checkRows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				a.reviewCheckMark(colors, check.State),
				core.Text{Content: check.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
			}})
		}
		out = append(out, core.View{Style: core.Style{Gap: 4, Padding: core.Symmetric(8, 0)}, Children: checkRows})
	}
	if len(detail.Files) > 0 {
		fileRows := make([]core.Node, 0, len(detail.Files))
		shown := detail.Files
		if len(shown) > 30 {
			shown = shown[:30]
		}
		for _, f := range shown {
			fileRows = append(fileRows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				core.Text{Content: f.Path, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Faint)},
				ui.Text(fmt.Sprintf("+%d", f.Adds), 9.5, ui.Medium, colors.Up),
				ui.Text(fmt.Sprintf("-%d", f.Deletes), 9.5, ui.Medium, colors.Danger),
			}})
		}
		if item.Kind == "pr" {
			fileRows = append([]core.Node{ui.Button{Text: apptext.T("查看补丁…"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "mobile-review-patch", OnPress: a.openReviewPatch}}, fileRows...)
		}
		out = append(out, core.View{Style: core.Style{Gap: 3, Padding: core.Symmetric(8, 0)}, Children: fileRows})
	}
	for _, c := range detail.Comments {
		comment := c
		row := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: []core.Node{
				ui.Text(comment.Author, 11, ui.Semibold, colors.Text),
				core.Text{Content: viewkit.WhenText(msTime(comment.At), a.cx.Now()), MaxLines: 1,
					Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
			}},
		}
		if comment.Body != "" {
			row = append(row, viewkit.MarkdownSized(comment.Body, func() bool { return false }, false, 12, 18, core.Style{}))
		}
		out = append(out, core.View{Style: core.Style{Gap: 3, Padding: core.Edges{Top: 8, Bottom: 8},
			Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Line()}}, Children: row})
	}
	out = append(out, core.Input{Value: a.reviewComment.Get, OnChange: a.reviewComment.Set, Multiline: true,
		Placeholder: apptext.T("写评论…"), Label: apptext.T("评论"), TestID: "mobile-review-comment",
		Style: core.Style{MinHeight: core.Pt(60), MaxHeight: core.Pt(140), Padding: core.Symmetric(7, 9), FontSize: 12.5, Color: colors.Text()},
		StyleFunc: func() core.Style {
			return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 8,
				PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
		}})
	if item.Kind == "pr" && item.State == "OPEN" {
		out = append(out, core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: []core.Node{
			ui.Button{Text: apptext.T("批准…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "mobile-review-approve",
				Disabled: func() bool { return a.reviewSending.Get() }, OnPress: func() { a.reviewConfirm("review:approve") }},
			ui.Button{Text: apptext.T("请求修改…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "mobile-review-changes",
				Disabled: func() bool { return a.reviewSending.Get() }, OnPress: func() { a.reviewConfirm("review:request-changes") }},
			ui.Button{Text: apptext.T("只评论…"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "mobile-review-verdict-comment",
				Disabled: func() bool { return a.reviewSending.Get() }, OnPress: func() { a.reviewConfirm("review:comment") }},
		}})
	}
	if pending := a.reviewPending.Get(); pending != "" {
		out = append(out, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6,
			Padding: core.Symmetric(8, 10), CornerRadius: 8, Background: colors.Inset()}, Children: []core.Node{
			core.Text{Content: a.reviewPendingText(pending), MaxLines: 2,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11}, StyleFunc: ui.Colored(colors.Text)},
			ui.Button{Text: apptext.T("确定"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-review-confirm",
				Disabled: func() bool { return a.reviewSending.Get() }, OnPress: a.runReviewPending},
			ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				OnPress: func() { a.reviewPending.Set("") }},
		}})
	}
	return out
}

// reviewDetailFooter is the item's actions.
func (a *mobileApp) reviewDetailFooter(colors ui.Colors, detail remotewire.ReviewDetail) []core.Node {
	item := detail.Item
	busy := func() bool { return a.reviewSending.Get() }
	out := []core.Node{
		ui.Button{Text: apptext.T("发表评论"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-review-send",
			Disabled: func() bool {
				return busy() || strings.TrimSpace(a.reviewComment.Get()) == ""
			}, OnPress: a.sendReviewComment},
		ui.Button{Text: apptext.T("AI 评估"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
			Disabled: busy, TestID: "mobile-review-evaluate", OnPress: a.evaluateReview},
	}
	if item.Kind == "pr" && item.State == "OPEN" {
		out = append(out, ui.Button{Text: apptext.T("合并…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
			Disabled: busy, TestID: "mobile-review-merge", OnPress: func() { a.reviewConfirm("merge:squash") }})
	}
	label := apptext.T("关闭")
	if item.State != "OPEN" {
		label = apptext.T("重新打开")
	}
	out = append(out, ui.Button{Text: label, Variant: ui.ButtonGhost, Size: ui.SizeSmall, Disabled: busy,
		OnPress: func() {
			if item.State == "OPEN" {
				a.reviewConfirm("close")
				return
			}
			a.reviewConfirm("reopen")
		}})
	return out
}

// reviewPendingText says what the confirm bar will do.
func (a *mobileApp) reviewPendingText(pending string) string {
	switch pending {
	case "close":
		return apptext.T("关闭之后仍可以在 GitHub 上重新打开，确定吗？")
	case "reopen":
		return apptext.T("会重新打开这一条，确定吗？")
	case "merge:squash":
		return apptext.T("以压缩合并的方式合入目标分支，之后对所有人可见。需要其他合并方式请在电脑上操作。")
	case "review:approve":
		return apptext.T("批准这个拉取请求；评论框里的文字会一起提交。")
	case "review:request-changes":
		return apptext.T("提交「请求修改」；评论框里的文字会一起提交，所以先写说明。")
	case "review:comment":
		return apptext.T("只留评论，不改变批准状态；评论框里的文字会一起提交。")
	}
	return apptext.T("确定要这么做吗？")
}

// reviewNote is one explanation row in a sheet.
func (a *mobileApp) reviewNote(colors ui.Colors, title, note string) core.Node {
	return core.View{Style: core.Style{Gap: 4, Padding: core.All(10)}, Children: []core.Node{
		ui.Text(title, 12.5, ui.Medium, colors.Muted),
		core.Text{Content: note, MaxLines: 4, Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
	}}
}

// reviewChip is one of the sheet's kind tabs.
func (a *mobileApp) reviewChip(colors ui.Colors, kind, label string, on bool, press func(), testID string) core.Node {
	return core.View{OnPress: func(core.PressEvent) { press() }, Role: core.RoleTab, Label: apptext.T(label), TestID: testID,
		StyleFunc: func() core.Style {
			st := core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 11), CornerRadius: 8, JustifyContent: core.JustifyCenter,
				AlignItems: core.AlignCenter, Active: &core.Style{Background: colors.Pressed()}}
			if on {
				st.Background = colors.Surface()
				st.BorderWidth = 1
				st.BorderColor = colors.Border()
			}
			return st
		}, Children: []core.Node{ui.Text(apptext.T(label), 12, ui.Medium, func() core.Color {
			if on {
				return colors.Text()
			}
			return colors.Muted()
		})}}
}

// reviewFilterChip is one of the sheet's state filters.
func (a *mobileApp) reviewFilterChip(colors ui.Colors, value, label string) core.Node {
	on := func() bool { return a.reviewFilter.Get() == value }
	return core.View{OnPress: func(core.PressEvent) { a.setReviewFilter(value) }, Role: core.RoleButton,
		Label: apptext.T(label), TestID: "mobile-review-filter-" + value,
		StyleFunc: func() core.Style {
			st := core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 9), CornerRadius: 8, JustifyContent: core.JustifyCenter,
				AlignItems: core.AlignCenter, Active: &core.Style{Background: colors.Pressed()}}
			if on() {
				st.Background = colors.Inset()
			}
			return st
		}, Children: []core.Node{ui.Text(apptext.T(label), 11.5, ui.Medium, func() core.Color {
			if on() {
				return colors.Text()
			}
			return colors.Muted()
		})}}
}

// reviewCheckMark is a check summary as one glyph.
func (a *mobileApp) reviewCheckMark(colors ui.Colors, state string) core.Node {
	switch state {
	case "pass":
		return ui.Icon(lucide.CircleCheck, 12, colors.Up)
	case "fail":
		return ui.Icon(lucide.CircleX, 12, colors.Danger)
	case "pending":
		return ui.Icon(lucide.Clock, 12, colors.Warn)
	}
	return nil
}

// reviewIcon is an item's kind and state in one glyph.
func (a *mobileApp) reviewIcon(item remotewire.ReviewItem) func() *core.SVG {
	switch item.State {
	case "MERGED":
		return lucide.GitMerge
	case "CLOSED":
		if item.Kind == "pr" {
			return lucide.GitPullRequestClosed
		}
		return lucide.CircleSlash
	}
	if item.Kind == "pr" {
		return lucide.GitPullRequestArrow
	}
	return lucide.CircleDot
}

// reviewColor colors an item's glyph.
func (a *mobileApp) reviewColor(colors ui.Colors, item remotewire.ReviewItem) core.Color {
	switch item.State {
	case "MERGED":
		return colors.Accent()
	case "CLOSED":
		return colors.Faint()
	}
	if item.Checks == "fail" {
		return colors.Danger()
	}
	return colors.Up()
}

// reviewStateLabel is an item's state in words.
func (a *mobileApp) reviewStateLabel(item remotewire.ReviewItem) string {
	switch item.State {
	case "MERGED":
		return apptext.T("已合并")
	case "CLOSED":
		return apptext.T("已关闭")
	}
	if item.Draft {
		return apptext.T("草稿")
	}
	return apptext.T("打开")
}
