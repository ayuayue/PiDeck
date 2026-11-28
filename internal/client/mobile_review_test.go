package client

// The review screen's own words and conversions, without a server: the
// parts a browser build can check on its own.

import (
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
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

// TestThoughtFolding checks the thinking blocks a loaded session folds:
// the key stays with a block as its text grows, and folding is per block.
func TestThoughtFolding(t *testing.T) {
	text := "先看 remoteMessages 的预算，它按顺序累加，所以尾部的回答会被丢掉。"
	key := thoughtKey(text)
	if key == "" || key != thoughtKey(text+" 后面还在写") {
		t.Fatalf("thoughtKey changed as the text grew: %q, %q", key, thoughtKey(text+" 后面还在写"))
	}
	if len([]rune(key)) > 24 {
		t.Fatalf("thoughtKey = %d runes, want at most 24", len([]rune(key)))
	}
	if got := thoughtKey("  \n "); got != "" {
		t.Fatalf("thoughtKey(blank) = %q", got)
	}
}

// TestMergeMessages checks the page merge a poll does: the older turns the
// reader loaded stay, and the newest page replaces the copy it had.
func TestMergeMessages(t *testing.T) {
	held := []remotewire.Message{
		{Role: "user", Text: "t1", Turn: 1},
		{Role: "assistant", Text: "t2 旧", Turn: 2},
		{Role: "assistant", Text: "t3 旧", Turn: 3},
	}
	page := []remotewire.Message{
		{Role: "assistant", Text: "t3 新", Turn: 3},
		{Role: "user", Text: "t4", Turn: 4},
	}
	got := mergeMessages(held, page, 3)
	// Turns 1 and 2 are older than the page; turn 3 keeps its fresh copy.
	if len(got) != 4 || got[0].Text != "t1" || got[1].Text != "t2 旧" || got[2].Text != "t3 新" || got[3].Text != "t4" {
		t.Fatalf("merge = %+v", got)
	}
	// A first page with nothing held replaces what was there, and the
	// cursor only ever reaches further back.
	if got := mergeMessages(held, page, 0); len(got) != 2 || got[0].Text != "t3 新" {
		t.Fatalf("merge with no cursor = %+v", got)
	}
	if keepBefore(10, 30) != 10 || keepBefore(0, 30) != 30 || keepBefore(10, 0) != 0 || keepBefore(30, 30) != 30 {
		t.Fatal("keepBefore must keep the furthest-back cursor")
	}
}

// TestThinkingLevels checks the two lists a thinking block moves through:
// folded, its head, all of it.
func TestThinkingLevels(t *testing.T) {
	key := "先看预算"
	list := toggleKey(nil, key)
	if !hasKey(list, key) {
		t.Fatal("toggleKey must add a key")
	}
	if !hasKey(toggleKey(list, "另一个"), key) || len(toggleKey(list, "另一个")) != 2 {
		t.Fatal("toggleKey must add another key beside the first")
	}
	if hasKey(toggleKey(list, key), key) {
		t.Fatal("toggleKey must drop a key it already holds")
	}
	if hasKey(nil, key) {
		t.Fatal("an empty list holds nothing")
	}
}
