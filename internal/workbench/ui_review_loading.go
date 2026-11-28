//go:build !js && !android && !ios

package workbench

import (
	"reflect"
	"time"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// reviewContent changes pages only when navigation changes. Request status
// belongs to bindings inside the page, so a refresh cannot replace an editor.
func (a *app) reviewContent(cx *core.Scope) core.Node {
	type page struct{ view, open, kind, filter, query string }
	current := core.NewMemo(cx, func() page {
		return page{a.review.viewKey(), a.review.state.Get().Open,
			a.review.kind.Get(), a.review.filter.Get(), a.review.query.Get()}
	})
	return core.Dynamic(func(cx *core.Scope) core.Node {
		p := current.Get()
		var body core.Node
		if p.open != "" {
			cx.OnBackPress(func() bool { a.review.closeItem(); return true })
			body = a.reviewDetail(cx)
		} else {
			// Busy flags and detail responses do not recreate the list's scroll.
			list := core.NewMemoFunc(cx, func() reviewState {
				s := a.review.state.Get()
				st := reviewState{Items: s.Items, Limit: s.Limit, Missing: s.Missing, NeedsLogin: s.NeedsLogin}
				if len(s.Items) == 0 {
					st.Loading, st.Error = s.Loading, s.Error
				}
				return st
			}, func(a, b reviewState) bool { return reflect.DeepEqual(a, b) })
			body = a.reviewList(cx, list.Get)
		}
		return a.reviewTransition(cx, body, p.open != "")
	})
}

// One short transition marks navigation, with no stagger or delay on controls.
// Both the OS preference and the app's reduced-effects setting land at rest.
func (a *app) reviewTransition(cx *core.Scope, body core.Node, forward bool) core.Node {
	opacity, offset := core.NewAnimatedValue(cx, 1), core.NewAnimatedValue(cx, 0)
	if !core.Untracked(cx, func() bool { return a.reduceEffects.Get() || ui.ReduceMotion(cx) }) {
		distance := float64(8)
		if !forward {
			distance = -distance
		}
		opacity.Set(0.6)
		offset.Set(distance)
		timing := core.TimingConfig{Duration: 180 * time.Millisecond,
			Easing: core.BezierEasing(core.Curve{X1: 0.16, Y1: 1, X2: 0.3, Y2: 1})}
		cx.StartAnimation(core.Parallel(core.Timing(opacity, 1, timing), core.Timing(offset, 0, timing)), nil)
	}
	cx.Effect(func() {
		if a.reduceEffects.Get() || ui.ReduceMotion(cx) {
			opacity.Set(1)
			offset.Set(0)
		}
	})
	return core.View{TestID: "review-page-content", Style: core.Style{FlexGrow: 1, FlexShrink: 1,
		MinHeight: core.Pt(0), MinWidth: core.Pt(0), Animated: &core.AnimatedStyle{Opacity: opacity, TranslateX: offset}},
		Children: []core.Node{body}}
}

// reviewFeedback reserves one line, avoiding layout jumps as requests start
// and finish. Read and write failures remain visible beside a recovery action.
func (a *app) reviewFeedback(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{TestID: "review-feedback", Style: core.Style{MinHeight: core.Pt(26),
		Padding: core.Edges{Left: 20, Right: 20, Bottom: 4}}, Children: []core.Node{
		core.Dynamic(func(cx *core.Scope) core.Node {
			s := a.review.state.Get()
			text, icon, tint := "", lucide.Check, colors.Up
			var retry func()
			busy := s.Loading || s.DetailBusy || s.Writing
			switch {
			case s.Writing:
				text, tint = reviewActionLabel(s.WriteAction), colors.Muted
			case s.DetailError != "" && s.Detail != nil:
				text, icon, tint = s.DetailError, lucide.TriangleAlert, colors.Danger
				retry = a.review.refresh
			case s.Open == "" && len(s.Items) > 0 && s.Error != "":
				text, icon, tint = s.Error, lucide.TriangleAlert, colors.Danger
				retry = a.review.reload
			case (s.Loading || s.DetailBusy) && ((s.Open != "" && s.Detail != nil) || (s.Open == "" && len(s.Items) > 0)):
				text, tint = apptext.T("正在读取…"), colors.Muted
			case s.Open != "" && s.WriteOK != "":
				text = reviewSuccessLabel(s.WriteOK)
			}
			if text == "" {
				return nil
			}
			var mark core.Node = ui.Icon(icon, 12, tint)
			if busy && retry == nil {
				mark = ui.Spinner{Size: 12, Label: text}
			}
			children := []core.Node{mark,
				core.Text{Content: text, MaxLines: 2, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11, LineHeight: 16},
					StyleFunc: ui.Colored(tint)},
			}
			if retry != nil {
				children = append(children, ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					Disabled: func() bool { st := a.review.state.Get(); return st.Loading || st.DetailBusy }, OnPress: retry})
			}
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: children}
		}),
	}}
}

func reviewActionLabel(action string) string {
	switch action {
	case reviewActComment:
		return apptext.T("发表评论")
	case reviewActMerge:
		return apptext.T("合并")
	case reviewActReview:
		return apptext.T("提交评审")
	case reviewActClose:
		return apptext.T("关闭")
	default:
		return apptext.T("重新打开")
	}
}

func reviewSuccessLabel(action string) string {
	switch action {
	case "merge":
		return apptext.T("已合并")
	case "close":
		return apptext.T("已关闭")
	case "reopen":
		return apptext.T("已重新打开")
	default:
		return apptext.T("已提交")
	}
}

// reviewLoading keeps the list's shape during a first read or a new filter.
func reviewLoading(cx *core.Scope, label, id string) core.Node {
	colors := ui.ColorsOf(cx)
	rows := make([]core.Node, 0, 5)
	for _, width := range []float32{64, 82, 54, 72, 60} {
		rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter,
			Gap: 10, Padding: core.Symmetric(12, 8)}, Children: []core.Node{
			core.View{StyleFunc: func() core.Style {
				return core.Style{Width: core.Pt(14), Height: core.Pt(14), CornerRadius: 4, Background: colors.Inset()}
			}},
			core.View{Style: core.Style{FlexGrow: 1, Gap: 7}, Children: []core.Node{
				core.View{StyleFunc: func() core.Style {
					return core.Style{Height: core.Pt(12), Width: core.Pct(width), CornerRadius: 4, Background: colors.Inset()}
				}},
				core.View{StyleFunc: func() core.Style {
					return core.Style{Height: core.Pt(8), Width: core.Pct(width / 2), CornerRadius: 3, Background: colors.Inset()}
				}},
			}},
		}})
	}
	return core.View{TestID: id, Label: label, Style: core.Style{FlexGrow: 1, Gap: 8, Padding: core.Symmetric(12, 20)},
		Children: append([]core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(4, 8)},
				Children: []core.Node{ui.Spinner{Size: 14, Label: label}, ui.Text(label, 12, ui.Regular, colors.Muted)}},
		}, rows...)}
}
