package client

// The review screen's own words and conversions, without a server: the
// parts a browser build can check on its own.

import (
	"testing"
	"time"

	"example.com/pideck-lite/internal/remotewire"
)

func TestReviewTimesAndLabels(t *testing.T) {
	if !msTime(0).IsZero() {
		t.Error("a zero millisecond count should be the zero time")
	}
	at := msTime(1700000000000)
	if at.IsZero() || !at.Equal(time.UnixMilli(1700000000000)) {
		t.Errorf("msTime = %v", at)
	}

	open := remotewire.ReviewItem{Kind: "pr", State: "OPEN"}
	if got := (&mobileApp{}).reviewStateLabel(open); got != "打开" {
		t.Errorf("open label = %q", got)
	}
	draft := remotewire.ReviewItem{Kind: "pr", State: "OPEN", Draft: true}
	if got := (&mobileApp{}).reviewStateLabel(draft); got != "草稿" {
		t.Errorf("draft label = %q", got)
	}
	merged := remotewire.ReviewItem{Kind: "pr", State: "MERGED"}
	if got := (&mobileApp{}).reviewStateLabel(merged); got != "已合并" {
		t.Errorf("merged label = %q", got)
	}
}

func TestReviewPendingText(t *testing.T) {
	a := &mobileApp{}
	cases := map[string]string{
		"close":        "关闭之后仍可以在 GitHub 上重新打开，确定吗？",
		"reopen":       "会重新打开这一条，确定吗？",
		"merge:squash": "以压缩合并的方式合入目标分支，之后对所有人可见。需要其他合并方式请在电脑上操作。",
		"merge:rebase": "确定要这么做吗？",
	}
	for pending, want := range cases {
		if got := a.reviewPendingText(pending); got != want {
			t.Errorf("reviewPendingText(%q) = %q, want %q", pending, got, want)
		}
	}
}
