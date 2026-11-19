//go:build !js && !android && !ios

package workbench

// The review pane's reads decode what gh prints, so these tests feed the
// shapes GitHub sends and check the pane's own words: the checks summary,
// the conversation order and the merge state. Nothing here reaches the
// network or needs a login.

import (
	"encoding/json"
	"testing"
	"time"
)

const prListJSON = `[
 {"number":8,"title":"Fix CI bot PRs","state":"MERGED","isDraft":false,
  "author":{"login":"ayuayue","name":"caoayu"},"updatedAt":"2026-11-17T06:33:00Z",
  "headRefName":"fix/ci-bot-prs","baseRefName":"main","reviewDecision":"APPROVED",
  "additions":151,"deletions":115,"url":"https://github.com/ayuayue/PiDeck-Lite/pull/8",
  "labels":[{"name":"ci"},{"name":""}],
  "statusCheckRollup":[
    {"__typename":"CheckRun","name":"test (ubuntu-latest)","status":"COMPLETED","conclusion":"SUCCESS"},
    {"__typename":"StatusContext","context":"buildkite","state":"SUCCESS"}]},
 {"number":9,"title":"A failing one","state":"OPEN","isDraft":true,
  "author":{"login":"someone"},"updatedAt":"2026-11-18T01:00:00Z",
  "headRefName":"wip","baseRefName":"main","reviewDecision":"",
  "statusCheckRollup":[
    {"__typename":"CheckRun","name":"ci","status":"COMPLETED","conclusion":"FAILURE"},
    {"__typename":"CheckRun","name":"slow","status":"IN_PROGRESS"}]},
 {"number":10,"title":"Pending","state":"OPEN",
  "author":{"login":"someone"},"updatedAt":"2026-11-18T01:00:00Z",
  "statusCheckRollup":[{"__typename":"CheckRun","name":"ci","status":"IN_PROGRESS"}]},
 {"number":11,"title":"No checks","state":"CLOSED"}
]`

func TestDecodeReviewList(t *testing.T) {
	var pulls []ghPull
	if err := json.Unmarshal([]byte(prListJSON), &pulls); err != nil {
		t.Fatalf("decode: %v", err)
	}
	items := prItems(pulls)
	if len(items) != 4 {
		t.Fatalf("items = %d, want 4", len(items))
	}
	first := items[0]
	if first.Kind != reviewPR || first.Number != 8 || first.State != "MERGED" || first.Author != "ayuayue" {
		t.Fatalf("first = %+v", first)
	}
	if first.Checks != checksPass {
		t.Errorf("merged row checks = %q, want %q", first.Checks, checksPass)
	}
	if len(first.Labels) != 1 || first.Labels[0] != "ci" {
		t.Errorf("labels = %v, want the one named label", first.Labels)
	}
	if first.Adds != 151 || first.Deletes != 115 {
		t.Errorf("lines = +%d -%d, want +151 -115", first.Adds, first.Deletes)
	}
	if !first.Updated.Equal(time.Date(2026, 11, 17, 6, 33, 0, 0, time.UTC)) {
		t.Errorf("updated = %v", first.Updated)
	}
	if items[1].Checks != checksFail {
		t.Errorf("failing row checks = %q", items[1].Checks)
	}
	if items[2].Checks != checksPending {
		t.Errorf("running row checks = %q", items[2].Checks)
	}
	if items[3].Checks != "" {
		t.Errorf("row without checks = %q, want empty", items[3].Checks)
	}
	if !items[1].Draft {
		t.Error("draft row lost its draft mark")
	}
}

func TestRollupAndCheckState(t *testing.T) {
	cases := []struct {
		name   string
		checks []ghCheck
		want   string
	}{
		{"none", nil, ""},
		{"all pass", []ghCheck{{Status: "COMPLETED", Conclusion: "SUCCESS"}}, checksPass},
		{"skipped counts as pass", []ghCheck{{Status: "COMPLETED", Conclusion: "SKIPPED"}}, checksPass},
		{"one failure wins", []ghCheck{{Status: "COMPLETED", Conclusion: "SUCCESS"}, {Status: "COMPLETED", Conclusion: "FAILURE"}}, checksFail},
		{"running is pending", []ghCheck{{Status: "IN_PROGRESS"}}, checksPending},
		{"status context failure", []ghCheck{{State: "FAILURE"}}, checksFail},
		{"status context pending", []ghCheck{{State: "PENDING"}}, checksPending},
		{"action required", []ghCheck{{Status: "COMPLETED", Conclusion: "ACTION_REQUIRED"}}, checksFail},
	}
	for _, c := range cases {
		if got := ghRollup(c.checks); got != c.want {
			t.Errorf("%s: ghRollup = %q, want %q", c.name, got, c.want)
		}
	}
	check := ghCheck{Status: "COMPLETED", Conclusion: "SUCCESS"}
	if got := ghCheckState(check); got != checksPass {
		t.Errorf("ghCheckState(success) = %q", got)
	}
	named := ghCheck{Context: "buildkite"}
	if ghCheckName(named) != "buildkite" {
		t.Errorf("ghCheckName(context) = %q", ghCheckName(named))
	}
}

const prDetailJSON = `{
 "number":9,"title":"A failing one","state":"OPEN","isDraft":false,
 "author":{"login":"someone"},"updatedAt":"2026-11-18T01:00:00Z",
 "headRefName":"wip","baseRefName":"main","reviewDecision":"CHANGES_REQUESTED",
 "mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","url":"https://github.com/o/r/pull/9",
 "body":"## What\nAdds a thing.","additions":3,"deletions":1,
 "comments":[
   {"author":{"login":"late"},"body":"second","createdAt":"2026-11-18T02:00:00Z"},
   {"author":{"login":"early"},"body":"first","createdAt":"2026-11-18T00:00:00Z"}],
 "reviews":[
   {"author":{"login":"rev"},"body":"","state":"APPROVED","submittedAt":"2026-11-18T01:30:00Z"},
   {"author":{"login":"rev"},"body":"please fix","state":"CHANGES_REQUESTED","submittedAt":"2026-11-18T01:40:00Z"}],
 "files":[{"path":"a.go","additions":3,"deletions":1}],
 "statusCheckRollup":[{"__typename":"CheckRun","name":"ci","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://ci/1"}]}`

func TestDecodeReviewDetail(t *testing.T) {
	var pull ghPull
	if err := json.Unmarshal([]byte(prDetailJSON), &pull); err != nil {
		t.Fatalf("decode: %v", err)
	}
	d := pullDetail(pull)
	if d.Body == "" || d.Merge != "BLOCKED" {
		t.Fatalf("detail = %+v", d)
	}
	if len(d.Comments) != 3 {
		t.Fatalf("comments = %d, want 3 (two comments and one review with a body)", len(d.Comments))
	}
	want := []string{"early", "rev", "late"}
	for i, author := range want {
		if d.Comments[i].Author != author {
			t.Errorf("comment %d author = %q, want %q", i, d.Comments[i].Author, author)
		}
	}
	if d.Comments[1].Kind != "review" || d.Comments[1].State != "CHANGES_REQUESTED" {
		t.Errorf("review entry = %+v", d.Comments[1])
	}
	if len(d.Checks) != 1 || d.Checks[0].State != checksFail || d.Checks[0].URL != "https://ci/1" {
		t.Errorf("checks = %+v", d.Checks)
	}
	if len(d.Files) != 1 || d.Files[0].Path != "a.go" || d.Files[0].Adds != 3 {
		t.Errorf("files = %+v", d.Files)
	}
	if d.Item.Review != "CHANGES_REQUESTED" {
		t.Errorf("review decision = %q", d.Item.Review)
	}
}

const issueJSON = `{"number":2,"title":"Listed","state":"CLOSED","stateReason":"COMPLETED",
 "author":{"login":"houko"},"updatedAt":"2026-11-13T13:13:01Z",
 "url":"https://github.com/ayuayue/PiDeck-Lite/issues/2",
 "body":"thanks","labels":[{"name":"docs"}],
 "comments":[{"author":{"login":"owner"},"body":"done","createdAt":"2026-11-14T00:00:00Z"}]}`

func TestDecodeReviewIssue(t *testing.T) {
	var issue ghIssue
	if err := json.Unmarshal([]byte(issueJSON), &issue); err != nil {
		t.Fatalf("decode: %v", err)
	}
	items := issueItems([]ghIssue{issue})
	if len(items) != 1 {
		t.Fatalf("items = %d", len(items))
	}
	if items[0].Kind != reviewIssue || items[0].State != "CLOSED" || items[0].Reason != "COMPLETED" {
		t.Fatalf("item = %+v", items[0])
	}
	d := issueDetail(issue)
	if d.Body != "thanks" || len(d.Comments) != 1 || d.Comments[0].Author != "owner" {
		t.Fatalf("detail = %+v", d)
	}
	if d.Checks != nil || d.Files != nil {
		t.Error("an issue should carry no checks or files")
	}
}

func TestReviewMessagesAndRepo(t *testing.T) {
	cases := []struct {
		stderr string
		want   string
	}{
		{"To get started with GitHub CLI, please run:  gh auth login", "GitHub CLI 还没有登录，先在终端里运行 gh auth login"},
		{"HTTP 401: Bad credentials", "GitHub CLI 还没有登录，先在终端里运行 gh auth login"},
	}
	for _, c := range cases {
		if got := ghMessage(c.stderr, 1); got != c.want {
			t.Errorf("ghMessage(%q) = %q, want %q", c.stderr, got, c.want)
		}
	}
	if got := ghMessage("", 2); got != "gh 退出码 2" {
		t.Errorf("empty stderr = %q", got)
	}
	if got := repoFromURL("https://github.com/ayuayue/PiDeck-Lite/pull/8"); got != "ayuayue/PiDeck-Lite" {
		t.Errorf("repoFromURL = %q", got)
	}
	if got := repoFromURL("https://ghe.example.com/team/repo/issues/1"); got != "team/repo" {
		t.Errorf("repoFromURL(ghe) = %q", got)
	}
	if got := repoFromURL(""); got != "" {
		t.Errorf("repoFromURL(empty) = %q", got)
	}
	if got := reviewKey(reviewItem{Kind: reviewPR, Number: 8}); got != "pr#8" {
		t.Errorf("reviewKey = %q", got)
	}
}

func TestReviewStateText(t *testing.T) {
	cases := map[string]string{
		"CLEAN": "可合并", "MERGEABLE": "可合并", "BLOCKED": "被分支保护挡住",
		"DIRTY": "有冲突", "CONFLICTING": "有冲突", "UNSTABLE": "检查未通过", "": "",
	}
	for state, want := range cases {
		if got := mergeStateText(state); got != want {
			t.Errorf("mergeStateText(%q) = %q, want %q", state, got, want)
		}
	}
	if got := reviewChecksSummary([]reviewCheck{{State: checksPass}, {State: checksFail}, {State: checksPending}}); got != "检查：1 通过，1 失败，1 进行中" {
		t.Errorf("summary = %q", got)
	}
	if got := reviewChecksSummary([]reviewCheck{{State: checksPass}, {State: checksPass}}); got != "检查：2 通过，0 进行中" {
		t.Errorf("summary = %q", got)
	}
}
