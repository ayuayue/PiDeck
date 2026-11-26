//go:build !js && !android && !ios

package workbench

import (
	"context"
	"fmt"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

type diagBrowser struct {
	a        *app
	cx       *core.Scope
	ctx      context.Context
	category *core.Signal[string]
	level    *core.Signal[string]
	period   *core.Signal[string]
	text     *core.Signal[string]
	busy     *core.Signal[bool]
	err      *core.Signal[string]
	notice   *core.Signal[string]
	result   *core.Signal[*diagResult]
	applied  diagFilter
	limit    int
	seq      int
}

func (a *app) diagLogGroup() core.Node {
	return setGroup("日志", core.Func(func(cx *core.Scope) core.Node {
		b := &diagBrowser{a: a, cx: cx, ctx: cx.Context(), category: core.NewSignal(cx, ""), level: core.NewSignal(cx, ""),
			period: core.NewSignal(cx, ""), text: core.NewSignal(cx, ""), busy: core.NewSignal(cx, false),
			err: core.NewSignal(cx, ""), notice: core.NewSignal(cx, ""), result: core.NewSignal(cx, &diagResult{}), limit: 100}
		b.load(true)
		return b.view()
	}))
}

func (b *diagBrowser) filter() diagFilter {
	f := diagFilter{Category: b.category.GetUntracked(), Level: b.level.GetUntracked(), Text: b.text.GetUntracked()}
	duration := map[string]time.Duration{"hour": time.Hour, "day": 24 * time.Hour, "week": 7 * 24 * time.Hour}[b.period.GetUntracked()]
	if duration > 0 {
		f.Since = time.Now().Add(-duration)
	}
	return f
}

func (b *diagBrowser) load(reset bool) {
	if reset {
		b.limit = 100
		b.applied = b.filter()
	}
	b.busy.Set(true)
	b.err.Set("")
	b.seq++
	seq, filter, limit, ctx := b.seq, b.applied, b.limit, b.ctx
	go func() {
		var result diagResult
		var err error
		if b.a.diagJournal == nil {
			err = errDiagClosed
		} else {
			result, err = b.a.diagJournal.query(filter, limit)
		}
		if ctx.Err() != nil {
			return
		}
		b.cx.Post(func() {
			if seq != b.seq {
				return
			}
			b.busy.Set(false)
			b.result.Set(&result)
			if err != nil {
				b.err.Set(apptext.T("读取日志失败：%s", redactDiagText(err.Error())))
			}
		})
	}()
}

func (b *diagBrowser) clear(all bool) {
	filter := b.applied
	title, detail := apptext.T("清理筛选结果"), apptext.T("将永久删除当前筛选条件匹配的历史日志，其他日志保留。此操作无法撤销。")
	if all {
		filter = diagFilter{}
		title, detail = apptext.T("清空全部日志"), apptext.T("将永久删除所有分类的历史日志。此操作无法撤销；确认期间及之后产生的新日志保留。")
	}
	// Capture the cutoff before showing the dialog. Records produced while
	// the user considers the confirmation must never be removed by it.
	filter.Until = time.Now()
	b.a.askConfirm(title, detail, apptext.T("清理"), func() {
		b.busy.Set(true)
		b.err.Set("")
		ctx := b.ctx
		go func() {
			n, err := b.a.clearDiagHistory(filter)
			if ctx.Err() != nil {
				return
			}
			b.cx.Post(func() {
				if err != nil {
					b.busy.Set(false)
					b.err.Set(apptext.T("清理日志失败：%s", redactDiagText(err.Error())))
					return
				}
				b.notice.Set(apptext.T("已清理 %d 条日志。", n))
				b.a.logEvent("info", "app", "", "清理日志 · %d 条", n)
				b.load(false)
			})
		}()
	})
}

func (a *app) clearDiagHistory(filter diagFilter) (int, error) {
	if a.diagJournal == nil {
		return 0, errDiagClosed
	}
	n, err := a.diagJournal.clear(filter)
	if err == nil {
		a.diagMu.Lock()
		kept := a.diagEvents[:0]
		for _, ev := range a.diagEvents {
			if !filter.matches(ev) {
				kept = append(kept, ev)
			}
		}
		a.diagEvents = kept
		a.diagMu.Unlock()
	}
	return n, err
}

func (b *diagBrowser) view() core.Node {
	colors := ui.ColorsOf(b.cx)
	selectField := func(label, id string, value *core.Signal[string], opts []ui.Option[string]) core.Node {
		return ui.Select[string]{Label: apptext.T(label), TestID: id, Value: value.Get, Options: opts,
			Disabled: b.busy.Get, OnChange: func(v string) { value.Set(v); b.notice.Set(""); b.load(true) },
			Style: core.Style{MinWidth: core.Pt(118), FlexGrow: 1, FlexShrink: 1}}
	}
	return core.View{TestID: "diag-log-browser", Style: core.Style{Gap: 8, Padding: core.Symmetric(8, 2)}, Children: []core.Node{
		ui.Text(apptext.T("日志保存在本机，自动轮转。启动参数已脱敏，不记录对话正文；会话使用匿名关联码。"), 11, ui.Regular, colors.Muted),
		core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: []core.Node{
			selectField("日志分类", "diag-log-category", b.category, []ui.Option[string]{
				{Value: "", Label: apptext.T("全部分类")}, {Value: "app", Label: diagCategoryLabel("app")},
				{Value: "startup", Label: diagCategoryLabel("startup")}, {Value: "acp", Label: "ACP"}, {Value: "git", Label: "Git"},
				{Value: "session", Label: diagCategoryLabel("session")}, {Value: "notification", Label: diagCategoryLabel("notification")}}),
			selectField("日志级别", "diag-log-level", b.level, []ui.Option[string]{
				{Value: "", Label: apptext.T("全部级别")}, {Value: "info", Label: diagLevelLabel("info")},
				{Value: "warn", Label: diagLevelLabel("warn")}, {Value: "error", Label: diagLevelLabel("error")}, {Value: "exception", Label: diagLevelLabel("exception")}}),
			selectField("时间范围", "diag-log-period", b.period, []ui.Option[string]{
				{Value: "", Label: apptext.T("全部时间")}, {Value: "hour", Label: apptext.T("最近一小时")},
				{Value: "day", Label: apptext.T("最近一天")}, {Value: "week", Label: apptext.T("最近七天")}}),
		}},
		core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: []core.Node{
			ui.Input{Label: apptext.T("日志查询"), Placeholder: apptext.T("搜索日志、操作或会话关联码"), TestID: "diag-log-query",
				Value: b.text.Get, OnChange: b.text.Set, OnSubmit: func(string) {
					if !b.busy.GetUntracked() {
						b.load(true)
					}
				}, Disabled: b.busy.Get,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}},
			ui.Button{Text: apptext.T("查询"), TestID: "diag-log-search", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, Disabled: b.busy.Get, OnPress: func() { b.load(true) }},
			ui.Button{Text: apptext.T("刷新"), TestID: "diag-log-refresh", Variant: ui.ButtonGhost, Size: ui.SizeSmall, Disabled: b.busy.Get, OnPress: func() { b.load(true) }},
		}},
		core.Text{TestID: "diag-log-status", ContentFunc: func() string {
			if b.busy.Get() {
				return apptext.T("正在读取日志…")
			}
			r := b.result.Get()
			return apptext.T("共 %d 条匹配，已显示 %d 条", r.Total, len(r.Events))
		}, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
		core.Show{When: func() bool { return b.err.Get() != "" }, Then: func(cx *core.Scope) core.Node {
			return core.Text{TestID: "diag-log-error", ContentFunc: b.err.Get, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Danger)}
		}},
		core.Show{When: func() bool { return b.notice.Get() != "" }, Then: func(cx *core.Scope) core.Node {
			return core.Text{ContentFunc: b.notice.Get, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)}
		}},
		core.Show{When: func() bool { return b.result.Get().Ignored > 0 }, Then: func(cx *core.Scope) core.Node {
			return core.Text{ContentFunc: func() string {
				return apptext.T("已跳过 %d 条无法识别的记录，原文件保留。", b.result.Get().Ignored)
			},
				Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Warn)}
		}},
		core.List{TestID: "diag-log-list", Viewport: core.ListViewportParent, EstimatedSize: 58, Gap: 6,
			Count: func() int { return len(b.result.Get().Events) }, Key: func(i int) any { return b.result.Get().Events[i].ID },
			Empty: ui.Text(apptext.T("没有匹配的日志；可调整筛选条件或刷新。"), 11, ui.Regular, colors.Faint),
			Row: func(cx *core.Scope, row core.ListRow) core.Node {
				return core.Dynamic(func(cx *core.Scope) core.Node {
					events, i := b.result.Get().Events, row.Index()
					if i < 0 || i >= len(events) {
						return nil
					}
					return diagLogRow(cx, events[i])
				})
			}},
		core.Show{When: func() bool { return len(b.result.Get().Events) < b.result.Get().Total && b.limit < 1000 }, Then: func(cx *core.Scope) core.Node {
			return ui.Button{Text: apptext.T("加载更多"), TestID: "diag-log-more", Variant: ui.ButtonGhost, Size: ui.SizeSmall, Disabled: b.busy.Get,
				OnPress: func() { b.limit += 100; b.load(false) }}
		}},
		core.Show{When: func() bool { return b.limit >= 1000 && b.result.Get().Total > 1000 }, Then: func(cx *core.Scope) core.Node {
			return ui.Text(apptext.T("最多显示 1000 条，请缩小筛选范围。"), 11, ui.Regular, colors.Faint)
		}},
		core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: []core.Node{
			ui.Button{Text: apptext.T("清理筛选结果"), TestID: "diag-log-clear-filtered", Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				Disabled: func() bool { return b.busy.Get() || b.result.Get().Total == 0 }, OnPress: func() { b.clear(false) }},
			ui.Button{Text: apptext.T("清空全部日志"), TestID: "diag-log-clear-all", Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				Disabled: b.busy.Get, OnPress: func() { b.clear(true) }},
		}},
	}}
}

func diagLogRow(cx *core.Scope, ev diagEvent) core.Node {
	colors := ui.ColorsOf(cx)
	tone := colors.Muted
	if ev.Level == "error" || ev.Level == "exception" {
		tone = colors.Danger
	} else if ev.Level == "warn" {
		tone = colors.Warn
	}
	meta := fmt.Sprintf("%s · %s · %s", ev.Time.Local().Format("2006-01-02 15:04:05"), diagLevelLabel(ev.Level), diagCategoryLabel(ev.Category))
	if ev.Session != "" {
		meta += " · #" + ev.Session
	}
	return core.View{TestID: "diag-log-" + ev.ID, Style: core.Style{Gap: 2, Padding: core.Symmetric(5, 2)}, Children: []core.Node{
		core.Text{Content: meta, Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(tone)},
		core.Text{Content: ev.Text, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11, LineHeight: 16, FlexShrink: 1}, StyleFunc: ui.Colored(colors.Text)},
	}}
}

func diagCategoryLabel(category string) string {
	switch category {
	case "startup":
		return apptext.T("启动")
	case "acp":
		return "ACP"
	case "git":
		return "Git"
	case "session":
		return apptext.T("会话")
	case "notification":
		return apptext.T("通知")
	default:
		return apptext.T("应用")
	}
}

func diagLevelLabel(level string) string {
	switch level {
	case "warn":
		return apptext.T("提醒")
	case "error":
		return apptext.T("错误")
	case "exception":
		return apptext.T("异常")
	default:
		return apptext.T("普通")
	}
}
