//go:build !js && !android && !ios

package workbench

// Bundled skills, prompt templates and the extension hot-update manifest.

import (
	"os"
	"strings"
	"testing"

	"example.com/pideck/assets"
)

func TestParsePiExtensionManifest(t *testing.T) {
	sha := strings.Repeat("a", 64)
	valid := `{"schemaVersion":1,"version":"1.2.3","files":[{"name":"pi-deck-todo.ts","sha256":"` + sha + `","bytes":10}]}`
	manifest, err := parsePiExtensionManifest([]byte(valid))
	if err != nil {
		t.Fatalf("valid manifest: %v", err)
	}
	if manifest.Version != "1.2.3" || len(manifest.Files) != 1 || manifest.Files[0].Name != "pi-deck-todo.ts" {
		t.Fatalf("manifest = %+v", manifest)
	}

	bad := []string{
		`{"schemaVersion":2,"version":"1","files":[]}`,
		`{"schemaVersion":1,"version":"","files":[{"name":"a.ts","sha256":"` + sha + `","bytes":1}]}`,
		`{"schemaVersion":1,"version":"1","files":[{"name":"../a.ts","sha256":"` + sha + `","bytes":1}]}`,
		`{"schemaVersion":1,"version":"1","files":[{"name":"a.ts","sha256":"xyz","bytes":1}]}`,
		`{"schemaVersion":1,"version":"1","files":[{"name":"a.ts","sha256":"` + sha + `","bytes":0}]}`,
		`{"schemaVersion":1,"version":"1","files":[{"name":"a.ts","sha256":"` + sha + `","bytes":1},{"name":"a.ts","sha256":"` + sha + `","bytes":1}]}`,
	}
	for _, raw := range bad {
		if _, err := parsePiExtensionManifest([]byte(raw)); err == nil {
			t.Fatalf("accepted invalid manifest: %s", raw)
		}
	}
}

func TestPiExtensionContentMatches(t *testing.T) {
	file := piExtensionManifestFile{Name: "a.ts", SHA256: sha256Text([]byte("hello")), Bytes: 5}
	if !piExtensionContentMatches([]byte("hello"), file) {
		t.Fatal("matching content rejected")
	}
	if piExtensionContentMatches([]byte("hellO"), file) || piExtensionContentMatches([]byte("hello!"), file) {
		t.Fatal("changed content accepted")
	}
}

func TestBundledExtensionNamesLeaveOutV2OnlyFiles(t *testing.T) {
	names := bundledExtensionNames()
	for _, want := range []string{"pi-deck-ask-question.ts", "pi-deck-todo.ts", "pi-deck-todo-state.ts", "pi-deck-trash-guard.ts"} {
		if !names[want] {
			t.Fatalf("%s is not updatable", want)
		}
	}
	for _, skip := range []string{"pi-deck-retry-no-body.ts", "pi-deck-local-tools.ts"} {
		if names[skip] {
			t.Fatalf("%s must not be replaced by the remote manifest", skip)
		}
	}
}

func TestInstallBundledSkillsKeepsExistingCopy(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_PI_CONFIG", dir)
	pideckSkillPath = ""
	defer func() { pideckSkillPath = "" }()

	installBundledSkills()
	mcpPath := dir + "/skills/mcp-setup/SKILL.md"
	if got, err := os.ReadFile(mcpPath); err != nil || string(got) != string(assets.SkillMCPSetup) {
		t.Fatalf("mcp-setup = %q, %v", got, err)
	}
	if pideckSkillPath == "" {
		t.Fatal("pideck skill was not installed")
	}
	if got, err := os.ReadFile(pideckSkillPath + "/SKILL.md"); err != nil || string(got) != string(assets.SkillPiDeck) {
		t.Fatalf("pideck = %q, %v", got, err)
	}

	if err := writeFileAtomic(mcpPath, []byte("user copy\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pideckSkillPath = ""
	installBundledSkills()
	if got, _ := os.ReadFile(mcpPath); string(got) != "user copy\n" {
		t.Fatalf("existing skill overwritten: %q", got)
	}
	if pideckSkillPath == "" {
		t.Fatal("existing pideck skill is no longer injected")
	}
}

func TestOfficialPromptPack(t *testing.T) {
	pack, err := officialPromptPack()
	if err != nil {
		t.Fatal(err)
	}
	if len(pack.Prompts) != 13 {
		t.Fatalf("official pack has %d prompts, want 13", len(pack.Prompts))
	}
	for _, prompt := range pack.Prompts {
		if strings.TrimSpace(prompt.Title) == "" || strings.TrimSpace(prompt.Body) == "" {
			t.Fatalf("empty prompt in official pack: %+v", prompt)
		}
	}
}

func TestOfficialPromptPackImportsOnce(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	pack, err := officialPromptPack()
	if err != nil {
		t.Fatal(err)
	}
	added, skipped, err := a.importPromptPack(pack)
	if err != nil || added != 13 || skipped != 0 {
		t.Fatalf("first import = %d added, %d skipped, %v", added, skipped, err)
	}
	added, skipped, err = a.importPromptPack(pack)
	if err != nil || added != 0 || skipped != 13 {
		t.Fatalf("second import = %d added, %d skipped, %v", added, skipped, err)
	}
}
