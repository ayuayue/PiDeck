//go:build !js && !android && !ios

package workbench

// Checks the overview reads the files a conversation touched: pi reports an
// edit per call, the drawer lists each file once.

import (
	"reflect"
	"testing"
)

func TestSessionChangesFoldNewestFirst(t *testing.T) {
	turns := []turn{
		{ID: "older", Steps: []turnStep{{Tools: []toolRun{
			{Action: "编辑", Detail: "a.go", Added: 1, Removed: 2},
			{Action: "编辑", Detail: "b.go", Added: 3},
			// A command that names a path is not a change to it.
			{Action: "运行", Detail: "b.go", Added: 9},
		}}}},
		{ID: "newer", Steps: []turnStep{{Tools: []toolRun{
			{Action: "写入", Detail: "c.go", Added: 4},
			{Action: "编辑", Detail: "a.go", Added: 10, Removed: 1},
		}}}},
	}
	want := []fileChange{
		{Path: "c.go", Added: 4, Removed: 0, Count: 1},
		{Path: "a.go", Added: 11, Removed: 3, Count: 2},
		{Path: "b.go", Added: 3, Removed: 0, Count: 1},
	}
	if got := sessionChanges(turns); !reflect.DeepEqual(got, want) {
		t.Fatalf("sessionChanges = %+v, want %+v", got, want)
	}
	if got := sessionChanges(nil); len(got) != 0 {
		t.Fatalf("a session with no turns has changes: %+v", got)
	}
}
