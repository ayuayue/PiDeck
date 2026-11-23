//go:build !js && !android && !ios

package workbench

// What the review pane shows: pull requests and issues as the GitHub CLI
// prints them, folded into the shapes the views read. gh's fields differ
// between versions and repositories, so decoding is tolerant: a field the
// command did not print is a zero value, never an error.

import (
	"encoding/json"
	"time"
)

// The two things the pane lists.
const (
	reviewPR    = "pr"
	reviewIssue = "issue"
)

// The states the pane can ask for.
const (
	filterOpen   = "open"
	filterClosed = "closed"
	filterAll    = "all"
)

// The checks' one-word summary a row shows.
const (
	checksPass    = "pass"
	checksFail    = "fail"
	checksPending = "pending"
)

// reviewItem is one row: a pull request or an issue.
type reviewItem struct {
	Kind    string
	Number  int
	Title   string
	State   string
	Draft   bool
	Author  string
	Updated time.Time
	Branch  string
	Base    string
	Review  string
	Checks  string
	Adds    int
	Deletes int
	Labels  []string
	URL     string
	Reason  string
}

// reviewComment is one entry of the detail's conversation: a comment or a
// review with a body.
type reviewComment struct {
	Author string
	Body   string
	At     time.Time
	Kind   string
	State  string
}

// reviewFile is one changed path in a pull request.
type reviewFile struct {
	Path    string
	Adds    int
	Deletes int
}

// reviewCheck is one check run or status context.
type reviewCheck struct {
	Name   string
	State  string
	URL    string
	Detail string
}

// reviewDetail is what one pull request or issue says.
type reviewDetail struct {
	Item     reviewItem
	Body     string
	Merge    string
	Reason   string
	Comments []reviewComment
	Files    []reviewFile
	Checks   []reviewCheck
}

// reviewState is the pane's whole read: the list, the open item, and the
// word on the last write.
type reviewState struct {
	Checked bool
	Loading bool
	// Missing says the machine has no GitHub CLI, NeedsLogin that it has one
	// with no account: either way nothing can be read until that is fixed.
	Missing    bool
	NeedsLogin bool
	Error      string
	Repo       string
	Items      []reviewItem
	Limit      int

	Open        string
	Detail      *reviewDetail
	DetailBusy  bool
	DetailError string

	Writing bool
	WriteOK string

	// Patch is the open pull request's unified diff.
	Patch     string
	PatchBusy bool
}

// ghUser is gh's author object.
type ghUser struct {
	Login string `json:"login"`
	Name  string `json:"name"`
}

// ghLabel is one label.
type ghLabel struct {
	Name string `json:"name"`
}

// ghCheck is one entry of statusCheckRollup: a CheckRun or a StatusContext.
type ghCheck struct {
	Type       string `json:"__typename"`
	Name       string `json:"name"`
	Context    string `json:"context"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	State      string `json:"state"`
	Detail     string `json:"detailsUrl"`
}

// ghComment is one comment.
type ghComment struct {
	Author    ghUser    `json:"author"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"createdAt"`
}

// ghReview is one review with its verdict.
type ghReview struct {
	Author      ghUser    `json:"author"`
	Body        string    `json:"body"`
	State       string    `json:"state"`
	SubmittedAt time.Time `json:"submittedAt"`
}

// ghFile is one changed path.
type ghFile struct {
	Path      string `json:"path"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

// ghPull is what `gh pr list` and `gh pr view --json` give.
type ghPull struct {
	Number            int         `json:"number"`
	Title             string      `json:"title"`
	State             string      `json:"state"`
	IsDraft           bool        `json:"isDraft"`
	Author            ghUser      `json:"author"`
	UpdatedAt         time.Time   `json:"updatedAt"`
	HeadRefName       string      `json:"headRefName"`
	BaseRefName       string      `json:"baseRefName"`
	ReviewDecision    string      `json:"reviewDecision"`
	Mergeable         string      `json:"mergeable"`
	MergeStateStatus  string      `json:"mergeStateStatus"`
	Additions         int         `json:"additions"`
	Deletions         int         `json:"deletions"`
	URL               string      `json:"url"`
	Body              string      `json:"body"`
	Labels            []ghLabel   `json:"labels"`
	StatusCheckRollup []ghCheck   `json:"statusCheckRollup"`
	Comments          []ghComment `json:"comments"`
	Reviews           []ghReview  `json:"reviews"`
	Files             []ghFile    `json:"files"`
}

// ghIssue is what `gh issue list` and `gh issue view --json` give.
type ghIssue struct {
	Number      int         `json:"number"`
	Title       string      `json:"title"`
	State       string      `json:"state"`
	StateReason string      `json:"stateReason"`
	Author      ghUser      `json:"author"`
	UpdatedAt   time.Time   `json:"updatedAt"`
	URL         string      `json:"url"`
	Body        string      `json:"body"`
	Labels      []ghLabel   `json:"labels"`
	Comments    []ghComment `json:"comments"`
}

// ghRollup reduces the check array to the row's one word.
func ghRollup(checks []ghCheck) string {
	if len(checks) == 0 {
		return ""
	}
	pending := false
	for _, c := range checks {
		conclusion := c.Conclusion
		state := c.State
		switch conclusion {
		case "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE":
			return checksFail
		}
		switch state {
		case "FAILURE", "ERROR":
			return checksFail
		case "PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING":
			pending = true
		}
		if c.Status != "" && c.Status != "COMPLETED" {
			pending = true
		}
	}
	if pending {
		return checksPending
	}
	return checksPass
}

// ghCheckName is a check's name, whichever kind it is.
func ghCheckName(c ghCheck) string {
	if c.Name != "" {
		return c.Name
	}
	return c.Context
}

// ghCheckState is a check's one word for the detail's list.
func ghCheckState(c ghCheck) string {
	switch c.Conclusion {
	case "SUCCESS":
		return checksPass
	case "NEUTRAL", "SKIPPED":
		return checksPass
	case "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE":
		return checksFail
	case "":
	default:
		return checksFail
	}
	switch c.State {
	case "SUCCESS":
		return checksPass
	case "PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS":
		return checksPending
	case "FAILURE", "ERROR":
		return checksFail
	}
	if c.Status != "" && c.Status != "COMPLETED" {
		return checksPending
	}
	return checksPending
}

// reviewLabels keeps the names the row shows.
func reviewLabels(labels []ghLabel) []string {
	out := make([]string, 0, len(labels))
	for _, l := range labels {
		if l.Name != "" {
			out = append(out, l.Name)
		}
	}
	return out
}

// prItems folds a pull request list into rows.
func prItems(pulls []ghPull) []reviewItem {
	out := make([]reviewItem, 0, len(pulls))
	for _, p := range pulls {
		out = append(out, pullItem(p))
	}
	return out
}

// pullItem is one pull request as a row.
func pullItem(p ghPull) reviewItem {
	return reviewItem{
		Kind: reviewPR, Number: p.Number, Title: p.Title, State: p.State, Draft: p.IsDraft,
		Author: p.Author.Login, Updated: p.UpdatedAt, Branch: p.HeadRefName, Base: p.BaseRefName,
		Review: p.ReviewDecision, Checks: ghRollup(p.StatusCheckRollup),
		Adds: p.Additions, Deletes: p.Deletions, Labels: reviewLabels(p.Labels), URL: p.URL,
	}
}

// issueItems folds an issue list into rows.
func issueItems(issues []ghIssue) []reviewItem {
	out := make([]reviewItem, 0, len(issues))
	for _, is := range issues {
		out = append(out, reviewItem{
			Kind: reviewIssue, Number: is.Number, Title: is.Title, State: is.State,
			Author: is.Author.Login, Updated: is.UpdatedAt, Labels: reviewLabels(is.Labels),
			URL: is.URL, Reason: is.StateReason,
		})
	}
	return out
}

// pullDetail is one pull request's conversation, checks and files.
func pullDetail(p ghPull) *reviewDetail {
	comments := make([]reviewComment, 0, len(p.Comments)+len(p.Reviews))
	for _, c := range p.Comments {
		comments = append(comments, reviewComment{Author: c.Author.Login, Body: c.Body, At: c.CreatedAt, Kind: "comment"})
	}
	for _, r := range p.Reviews {
		if r.Body == "" && r.State != "CHANGES_REQUESTED" {
			continue
		}
		comments = append(comments, reviewComment{Author: r.Author.Login, Body: r.Body, At: r.SubmittedAt, Kind: "review", State: r.State})
	}
	sortComments(comments)
	checks := make([]reviewCheck, 0, len(p.StatusCheckRollup))
	for _, c := range p.StatusCheckRollup {
		checks = append(checks, reviewCheck{Name: ghCheckName(c), State: ghCheckState(c), URL: c.Detail})
	}
	files := make([]reviewFile, 0, len(p.Files))
	for _, f := range p.Files {
		files = append(files, reviewFile{Path: f.Path, Adds: f.Additions, Deletes: f.Deletions})
	}
	merge := p.MergeStateStatus
	if merge == "" {
		merge = p.Mergeable
	}
	return &reviewDetail{Item: pullItem(p), Body: p.Body, Merge: merge, Comments: comments, Files: files, Checks: checks}
}

// issueDetail is one issue's conversation.
func issueDetail(is ghIssue) *reviewDetail {
	comments := make([]reviewComment, 0, len(is.Comments))
	for _, c := range is.Comments {
		comments = append(comments, reviewComment{Author: c.Author.Login, Body: c.Body, At: c.CreatedAt, Kind: "comment"})
	}
	sortComments(comments)
	return &reviewDetail{Item: reviewItem{
		Kind: reviewIssue, Number: is.Number, Title: is.Title, State: is.State, Author: is.Author.Login,
		Updated: is.UpdatedAt, Labels: reviewLabels(is.Labels), URL: is.URL, Reason: is.StateReason,
	}, Body: is.Body, Comments: comments}
}

// sortComments puts the conversation in the order it happened.
func sortComments(comments []reviewComment) {
	for i := 1; i < len(comments); i++ {
		for j := i; j > 0 && comments[j].At.Before(comments[j-1].At); j-- {
			comments[j], comments[j-1] = comments[j-1], comments[j]
		}
	}
}

// decodeGH reads one gh JSON document into out.
func decodeGH(doc []byte, out any) error {
	return json.Unmarshal(doc, out)
}
