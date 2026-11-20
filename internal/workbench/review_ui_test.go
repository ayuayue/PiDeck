//go:build !js && !android && !ios

package workbench

// The review pane's drawing, with the state a read would have published:
// a list of two items and then one item's page. Nothing here runs gh, so
// the test says what the pane shows without a network or a login.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestReviewPaneRenders(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	// No project: the pane then never reaches gh, which is what lets this
	// test run without a login.
	raw, err := json.Marshal(config{Version: 1, Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.reviewPane()
	}, nsgotest.Size(1100, 900))
	if built == nil || built.review == nil {
		t.Fatal("the app did not build the review pane")
	}
	built.review.state.Set(reviewState{Checked: true, Limit: 40, Items: []reviewItem{
		{Kind: reviewPR, Number: 12, Title: "Add a review pane", State: "OPEN", Author: "ayuayue",
			Branch: "feat/review", Base: "main", Checks: checksPass, Review: "APPROVED", Adds: 40, Deletes: 3,
			Labels: []string{"feature"}, Updated: time.Now()},
		{Kind: reviewPR, Number: 13, Title: "A failing change", State: "OPEN", Author: "someone",
			Branch: "wip", Checks: checksFail, Draft: true, Updated: time.Now()},
		{Kind: reviewPR, Number: 14, Title: "Old one", State: "MERGED", Author: "someone", Updated: time.Now()},
	}})
	screen.Settle()
	screen.WaitFor("text:Add a review pane", 10*time.Second)
	screen.WaitFor("text:#12", 2*time.Second)
	screen.WaitFor("text:feat/review → main", 2*time.Second)

	built.review.state.Set(reviewState{Checked: true, Limit: 40, Open: "pr#12", Detail: &reviewDetail{
		Item: reviewItem{Kind: reviewPR, Number: 12, Title: "Add a review pane", State: "OPEN",
			Author: "ayuayue", Branch: "feat/review", Base: "main", Adds: 40, Deletes: 3, URL: "https://github.com/o/r/pull/12"},
		Body:     "Adds the pane.",
		Merge:    "CLEAN",
		Comments: []reviewComment{{Author: "rev", Body: "Looks good", At: time.Now(), Kind: "review", State: "APPROVED"}},
		Checks:   []reviewCheck{{Name: "ci", State: checksPass}},
		Files:    []reviewFile{{Path: "internal/workbench/ui_review.go", Adds: 40, Deletes: 3}},
	}})
	screen.Settle()
	screen.WaitFor("text:AI 评估", 10*time.Second)
	screen.WaitFor("text:合并…", 2*time.Second)
	screen.WaitFor("text:改动 1 个文件", 2*time.Second)
	screen.WaitFor("text:Looks good", 2*time.Second)
	screen.WaitFor("text:可合并", 2*time.Second)

	// The verdict picker opens beside the merge one. Submitting goes
	// through the confirm dialog, which the whole shell mounts, so it is
	// not in this tree.
	screen.Press("id:review-verdict")
	screen.Settle()
	screen.WaitFor("text:只评论", 10*time.Second)
	// Both pickers must react without a metadata refresh rebuilding them.
	screen.Press("id:review-merge")
	screen.WaitFor("id:review-merge-squash", 2*time.Second)

	built.review.state.Set(reviewState{Checked: true, Missing: true})
	screen.Settle()
	screen.WaitFor("text:这台机器上没有 GitHub CLI", 10*time.Second)
}

func TestReviewPatchDialog(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return core.View{Style: core.Style{FlexGrow: 1}, Children: []core.Node{built.reviewPatchDialog()}}
	}, nsgotest.Size(1100, 800))
	built.review.state.Set(reviewState{Checked: true, Patch: "@@ -1 +1 @@\n-old line\n+new line\n", Detail: &reviewDetail{
		Item: reviewItem{Kind: reviewPR, Number: 12, Title: "Add a review pane"},
	}})
	built.review.patchOpen.Set(true)
	screen.Settle()
	screen.WaitFor("text:#12 Add a review pane", 10*time.Second)
	screen.WaitFor("text:复制补丁", 2*time.Second)
}
