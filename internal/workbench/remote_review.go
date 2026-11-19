//go:build !js && !android && !ios

package workbench

// The review pane's API for the phone and the browser: list, one item,
// a comment, a state change, and handing an item to a session. Every
// route names its project, so a request can only read the folder it asked
// for and gh runs there.

import (
	"net/http"
	"strconv"
	"strings"

	"example.com/pideck-lite/internal/remotewire"
)

// reviewWireItem is one row on the wire.
func reviewWireItem(item reviewItem) remotewire.ReviewItem {
	out := remotewire.ReviewItem{
		Kind: item.Kind, Number: item.Number, Title: item.Title, State: item.State, Draft: item.Draft,
		Author: item.Author, Branch: item.Branch, Base: item.Base, Review: item.Review, Checks: item.Checks,
		Adds: item.Adds, Deletes: item.Deletes, Labels: item.Labels, URL: item.URL, Reason: item.Reason,
	}
	if !item.Updated.IsZero() {
		out.Updated = item.Updated.UnixMilli()
	}
	return out
}

// reviewWireDetail is one item's page on the wire.
func reviewWireDetail(d *reviewDetail) remotewire.ReviewDetail {
	out := remotewire.ReviewDetail{Item: reviewWireItem(d.Item), Body: d.Body, Merge: d.Merge}
	for _, c := range d.Comments {
		out.Comments = append(out.Comments, remotewire.ReviewComment{Author: c.Author, Body: c.Body, Kind: c.Kind, State: c.State, At: c.At.UnixMilli()})
	}
	for _, c := range d.Checks {
		out.Checks = append(out.Checks, remotewire.ReviewCheck{Name: c.Name, State: c.State, URL: c.URL})
	}
	for _, f := range d.Files {
		out.Files = append(out.Files, remotewire.ReviewFile{Path: f.Path, Adds: f.Adds, Deletes: f.Deletes})
	}
	return out
}

// reviewProject resolves a request's project to a local folder. Only a
// folder the desktop already knows is accepted.
func (h *remoteHost) reviewProject(project string) (string, target, bool) {
	var path string
	var t target
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(project); ws != nil {
			path, t = ws.Path, ws.Target
		}
	})
	return path, t, ok
}

// handleReview lists a project's pull requests or issues.
func (h *remoteHost) handleReview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	query := r.URL.Query()
	kind := query.Get("kind")
	if kind != reviewIssue {
		kind = reviewPR
	}
	state := query.Get("state")
	switch state {
	case filterClosed, filterAll:
	default:
		state = filterOpen
	}
	limit, _ := strconv.Atoi(query.Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 40
	}
	path, t, ok := h.reviewProject(query.Get("project"))
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	st := readReview(t, path, kind, state, strings.TrimSpace(query.Get("q")), limit)
	out := remotewire.ReviewList{Missing: st.Missing, Error: st.Error}
	for _, item := range st.Items {
		out.Items = append(out.Items, reviewWireItem(item))
	}
	writeRemoteJSON(w, http.StatusOK, out)
}

// handleReviewDetail reads one pull request or issue.
func (h *remoteHost) handleReviewDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	item, path, t, ok := h.reviewTarget(w, r)
	if item == nil {
		return
	}
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	detail, err := readReviewDetail(t, path, *item)
	if err != nil {
		writeRemoteJSON(w, http.StatusBadGateway, map[string]string{"error": reviewErrorText(err)})
		return
	}
	writeRemoteJSON(w, http.StatusOK, reviewWireDetail(detail))
}

// reviewTarget reads the item a request names.
func (h *remoteHost) reviewTarget(w http.ResponseWriter, r *http.Request) (*reviewItem, string, target, bool) {
	query := r.URL.Query()
	number, err := strconv.Atoi(query.Get("number"))
	if err != nil || number <= 0 {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少编号"})
		return nil, "", target{}, false
	}
	kind := query.Get("kind")
	if kind != reviewIssue {
		kind = reviewPR
	}
	path, t, ok := h.reviewProject(query.Get("project"))
	item := reviewItem{Kind: kind, Number: number}
	return &item, path, t, ok
}

// reviewBody is the JSON a write names its item with.
type reviewBody struct {
	Project string `json:"project"`
	Kind    string `json:"kind"`
	Number  int    `json:"number"`
	Body    string `json:"body"`
	Method  string `json:"method"`
	Action  string `json:"action"`
}

// handleReviewAction posts a comment, merges, closes or reopens.
func (h *remoteHost) handleReviewAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var in reviewBody
	if err := decodeRemoteBody(r, &in); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if in.Number <= 0 {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少编号"})
		return
	}
	kind := reviewPR
	if in.Kind == reviewIssue {
		kind = reviewIssue
	}
	path, t, ok := h.reviewProject(in.Project)
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	if in.Action == reviewActComment && strings.TrimSpace(in.Body) == "" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "评论不能为空"})
		return
	}
	if in.Action == reviewActReview && in.Method != verdictApprove && strings.TrimSpace(in.Body) == "" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "这个评审结论要带一段说明"})
		return
	}
	if err := runReviewWrite(t, path, kind, in.Number, in.Action, in.Method, in.Body); err != nil {
		writeRemoteJSON(w, http.StatusBadGateway, map[string]string{"error": reviewErrorText(err)})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleReviewEvaluate hands an item to a session on the desktop.
func (h *remoteHost) handleReviewEvaluate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var in reviewBody
	if err := decodeRemoteBody(r, &in); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if in.Number <= 0 {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少编号"})
		return
	}
	kind := reviewPR
	if in.Kind == reviewIssue {
		kind = reviewIssue
	}
	path, t, ok := h.reviewProject(in.Project)
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	detail, err := readReviewDetail(t, path, reviewItem{Kind: kind, Number: in.Number})
	if err != nil {
		writeRemoteJSON(w, http.StatusBadGateway, map[string]string{"error": reviewErrorText(err)})
		return
	}
	var sessionID, failure string
	done := h.app.withUI(func() {
		id, err := h.app.evaluateReview(in.Project, *detail)
		if err != nil {
			failure = err.Error()
			return
		}
		sessionID = id
	})
	if !done {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if failure != "" {
		writeRemoteJSON(w, http.StatusConflict, remotewire.ReviewEvaluation{Error: failure})
		return
	}
	writeRemoteJSON(w, http.StatusOK, remotewire.ReviewEvaluation{Session: sessionID})
}

// handleReviewDiff reads a pull request's unified patch.
func (h *remoteHost) handleReviewDiff(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	item, path, t, ok := h.reviewTarget(w, r)
	if item == nil {
		return
	}
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	if item.Kind != reviewPR {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "只有拉取请求有补丁"})
		return
	}
	patch, err := readReviewPatch(t, path, item.Number)
	if err != nil {
		writeRemoteJSON(w, http.StatusBadGateway, map[string]string{"error": reviewErrorText(err)})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]string{"patch": patch})
}
