package main

// Checks the per-turn change summary merges a turn's edited files.

import "testing"

func TestTurnChangesMergesFiles(t *testing.T) {
	tt := turn{Steps: []turnStep{
		{Tools: []toolRun{
			{Action: "编辑", Detail: "a.go", Added: 3, Removed: 1},
			{Action: "读取", Detail: "b.go"},
			{Action: "写入", Detail: "c.go", Added: 10},
		}},
		{Tools: []toolRun{
			{Action: "编辑", Detail: "a.go", Added: 2, Removed: 4},
			{Action: "运行", Detail: "go test"},
		}},
	}}
	got := turnChanges(tt)
	if len(got) != 2 {
		t.Fatalf("changes = %+v", got)
	}
	if got[0].Path != "a.go" || got[0].Added != 5 || got[0].Removed != 5 || got[0].Count != 2 {
		t.Fatalf("a.go = %+v", got[0])
	}
	if got[1].Path != "c.go" || got[1].Added != 10 || got[1].Count != 1 {
		t.Fatalf("c.go = %+v", got[1])
	}
	if changes := turnChanges(turn{Steps: []turnStep{{Tools: []toolRun{{Action: "读取", Detail: "x"}}}}}); len(changes) != 0 {
		t.Fatalf("reads counted: %+v", changes)
	}
}
