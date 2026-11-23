//go:build !js && !android && !ios

package workbench

// What the review pane's buttons do: attach it to the project in front,
// post a comment, merge, close or reopen. Each asks before it writes,
// because every one of them is visible to everyone on GitHub.

import (
	"errors"
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

// openReviewPane shows the review pane for the active project.
func (a *app) openReviewPane() {
	if a.activeWorkspace() == nil {
		a.toast(ui.ToastInfo, apptext.T("先打开一个项目"), apptext.T("评审面板读的是项目所在的 GitHub 仓库。"))
		return
	}
	a.openPane(paneReview)
}

// reviewAttach points the pane at the active project.
func (a *app) reviewAttach() {
	ws := a.activeWorkspace()
	if a.review.attachedTo(ws) {
		return
	}
	a.review.attach(ws)
}

// commentOnReview posts the pane's comment box on the open item.
func (a *app) commentOnReview(text string) {
	if strings.TrimSpace(text) == "" {
		a.toast(ui.ToastInfo, apptext.T("还没有写评论"), "")
		return
	}
	a.review.comment(text)
}

// reviewMerge asks how to merge, then merges that way.
func (a *app) reviewMerge(item reviewItem, method string) {
	a.review.mergeOpen.Set(false)
	how := apptext.T("压缩合并")
	switch method {
	case "merge":
		how = apptext.T("合并提交")
	case "rebase":
		how = apptext.T("变基合并")
	}
	a.askConfirm(apptext.T("合并拉取请求"),
		fmt.Sprintf(apptext.T("「#%d %s」会以%s的方式合入目标分支，之后在 GitHub 上对所有人可见。分支不会被删除。"),
			item.Number, item.Title, how),
		apptext.T("合并"), func() { a.review.merge(method) })
}

// reviewVerdict submits a review verdict, with the comment box as the
// note that travels with it.
func (a *app) reviewVerdict(item reviewItem, verdict string) {
	const nl = "\n"
	a.review.reviewOpen.Set(false)
	body := strings.TrimSpace(a.review.commentText.GetUntracked())
	what, action := apptext.T("批准"), apptext.T("批准")
	switch verdict {
	case verdictRequestChanges:
		what, action = apptext.T("请求修改"), apptext.T("请求修改")
	case verdictComment:
		what, action = apptext.T("只留评论"), apptext.T("提交")
	}
	if body == "" && verdict != verdictApprove {
		a.toast(ui.ToastInfo, apptext.T("先在评论框里写说明"), apptext.T("这个评审结论要带一段说明。"))
		return
	}
	note := body
	if note == "" {
		note = apptext.T("（没有说明）")
	}
	a.askConfirm(apptext.T("提交评审"),
		fmt.Sprintf(apptext.T("「#%d %s」会带上这段说明提交为%s："+nl+nl+"%s"), item.Number, item.Title, what, note),
		action, func() { a.review.submitReview(verdict, body) })
}

// reviewChangeState closes or reopens the open item.
func (a *app) reviewChangeState(item reviewItem) {
	issue := item.Kind == reviewIssue
	closing := item.State == "OPEN"
	var title, action string
	switch {
	case issue && closing:
		title, action = apptext.T("关闭议题"), apptext.T("关闭")
	case issue:
		title, action = apptext.T("重新打开议题"), apptext.T("重新打开")
	case closing:
		title, action = apptext.T("关闭拉取请求"), apptext.T("关闭")
	default:
		title, action = apptext.T("重新打开拉取请求"), apptext.T("重新打开")
	}
	var body string
	if closing {
		body = fmt.Sprintf(apptext.T("「#%d %s」会关闭，之后仍可以在 GitHub 上重新打开。"), item.Number, item.Title)
	} else {
		body = fmt.Sprintf(apptext.T("「#%d %s」会重新打开。"), item.Number, item.Title)
	}
	a.askConfirm(title, body, action, func() {
		if closing {
			a.review.closeItemOnHost()
			return
		}
		a.review.reopenItemOnHost()
	})
}

// reviewReadPrompt is the text a new session starts with when the user
// hands it one item to evaluate: what to read, and what to answer with.
func reviewReadPrompt(item reviewItem, repo string) string {
	if item.Kind == reviewIssue {
		return fmt.Sprintf(apptext.T("请评估 %s 的议题 #%d「%s」。先读 gh issue view %d --json body,comments，再看议题提到的代码；用界面的语言回答，分四段：议题在说什么；能不能复现，给出调用路径或状态；改动建议具体到文件与函数；这个改动可能破坏什么、要补哪个测试。"),
			repo, item.Number, item.Title, item.Number)
	}
	return fmt.Sprintf(apptext.T("请评审 %s 的拉取请求 #%d「%s」。先读 gh pr view %d --json body,files,comments,reviews 和 gh pr diff %d，再看这些文件在仓库里的上下文；用界面的语言回答，分四段：这段改动在做什么；风险与遗漏，含边界、错误处理、并发与迁移；值得看的文件与行；能不能合并，需要修改就列出必改项。"),
		repo, item.Number, item.Title, item.Number, item.Number)
}

// evaluateReview starts a session that reads one item on a project and
// answers with an evaluation. The phone calls it through the same path the
// pane's button does.
func (a *app) evaluateReview(project string, d reviewDetail) (string, error) {
	ws := a.workspaceOf(project)
	if ws == nil {
		return "", errors.New("找不到这个项目")
	}
	s := a.newSession(ws.Path)
	if s == nil {
		return "", errors.New("没有新建会话")
	}
	repo := repoFromURL(d.Item.URL)
	if repo == "" {
		repo = ws.Name
	}
	s.draft.Set(reviewReadPrompt(d.Item, repo))
	a.sendDraft(s, "")
	return s.ID, nil
}

// evaluateReviewItem hands the open item to a new session.
func (a *app) evaluateReviewItem() {
	st := a.review.state.GetUntracked()
	if st.Detail == nil {
		return
	}
	ws := a.activeWorkspace()
	if ws == nil {
		a.toast(ui.ToastInfo, apptext.T("先打开一个项目"), apptext.T("会话要在项目的目录里跑，才能读到代码。"))
		return
	}
	if _, err := a.evaluateReview(ws.Path, *st.Detail); err != nil {
		a.toast(ui.ToastError, apptext.T("没能交给会话"), err.Error())
		return
	}
	a.toast(ui.ToastSuccess, apptext.T("已交给会话评估"), apptext.T("结论会出现在这条会话里；需要改代码可以接着说。"))
}
