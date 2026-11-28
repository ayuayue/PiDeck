//go:build !js && !android && !ios

package workbench

import (
	"strconv"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) enqueueVideo() {
	h := a.video
	if !h.ready.GetUntracked() {
		return
	}
	duration, err := strconv.Atoi(strings.TrimSpace(h.duration.GetUntracked()))
	if err != nil || duration < 1 || duration > 30 || strings.TrimSpace(h.provider.GetUntracked()) == "" || strings.TrimSpace(h.model.GetUntracked()) == "" || strings.TrimSpace(h.prompt.GetUntracked()) == "" || len(h.prompt.GetUntracked()) > 24<<10 {
		h.message.Set(apptext.T("请填写供应商、模型和画面描述，时长为 1–30 秒。"))
		return
	}
	list := h.jobs.GetUntracked()
	waiting := 0
	for _, j := range list {
		if j.State == "queued" || j.State == "running" {
			waiting++
		}
	}
	if waiting >= 8 || len(list) >= 200 {
		h.message.Set(apptext.T("视频任务已达上限，请先完成现有任务。"))
		return
	}
	session := ""
	if s := a.active(); s != nil {
		session = s.ID
	}
	j := videoJob{ID: strings.ReplaceAll(newSessionID(), "-", ""), Session: session, Provider: strings.TrimSpace(h.provider.GetUntracked()), Family: h.family.GetUntracked(),
		Model: strings.TrimSpace(h.model.GetUntracked()), Prompt: strings.TrimSpace(h.prompt.GetUntracked()), Resolution: h.resolution.GetUntracked(),
		Ratio: h.ratio.GetUntracked(), Duration: duration, State: "queued", Created: a.cx.Now()}
	h.message.Set("")
	a.updateVideo(j)
	h.prompt.Set("")
	a.nextVideo()
}

func (a *app) videoPane() core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		h := a.video
		colors := ui.ColorsOf(cx)
		field := func(label, id string, s *core.Signal[string], multi bool) core.Node {
			height := core.Points(32)
			if multi {
				height = 88
			}
			return core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text(apptext.T(label), 12, ui.Medium, colors.Muted),
				core.Input{Value: s.Get, OnChange: s.Set, Label: apptext.T(label), TestID: id, Multiline: multi,
					Style: panelFieldStyle(colors).Merge(core.Style{Height: core.Pt(height), Padding: core.All(8)})},
			}}
		}
		return core.View{Style: ui.FillRest, Children: []core.Node{
			a.paneHeader("视频生成", "串行任务队列；产物保存在本机，可预览并回到来源会话。"),
			core.Scroll{Style: ui.FillRest, Children: []core.Node{core.View{Style: core.Style{Gap: 12, Padding: core.Edges{Top: 14, Right: viewkit.PanelInset, Bottom: 14, Left: 4}}, Children: []core.Node{
				ui.Text(apptext.T("使用 models.json 中的供应商 ID，Base URL 填 TokenDance 网关根地址。生成会产生供应商费用。"), 11, ui.Regular, colors.Muted),
				field("供应商 ID", "video-provider", h.provider, false),
				ui.Select[string]{Label: apptext.T("视频协议"), TestID: "video-family", Value: h.family.Get, OnChange: h.family.Set,
					Options: []ui.Option[string]{{Value: "ark", Label: "Seedance / Ark"}, {Value: "minimax", Label: "MiniMax v2"}}},
				field("模型", "video-model", h.model, false), field("画面描述", "video-prompt", h.prompt, true),
				field("分辨率", "video-resolution", h.resolution, false), field("画面比例", "video-ratio", h.ratio, false), field("时长（秒）", "video-duration", h.duration, false),
				ui.Button{Text: apptext.T("加入生成队列"), Variant: ui.ButtonPrimary, TestID: "video-submit", Disabled: func() bool { return !h.ready.Get() }, OnPress: a.enqueueVideo},
				core.Text{ContentFunc: h.message.Get, MaxLines: 3, Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Danger)},
				core.Dynamic(func(cx *core.Scope) core.Node {
					list := h.jobs.Get()
					total := len(list)
					if len(list) > h.window.Get() {
						list = list[:h.window.Get()]
					}
					var rows []core.Node
					for _, j := range list {
						job := j
						rows = append(rows, a.videoJobRow(cx, job))
					}
					if total > len(list) {
						rows = append(rows, ui.Button{Text: apptext.T("加载更多"), TestID: "video-load-more", Size: ui.SizeSmall, Variant: ui.ButtonGhost, OnPress: func() { h.window.Update(func(n int) int { return n + 40 }) }})
					}
					if len(rows) == 0 {
						return ui.Text(apptext.T("还没有视频任务。"), 12, ui.Regular, colors.Faint)
					}
					return core.View{Style: core.Style{Gap: 8}, Children: rows}
				}),
			}}}},
		}}
	})
}

func (a *app) videoJobRow(cx *core.Scope, j videoJob) core.Node {
	colors := ui.ColorsOf(cx)
	var actions []core.Node
	if j.Stored {
		actions = append(actions, ui.Button{Text: apptext.T("预览"), Size: ui.SizeSmall, Variant: ui.ButtonSecondary, TestID: "video-preview-" + j.ID, OnPress: func() { a.openFilePreview(a.videoPath(j), previewVideo) }},
			ui.Button{Text: apptext.T("在系统应用中打开"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "video-open-" + j.ID, OnPress: func() { a.cx.OpenURL(fileURL(a.videoPath(j)), nil) }})
	}
	if j.State == "running" {
		actions = append(actions, ui.Button{Text: apptext.T("停止跟踪"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "video-stop-" + j.ID, OnPress: func() {
			if a.video.busy == j.ID && a.video.cancel != nil {
				a.video.cancel()
			}
		}})
	}
	if j.State == "queued" {
		actions = append(actions, ui.Button{Text: apptext.T("移出队列"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "video-dequeue-" + j.ID, OnPress: func() { j.State = "interrupted"; a.updateVideo(j) }})
	}
	if j.Task != "" && (j.State == "interrupted" || j.State == "failed") {
		actions = append(actions, ui.Button{Text: apptext.T("继续跟踪"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "video-resume-" + j.ID, OnPress: func() { a.resumeVideo(j) }})
	}
	if s := a.byID[j.Session]; s != nil {
		actions = append(actions, ui.Button{Text: apptext.T("来源会话"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "video-session-" + j.ID, OnPress: func() { a.selectSession(s) }})
	}
	if j.State != "running" && j.State != "queued" {
		actions = append(actions, ui.Button{Text: apptext.T("移除记录"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "video-remove-" + j.ID, OnPress: func() {
			a.askConfirm(apptext.T("移除视频记录？"), apptext.T("只移除任务记录，已下载的视频文件仍保留在本机。"), apptext.T("移除"), func() { a.removeVideoRecord(j.ID) })
		}})
	}
	return core.View{TestID: "video-job-" + j.ID, Style: core.Style{Gap: 6, Padding: core.Symmetric(10, 4), Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}, Children: []core.Node{
		ui.Text(j.Model+" · "+videoJobLabel(j), 12, ui.Medium, colors.Text),
		core.Text{Content: j.Prompt, MaxLines: 2, Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Muted)},
		core.Show{When: func() bool { return j.Error != "" }, Then: func(*core.Scope) core.Node { return ui.Text(j.Error, 11, ui.Regular, colors.Danger) }},
		core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: actions},
		core.Show{When: func() bool { return j.State == "interrupted" }, Then: func(*core.Scope) core.Node {
			return ui.Text(apptext.T("停止跟踪不会取消供应商端任务；继续跟踪不会重复提交。"), 11, ui.Regular, colors.Muted)
		}},
	}}
}
