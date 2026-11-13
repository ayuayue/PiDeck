package main

// Checks custom ACP presets load from the data folder.

import (
	"os"
	"path/filepath"
	"testing"
)

// TestACPPresetList checks files add presets, bad entries are skipped and
// built-ins stay.
func TestACPPresetList(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	acpDir := filepath.Join(dir, "acp")
	if err := os.MkdirAll(acpDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"presets":[
		{"id":"mine","name":"Mine","command":"mine-acp","args":["--acp"]},
		{"id":"","name":"bad","command":"x"},
		{"id":"claude","name":"Dup","command":"x"}
	]}`
	if err := os.WriteFile(filepath.Join(acpDir, "one.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	array := `[{"id":"other","name":"Other","command":"other-acp"}]`
	if err := os.WriteFile(filepath.Join(acpDir, "two.json"), []byte(array), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	list := a.acpPresetList()
	byID := map[string]acpPreset{}
	for _, p := range list {
		byID[p.ID] = p
	}
	if _, ok := byID["claude"]; !ok {
		t.Fatal("the built-in Claude preset is missing")
	}
	if p, ok := byID["mine"]; !ok || p.Command != "mine-acp" || len(p.Args) != 1 {
		t.Fatalf("custom preset = %+v", p)
	}
	if _, ok := byID["other"]; !ok {
		t.Fatal("a bare array file was not read")
	}
	if _, ok := byID[""]; ok {
		t.Fatal("an invalid preset was kept")
	}
	if byID["claude"].Name == "Dup" {
		t.Fatal("a duplicate id overrode the built-in")
	}
}
