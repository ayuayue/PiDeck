//go:build !js && !android && !ios

package workbench

// The review pane's reads: the list of pull requests or issues, one item's
// conversation, and the writes that come back with a fresh list. Every
// command runs off the UI thread and returns through the scope, as the Git
// drawer does.

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nsgo-dev/nsgo/core"
)

// review is the pane's state: the project it reads, what it lists, and
// which item is open.
type review struct {
	cx *core.Scope

	mu     sync.Mutex
	path   string
	target target

	state       *core.Signal[reviewState]
	kind        *core.Signal[string]
	filter      *core.Signal[string]
	query       *core.Signal[string]
	search      *core.Signal[string]
	commentText *core.Signal[string]
	mergeOpen   *core.Signal[bool]
	reviewOpen  *core.Signal[bool]
	patchOpen   *core.Signal[bool]

	seq       int
	detailSeq int
	working   bool
	pending   bool
	limit     int
}

// thePullFields is what a list needs, and no comment bodies: a repository
// with a hundred comments per pull request would send them all.
const thePullFields = "number,title,state,isDraft,author,updatedAt,headRefName,baseRefName,reviewDecision,statusCheckRollup,additions,deletions,labels,url"

// theIssueFields is the same for an issue.
const theIssueFields = "number,title,state,stateReason,author,updatedAt,labels,url"

// thePullDetailFields adds the conversation, the checks and the files.
const thePullDetailFields = thePullFields + ",body,mergeable,mergeStateStatus,comments,reviews,files"

// theIssueDetailFields adds the conversation.
const theIssueDetailFields = theIssueFields + ",body,comments"

// newReview builds the pane's state.
func newReview(cx *core.Scope) *review {
	return &review{
		cx:          cx,
		state:       core.NewSignalFunc(cx, reviewState{}, nil),
		kind:        core.NewSignal(cx, reviewPR),
		filter:      core.NewSignal(cx, filterOpen),
		query:       core.NewSignal(cx, ""),
		search:      core.NewSignal(cx, ""),
		commentText: core.NewSignal(cx, ""),
		mergeOpen:   core.NewSignal(cx, false),
		reviewOpen:  core.NewSignal(cx, false),
		patchOpen:   core.NewSignal(cx, false),
		limit:       40,
	}
}

// attachedTo reports whether the pane already reads that workspace.
func (r *review) attachedTo(ws *workspace) bool {
	path, t := "", localTarget
	if ws != nil {
		path, t = ws.Path, ws.Target
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return path == r.path && t.key() == r.target.key()
}

// repo is the project commands run in.
func (r *review) repo() (target, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.target, r.path
}

// attach points the pane at a workspace, if it is another one, and reads
// its repository's pull requests.
func (r *review) attach(ws *workspace) bool {
	path, t := "", localTarget
	if ws != nil {
		path, t = ws.Path, ws.Target
	}
	r.mu.Lock()
	same := path == r.path && t.key() == r.target.key()
	if !same {
		r.path, r.target = path, t
	}
	r.mu.Unlock()
	if same {
		return false
	}
	r.seq++
	r.detailSeq++
	r.working, r.pending = false, false
	r.limit = 40
	r.kind.Set(reviewPR)
	r.filter.Set(filterOpen)
	r.query.Set("")
	if path == "" {
		r.state.Set(reviewState{Checked: true})
		return true
	}
	r.state.Set(reviewState{Loading: true, Limit: r.limit})
	r.reload()
	return true
}

// reload rereads the list in the pane's own kind and filter.
func (r *review) reload() {
	t, path := r.repo()
	if path == "" {
		return
	}
	if r.working {
		r.pending = true
		return
	}
	r.working = true
	kind, filter, query, limit := r.kind.GetUntracked(), r.filter.GetUntracked(), strings.TrimSpace(r.query.GetUntracked()), r.limit
	r.state.Update(func(s reviewState) reviewState { s.Loading = true; s.Limit = limit; return s })
	seq := r.seq
	go func() {
		st := readReview(t, path, kind, filter, query, limit)
		r.cx.Post(func() {
			if seq != r.seq {
				return
			}
			r.working = false
			if st.Detail == nil {
				// A reload keeps the open item's conversation.
				old := r.state.GetUntracked()
				st.Detail, st.Open = old.Detail, old.Open
			}
			r.state.Set(st)
			if r.pending {
				r.pending = false
				r.reload()
			}
		})
	}()
}

// loadMore asks for another page of rows.
func (r *review) loadMore() {
	if r.limit >= 200 {
		return
	}
	r.limit += 40
	r.reload()
}

// openItem reads one pull request or issue.
func (r *review) openItem(item reviewItem) {
	t, path := r.repo()
	if path == "" {
		return
	}
	r.detailSeq++
	seq := r.detailSeq
	key := reviewKey(item)
	r.state.Update(func(s reviewState) reviewState {
		s.Open, s.DetailError, s.WriteOK = key, "", ""
		if s.Detail == nil || reviewKey(s.Detail.Item) != key {
			s.Detail = nil
		}
		s.DetailBusy = true
		return s
	})
	go func() {
		detail, err := readReviewDetail(t, path, item)
		r.cx.Post(func() {
			if seq != r.detailSeq {
				return
			}
			r.state.Update(func(s reviewState) reviewState {
				s.DetailBusy = false
				if err != nil {
					s.DetailError = reviewErrorText(err)
					return s
				}
				s.Detail = detail
				return s
			})
		})
	}()
}

// closeItem puts the list back.
func (r *review) closeItem() {
	r.detailSeq++
	r.state.Update(func(s reviewState) reviewState {
		s.Open, s.Detail, s.DetailError, s.DetailBusy = "", nil, "", false
		return s
	})
}

// reopenItem reads a last write into the open item, after a list reload.
func (r *review) reopenItem() {
	s := r.state.GetUntracked()
	if s.Detail == nil {
		return
	}
	r.openItem(s.Detail.Item)
}

// setKind switches between pull requests and issues and rereads.
func (r *review) setKind(kind string) {
	if kind == "" || r.kind.GetUntracked() == kind {
		return
	}
	r.kind.Set(kind)
	r.closeItem()
	r.limit = 40
	r.reload()
}

// setFilter switches the state filter and rereads.
func (r *review) setFilter(filter string) {
	if filter == "" || r.filter.GetUntracked() == filter {
		return
	}
	r.filter.Set(filter)
	r.limit = 40
	r.reload()
}

// setQuery rereads with the search text.
func (r *review) setQuery(query string) {
	if r.query.GetUntracked() == query {
		return
	}
	r.query.Set(query)
	r.limit = 40
	r.reload()
}

// write runs one gh write against the open item, then rereads both the
// item and the list so the row the user sees is the one GitHub has.
func (r *review) write(label, action, method, body string) {
	s := r.state.GetUntracked()
	if s.Detail == nil || s.Writing {
		return
	}
	t, path := r.repo()
	if path == "" {
		return
	}
	item := s.Detail.Item
	r.state.Update(func(st reviewState) reviewState { st.Writing, st.WriteOK, st.DetailError = true, "", ""; return st })
	seq := r.seq
	go func() {
		err := runReviewWrite(t, path, item.Kind, item.Number, action, method, body)
		r.cx.Post(func() {
			r.state.Update(func(st reviewState) reviewState {
				st.Writing = false
				if err != nil {
					st.DetailError = reviewErrorText(err)
					return st
				}
				st.WriteOK = label
				return st
			})
			if err != nil {
				return
			}
			if seq == r.seq {
				r.reload()
				r.reopenItem()
			}
		})
	}()
}

// comment posts the pane's comment box on the open item.
func (r *review) comment(body string) {
	r.write("comment", reviewActComment, "", body)
}

// merge merges an open pull request with one method.
func (r *review) merge(method string) {
	r.write("merge", reviewActMerge, method, "")
}

// submitReview posts a verdict, with the comment box as its note.
func (r *review) submitReview(verdict, body string) {
	r.write("review", reviewActReview, verdict, body)
}

// closeItemOnHost closes the open pull request or issue.
func (r *review) closeItemOnHost() {
	r.write("close", reviewActClose, "", "")
}

// reopenItemOnHost reopens the open pull request or issue.
func (r *review) reopenItemOnHost() {
	r.write("reopen", reviewActReopen, "", "")
}

// poll rereads the rows, and the open item with them, while the pane is
// in front. It shows no spinner: a refresh nobody asked for should not
// look like work.
func (r *review) poll() {
	t, path := r.repo()
	if path == "" || r.working || r.state.GetUntracked().Writing {
		return
	}
	kind, filter, query, limit := r.kind.GetUntracked(), r.filter.GetUntracked(), strings.TrimSpace(r.query.GetUntracked()), r.limit
	seq := r.seq
	cur := r.state.GetUntracked()
	open, busy := cur.Detail, cur.DetailBusy
	item := reviewItem{}
	if open != nil && !busy {
		item = open.Item
	}
	r.working = true
	go func() {
		st := readReview(t, path, kind, filter, query, limit)
		r.cx.Post(func() {
			if seq != r.seq {
				return
			}
			r.working = false
			old := r.state.GetUntracked()
			if st.Error != "" && st.Missing {
				// gh went away: say so rather than keep stale rows.
				r.state.Set(st)
				return
			}
			if st.Error != "" {
				// A poll's failure leaves what the user is reading alone.
				st = old
				st.Error = ""
			}
			st.Checked, st.Loading, st.Limit = true, false, limit
			st.Detail, st.Open = old.Detail, old.Open
			r.state.Set(st)
			if item.Number > 0 {
				r.refreshDetailQuiet(item)
			}
		})
	}()
}

// refreshDetailQuiet rereads the open item without the spinner.
func (r *review) refreshDetailQuiet(item reviewItem) {
	t, path := r.repo()
	if path == "" || r.state.GetUntracked().DetailBusy {
		// A read already in flight owns the detail; it will publish.
		return
	}
	r.detailSeq++
	seq := r.detailSeq
	key := reviewKey(item)
	go func() {
		detail, err := readReviewDetail(t, path, item)
		r.cx.Post(func() {
			if seq != r.detailSeq || err != nil {
				return
			}
			r.state.Update(func(st reviewState) reviewState {
				if st.Open != key {
					return st
				}
				st.Detail = detail
				st.DetailError = ""
				return st
			})
		})
	}()
}

// readReview runs the list command and folds its answer.
func readReview(t target, dir, kind, filter, query string, limit int) reviewState {
	if limit <= 0 {
		limit = 40
	}
	state := reviewState{Checked: true, Limit: limit}
	args := []string{kind, "list", "--state", filter, "--limit", strconv.Itoa(limit)}
	if query != "" {
		args = append(args, "--search", query)
	}
	fields := thePullFields
	if kind == reviewIssue {
		fields = theIssueFields
	}
	doc, err := ghJSON(t, dir, 60*time.Second, append(args, "--json", fields)...)
	if err != nil {
		return reviewMissing(state, err)
	}
	if kind == reviewIssue {
		var issues []ghIssue
		if err := decodeGH(doc, &issues); err != nil {
			state.Error = "无法解析 GitHub 的返回：" + err.Error()
			return state
		}
		state.Items = issueItems(issues)
		return state
	}
	var pulls []ghPull
	if err := decodeGH(doc, &pulls); err != nil {
		state.Error = "无法解析 GitHub 的返回：" + err.Error()
		return state
	}
	state.Items = prItems(pulls)
	return state
}

// readReviewDetail runs the item's command and folds its answer.
func readReviewDetail(t target, dir string, item reviewItem) (*reviewDetail, error) {
	fields := thePullDetailFields
	if item.Kind == reviewIssue {
		fields = theIssueDetailFields
	}
	doc, err := ghJSON(t, dir, 60*time.Second, item.Kind, "view", strconv.Itoa(item.Number), "--json", fields)
	if err != nil {
		return nil, err
	}
	if item.Kind == reviewIssue {
		var issue ghIssue
		if err := decodeGH(doc, &issue); err != nil {
			return nil, errors.New("无法解析 GitHub 的返回：" + err.Error())
		}
		return issueDetail(issue), nil
	}
	var pull ghPull
	if err := decodeGH(doc, &pull); err != nil {
		return nil, errors.New("无法解析 GitHub 的返回：" + err.Error())
	}
	return pullDetail(pull), nil
}

// loadPatch reads the open pull request's diff for the pane's dialog.
func (r *review) loadPatch() {
	s := r.state.GetUntracked()
	if s.Detail == nil || s.Detail.Item.Kind != reviewPR || s.PatchBusy {
		return
	}
	t, path := r.repo()
	if path == "" {
		return
	}
	number, seq := s.Detail.Item.Number, r.seq
	r.state.Update(func(st reviewState) reviewState { st.PatchBusy, st.Patch = true, ""; return st })
	go func() {
		patch, err := readReviewPatch(t, path, number)
		r.cx.Post(func() {
			if seq != r.seq {
				return
			}
			r.state.Update(func(st reviewState) reviewState {
				st.PatchBusy = false
				if err != nil {
					st.Patch = "无法读取补丁：" + reviewErrorText(err)
					return st
				}
				st.Patch = patch
				return st
			})
		})
	}()
}

// readReviewPatch is one pull request's unified diff, as gh prints it.
func readReviewPatch(t target, dir string, number int) (string, error) {
	out, stderr, code, err := ghRun(t, dir, 120*time.Second, "pr", "diff", strconv.Itoa(number))
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", errors.New(ghMessage(stderr, code))
	}
	return out, nil
}

// reviewMissing marks a state that could not run gh at all.
func reviewMissing(state reviewState, err error) reviewState {
	if errors.Is(err, errNoGH) {
		state.Missing = true
		state.Error = ""
		return state
	}
	state.Error = reviewErrorText(err)
	return state
}

// reviewErrorText is a command's failure as one line.
func reviewErrorText(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, errNoGH) {
		return "这台机器上没有 GitHub CLI"
	}
	return err.Error()
}

// reviewKey names one item for the open state.
func reviewKey(item reviewItem) string {
	return fmt.Sprintf("%s#%d", item.Kind, item.Number)
}

// repoFromURL is the owner and repository a page URL names, for a prompt
// that must say which repository it is about.
func repoFromURL(url string) string {
	rest := url
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	parts := strings.Split(rest, "/")
	if len(parts) < 3 {
		return ""
	}
	return parts[1] + "/" + parts[2]
}
