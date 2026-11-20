//go:build !js && !android && !ios

package workbench

// Checks custom ACP presets load from the data folder.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestDSHUsesPublishedACPProfile(t *testing.T) {
	for _, preset := range acpPresets() {
		if preset.ID == "dsh" {
			if preset.Command != "dsh" || !slices.Equal(preset.Args, []string{"--profile", "acp"}) || preset.Install != "@deepseek-ai/dsh" {
				t.Fatalf("DSH preset launches the wrong profile: %+v", preset)
			}
			return
		}
	}
	t.Fatal("DSH ACP preset is missing")
}

func TestACPPresetInstallFromBuiltinOnly(t *testing.T) {
	args, ok := acpPresetInstallArgs("dsh")
	if want := []string{"install", "--global", "--no-audit", "--no-fund", "@deepseek-ai/dsh"}; !ok || !slices.Equal(args, want) {
		t.Fatalf("install args = %v, %v, want %v", args, ok, want)
	}
	for _, id := range []string{"custom", "qoder", "claude", "--global", "@deepseek-ai/dsh"} {
		if args, ok := acpPresetInstallArgs(id); ok || len(args) != 0 {
			t.Errorf("%q can launch an installer: %v", id, args)
		}
	}
}

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

// TestACPPresetStore checks the manager's file round-trips.
func TestACPPresetStore(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	list := []acpPreset{{ID: "mine", Name: "我的 Agent", Command: "my-agent", Args: []string{"--acp"}}}
	if err := a.saveACPPresets(list); err != nil {
		t.Fatal(err)
	}
	got := a.acpCustomPresets()
	if len(got) != 1 || got[0].ID != "mine" || got[0].Command != "my-agent" || len(got[0].Args) != 1 {
		t.Fatalf("presets = %+v", got)
	}
	if all := a.acpPresetList(); len(all) != len(acpPresets())+1 {
		t.Fatalf("the list has %d presets, want %d", len(all), len(acpPresets())+1)
	}
}

// TestACPPresetManager adds and removes a preset through the dialog.
func TestACPPresetManager(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-integrations")
	app.WaitFor("id:acp-manage-open", 5*time.Second)
	app.Press("id:acp-manage-open")
	app.WaitFor("id:acp-preset-manager", 5*time.Second)
	app.Type("id:acp-preset-id", "mine")
	app.Type("id:acp-preset-name", "我的 Agent")
	app.Type("id:acp-preset-command", "my-agent")
	app.Type("id:acp-preset-args", "--acp --fast")
	app.Press("id:acp-preset-add")
	app.WaitFor("id:acp-preset-row-mine", 5*time.Second)
	path := filepath.Join(home, "acp", "presets.json")
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), "mine") || !strings.Contains(string(raw), "--fast") {
		t.Fatalf("presets.json = %s, %v", raw, err)
	}
	app.Press("id:acp-preset-remove-mine")
	app.WaitForGone("id:acp-preset-row-mine", 5*time.Second)
	raw, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file acpPresetFile
	if json.Unmarshal(raw, &file) != nil || len(file.Presets) != 0 {
		t.Fatalf("after removing: %s", raw)
	}
}

// TestAcpPresetList checks the built-in presets are distinct and carry the
// metadata the settings page shows.
func TestAcpPresetList(t *testing.T) {
	list := acpPresets()
	if len(list) < 12 {
		t.Fatalf("only %d built-in presets", len(list))
	}
	seen := map[string]bool{}
	for _, p := range list {
		if p.ID == "" || p.Name == "" || p.Command == "" {
			t.Errorf("incomplete preset %+v", p)
		}
		if seen[p.ID] {
			t.Errorf("duplicate preset id %q", p.ID)
		}
		seen[p.ID] = true
		if p.Homepage == "" {
			t.Errorf("%s has no homepage", p.ID)
		}
		if p.Npx && p.Install != "" {
			t.Errorf("%s is npx and names a package to install", p.ID)
		}
		if cmd := acpPresetInstall(p); p.Npx && cmd != "" {
			t.Errorf("%s: npx preset suggests installing %q", p.ID, cmd)
		}
		if state, _ := acpPresetState(p); state == "" {
			t.Errorf("%s has no state line", p.ID)
		}
	}
	// The Qoder presets must start in bypass permissions: the adapter
	// refuses to set that option after launch.
	for _, p := range list {
		if p.ID == "qoder" || p.ID == "qoder-cn" {
			if strings.Join(p.Args, " ") != "--acp --permission-mode bypass_permissions" {
				t.Errorf("%s args = %v", p.ID, p.Args)
			}
		}
	}
}
