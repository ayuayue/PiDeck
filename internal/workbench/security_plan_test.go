//go:build !js && !android && !ios

package workbench

// Plan mode's marker, the security policy snapshot, and installing the
// official prompt pack into pi.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlanRequestUsesMarkerOnlyWithExtension(t *testing.T) {
	dir := t.TempDir()
	a := &app{dataDir: dir}
	plain := a.planRequest("改登录文案")
	if strings.Contains(plain, piPlanModeMarker) || !strings.Contains(plain, "请先不要改任何文件") {
		t.Fatalf("without the extension: %q", plain)
	}

	if err := os.MkdirAll(filepath.Join(dir, "extensions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "extensions", "pi-deck-plan-mode.ts"), []byte("// ext\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	marked := a.planRequest("改登录文案")
	if !strings.HasPrefix(marked, piPlanModeMarker+"\n") {
		t.Fatalf("with the extension: %q", marked)
	}
	if strings.Contains(marked, "请先不要改任何文件") {
		t.Fatalf("marker request still carries the fallback instructions: %q", marked)
	}
}

func TestExtensionDialogParsesPiDeckMarkers(t *testing.T) {
	planNext, title, _ := extensionDialog("[PI_DECK_PLAN_NEXT] 计划草案已就绪（2 步），是否执行？", "")
	if !planNext || strings.HasPrefix(title, "[") || !strings.Contains(title, "是否执行") {
		t.Fatalf("plan dialog: next=%v title=%q", planNext, title)
	}

	_, title, message := extensionDialog(`[PI_DECK_SECURITY_CONFIRM]{"tool":"bash","level":"标准","detail":"rm -rf build"}`+"", "")
	if title == "" || !strings.Contains(message, "bash") || !strings.Contains(message, "rm -rf build") {
		t.Fatalf("security dialog: title=%q message=%q", title, message)
	}
}

func TestSecurityPolicySnapshot(t *testing.T) {
	data, err := securityPolicyJSON("standard")
	if err != nil {
		t.Fatal(err)
	}
	var policy securityPolicy
	if err := json.Unmarshal(data, &policy); err != nil {
		t.Fatal(err)
	}
	if policy.SchemaVersion != 1 || !policy.Enabled || policy.DefaultLevelID != "standard" {
		t.Fatalf("snapshot = %+v", policy)
	}
	var standard, strict *securityLevelDef
	for i := range policy.Levels {
		switch policy.Levels[i].ID {
		case "standard":
			standard = &policy.Levels[i]
		case "strict":
			strict = &policy.Levels[i]
		}
	}
	if standard == nil || strict == nil {
		t.Fatalf("levels = %+v", policy.Levels)
	}
	if standard.ToolActions["bash"] != "ask" || !standard.ProtectSensitivePath || len(standard.DenyBashPatterns) == 0 {
		t.Fatalf("standard = %+v", standard)
	}
	if strict.PathPolicy != "workspace" || strict.DefaultAction != "deny" || strict.ToolActions["write"] != "ask" {
		t.Fatalf("strict = %+v", strict)
	}
	if standard.CustomAllowDirs == nil || strict.DenyDirs == nil {
		t.Fatal("snapshot slices must be arrays, not null")
	}
}

func TestInstallOfficialPromptsToPi(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_PI_CONFIG", dir)
	pack, err := officialPromptPack()
	if err != nil {
		t.Fatal(err)
	}
	added, skipped, err := installOfficialPromptsToPi(pack)
	if err != nil || added != 13 || skipped != 0 {
		t.Fatalf("first install = %d added, %d skipped, %v", added, skipped, err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "prompts", "fix.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(raw), "---\ndescription:") || !strings.Contains(string(raw), "Debug and fix") {
		t.Fatalf("fix.md = %q", raw)
	}

	added, skipped, err = installOfficialPromptsToPi(pack)
	if err != nil || added != 0 || skipped != 13 {
		t.Fatalf("second install = %d added, %d skipped, %v", added, skipped, err)
	}
}

func TestInstallOfficialPromptsRejectsBadSlug(t *testing.T) {
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	pack := promptPack{Prompts: []promptPackEntry{{Slug: "../escape", Title: "x", Body: "y"}}}
	if _, _, err := installOfficialPromptsToPi(pack); err == nil {
		t.Fatal("path traversal slug was accepted")
	}
}
