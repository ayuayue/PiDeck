//go:build !js && !android && !ios

package workbench

// The arguments each write hands gh, so a comment, a merge, a state change
// and a review go out as the commands gh documents.

import (
	"reflect"
	"testing"
)

func TestReviewCommand(t *testing.T) {
	cases := []struct {
		name     string
		kind     string
		number   int
		action   string
		method   string
		body     string
		want     []string
		wantIn   string
		wantFail bool
	}{
		{name: "comment pipes the body", kind: reviewPR, number: 7, action: reviewActComment, body: " nice \n",
			want: []string{"pr", "comment", "7", "--body-file", "-"}, wantIn: "nice"},
		{name: "issue comment", kind: reviewIssue, number: 2, action: reviewActComment, body: "thanks",
			want: []string{"issue", "comment", "2", "--body-file", "-"}, wantIn: "thanks"},
		{name: "empty comment", kind: reviewPR, number: 7, action: reviewActComment, body: " ", wantFail: true},
		{name: "merge squashes by default", kind: reviewPR, number: 7, action: reviewActMerge,
			want: []string{"pr", "merge", "7", "--squash"}},
		{name: "merge commit", kind: reviewPR, number: 7, action: reviewActMerge, method: "merge",
			want: []string{"pr", "merge", "7", "--merge"}},
		{name: "rebase", kind: reviewPR, number: 7, action: reviewActMerge, method: "rebase",
			want: []string{"pr", "merge", "7", "--rebase"}},
		{name: "issues cannot merge", kind: reviewIssue, number: 2, action: reviewActMerge, wantFail: true},
		{name: "close a pull request", kind: reviewPR, number: 7, action: reviewActClose,
			want: []string{"pr", "close", "7"}},
		{name: "reopen an issue", kind: reviewIssue, number: 2, action: reviewActReopen,
			want: []string{"issue", "reopen", "2"}},
		{name: "approve without a note", kind: reviewPR, number: 7, action: reviewActReview, method: verdictApprove,
			want: []string{"pr", "review", "7", "--approve"}},
		{name: "approve with a note", kind: reviewPR, number: 7, action: reviewActReview, method: verdictApprove, body: "ship it",
			want: []string{"pr", "review", "7", "--approve", "--body-file", "-"}, wantIn: "ship it"},
		{name: "request changes with a note", kind: reviewPR, number: 7, action: reviewActReview, method: verdictRequestChanges, body: "fix this",
			want: []string{"pr", "review", "7", "--request-changes", "--body-file", "-"}, wantIn: "fix this"},
		{name: "request changes needs a note", kind: reviewPR, number: 7, action: reviewActReview, method: verdictRequestChanges, wantFail: true},
		{name: "comment verdict needs a note", kind: reviewPR, number: 7, action: reviewActReview, method: verdictComment, wantFail: true},
		{name: "issues cannot be reviewed", kind: reviewIssue, number: 2, action: reviewActReview, method: verdictApprove, wantFail: true},
		{name: "unknown verdict", kind: reviewPR, number: 7, action: reviewActReview, method: "lgtm", wantFail: true},
		{name: "unknown action", kind: reviewPR, number: 7, action: "delete", wantFail: true},
		{name: "missing number", kind: reviewPR, number: 0, action: reviewActClose, wantFail: true},
	}
	for _, c := range cases {
		args, stdin, err := reviewCommand(c.kind, c.number, c.action, c.method, c.body)
		if c.wantFail {
			if err == nil {
				t.Errorf("%s: expected a refusal, got %v", c.name, args)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if !reflect.DeepEqual(args, c.want) {
			t.Errorf("%s: args = %v, want %v", c.name, args, c.want)
		}
		if c.wantIn != "" && stdin == "" {
			t.Errorf("%s: stdin = %q, want the body", c.name, stdin)
		}
		if c.wantIn != "" && !contains(stdin, c.wantIn) {
			t.Errorf("%s: stdin = %q, want it to carry %q", c.name, stdin, c.wantIn)
		}
	}
}

func contains(text, part string) bool {
	if len(part) == 0 {
		return true
	}
	for i := 0; i+len(part) <= len(text); i++ {
		if text[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
