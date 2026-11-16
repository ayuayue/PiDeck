package main

// Checks the custom-agent file the manager owns: add, rename, delete and
// the id rules.

import (
	"os"
	"testing"
)

// TestCustomAgentRoundTrip writes, reads and removes an agent.
func TestCustomAgentRoundTrip(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	if err := a.upsertAgent("", "qa-bot", "质检", "先找边界", "你是一名质检员。"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(a.customAgentsFile()); err != nil {
		t.Fatalf("custom.json not written: %v", err)
	}
	list := a.customAgents()
	if len(list) != 1 || list[0].ID != "qa-bot" || list[0].Prompt != "你是一名质检员。" {
		t.Fatalf("custom = %+v", list)
	}
	if !a.isCustomAgent("qa-bot") {
		t.Error("isCustomAgent said no")
	}
	if err := a.upsertAgent("qa-bot", "qa-bot-2", "质检二号", "换个 id", "你是一名质检员。"); err != nil {
		t.Fatal(err)
	}
	list = a.customAgents()
	if len(list) != 1 || list[0].ID != "qa-bot-2" || list[0].Name != "质检二号" {
		t.Fatalf("renamed = %+v", list)
	}
	if err := a.removeCustomAgent("qa-bot-2"); err != nil {
		t.Fatal(err)
	}
	if got := a.customAgents(); len(got) != 0 {
		t.Fatalf("still there: %+v", got)
	}
}

// TestUpsertAgentRejects checks the two ids it must refuse.
func TestUpsertAgentRejects(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	if err := a.upsertAgent("", "review", "重复", "", "x"); err == nil {
		t.Error("a built-in id was accepted")
	}
	if err := a.upsertAgent("", "bad id", "空格", "", "x"); err == nil {
		t.Error("an id with a space was accepted")
	}
	if err := a.upsertAgent("", "ok", "", "", "x"); err == nil {
		t.Error("an empty name was accepted")
	}
	if got := a.customAgents(); len(got) != 0 {
		t.Fatalf("a rejected agent was written: %+v", got)
	}
}
