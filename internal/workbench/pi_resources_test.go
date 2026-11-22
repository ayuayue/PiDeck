//go:build !js && !android && !ios

package workbench

// Checks for reading pi's skills and extensions, toggling one, and the
// resources page.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestReadSkills checks a skill's frontmatter becomes its name and
// description.
func TestReadSkills(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
	skillDir := filepath.Join(dir, "skills", "image-gen")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "---\nname: image-gen\ndescription: 生成图片。\n---\n\n# 图片生成\n"
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	skills := readSkills()
	if len(skills) != 1 {
		t.Fatalf("skills = %+v", skills)
	}
	if skills[0].Name != "image-gen" || skills[0].Description != "生成图片。" ||
		!strings.HasSuffix(skills[0].File, "SKILL.md") {
		t.Fatalf("skill = %+v", skills[0])
	}
}

// TestReadExtensions checks builtins, npm packages, disabled ones and
// local files.
func TestReadExtensions(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
	settings := `{"extensions":["+builtin:codemode","+npm:pi-web-access"],"disabledExtensions":["npm:@samfp/pi-memory","npm:off-pkg"],"packages":["npm:pi-tracker","npm:off-pkg"],"theme":"dark"}`
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "extensions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "extensions", "local.ts"), []byte("export {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	list, err := readExtensions()
	if err != nil {
		t.Fatal(err)
	}
	bySource := map[string]extensionInfo{}
	for _, e := range list {
		bySource[e.Source] = e
	}
	if e := bySource["builtin:codemode"]; !e.Enabled || !e.Builtin || !e.Toggleable {
		t.Fatalf("builtin = %+v", e)
	}
	if e := bySource["npm:pi-web-access"]; !e.Enabled || e.Builtin {
		t.Fatalf("npm = %+v", e)
	}
	if e := bySource["npm:@samfp/pi-memory"]; e.Enabled || !e.Toggleable {
		t.Fatalf("disabled = %+v", e)
	}
	if e := bySource["local.ts"]; !e.Local || !e.Enabled || e.Toggleable {
		t.Fatalf("local = %+v", e)
	}
	if e := bySource["npm:pi-tracker"]; !e.Enabled || e.Toggleable {
		t.Fatalf("package = %+v", e)
	}
	if e := bySource["npm:off-pkg"]; e.Enabled || e.Toggleable {
		t.Fatalf("disabled package = %+v", e)
	}
}

// TestSetExtensionEnabled checks the two states and that other settings
// survive.
func TestSetExtensionEnabled(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
	path := filepath.Join(dir, "settings.json")
	body := `{"extensions":["+builtin:codemode"],"theme":"dark","disabledExtensions":[]}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := setExtensionEnabled("builtin:codemode", false); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Extensions []string `json:"extensions"`
		Disabled   []string `json:"disabledExtensions"`
		Theme      string   `json:"theme"`
	}
	raw, _ := os.ReadFile(path)
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Extensions) != 1 || got.Extensions[0] != "builtin:codemode" {
		t.Fatalf("extensions after off = %v", got.Extensions)
	}
	if len(got.Disabled) != 1 || got.Disabled[0] != "builtin:codemode" {
		t.Fatalf("disabled after off = %v", got.Disabled)
	}
	if got.Theme != "dark" {
		t.Fatalf("theme lost: %q", got.Theme)
	}
	if err := setExtensionEnabled("builtin:codemode", true); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(path)
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Extensions) != 1 || got.Extensions[0] != "+builtin:codemode" {
		t.Fatalf("extensions after on = %v", got.Extensions)
	}
	if len(got.Disabled) != 0 {
		t.Fatalf("disabled after on = %v", got.Disabled)
	}
}

// TestResourcesPage checks the page lists a skill and toggles an
// extension.
func TestResourcesPage(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	cfgDir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_PI_CONFIG", cfgDir)
	skillDir := filepath.Join(cfgDir, "skills", "doctor")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"),
		[]byte("---\nname: doctor\ndescription: 排查问题。\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	settings := `{"extensions":["+builtin:codemode"]}`
	path := filepath.Join(cfgDir, "settings.json")
	if err := os.WriteFile(path, []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-resources")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("text:doctor")) > 0 })
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:builtin:codemode")) > 0 })
	app.Press("id:extension-toggle-builtin-codemode")
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(raw), `"disabledExtensions"`) &&
			strings.Contains(string(raw), "builtin:codemode") && !strings.Contains(string(raw), `"+builtin:codemode"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("settings after toggle = %s", raw)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
