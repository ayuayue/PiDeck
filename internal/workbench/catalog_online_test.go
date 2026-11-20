package workbench

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestGitHubCatalogEnvelopeBounds(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{"encoding": "base64", "size": 7, "content": base64.StdEncoding.EncodeToString([]byte("catalog"))})
	data, sha, err := decodeGitHubCatalog(raw, 7)
	if err != nil || sha != "" || string(data) != "catalog" {
		t.Fatalf("data=%q sha=%q err=%v", data, sha, err)
	}
	if _, _, err := decodeGitHubCatalog(raw, 6); err == nil {
		t.Fatal("accepted oversized content")
	}
	for _, raw := range []string{`{"encoding":"none","sha":"../escape"}`, `{"encoding":"base64","size":-1}`, `{"encoding":"base64","content":"invalid"}`} {
		if _, _, err := decodeGitHubCatalog([]byte(raw), 100); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func TestOnlineSkillsKeepReferencesAndRejectTraversal(t *testing.T) {
	list, err := parseSkillsSearch([]byte(`{"skills":[{"id":"owner/repo/check","name":"Check","source":"owner/repo"},{"id":"bad","name":"Bad","source":"../escape"}]}`))
	if err != nil || len(list) != 1 || !list[0].Snapshot {
		t.Fatalf("search=%+v %v", list, err)
	}
	dir := filepath.Join(t.TempDir(), "installed")
	raw := []byte(`{"files":[{"path":"SKILL.md","contents":"---\nname: check\ndescription: Checks\n---\nRead references/check.md"},{"path":"references/check.md","contents":"Actual reference"}]}`)
	if _, err := installSkillSnapshotData(dir, raw); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(filepath.Join(dir, "references", "check.md")); err != nil || string(body) != "Actual reference" {
		t.Fatalf("reference=%q %v", body, err)
	}
	if _, err := installSkillSnapshotData(dir, raw); err == nil {
		t.Fatal("overwrote an existing skill")
	}
	for _, path := range []string{"../escape", "/absolute", "C:/escape", "references/../../escape", "references\\escape", "SKILL.md", "refs./file"} {
		bad := []byte(`{"files":[{"path":"SKILL.md","contents":"instructions"},{"path":` + strconvQuote(path) + `,"contents":"bad"}]}`)
		if _, err := installSkillSnapshotData(filepath.Join(t.TempDir(), "install"), bad); err == nil {
			t.Fatalf("accepted path %q", path)
		}
	}
}

func TestPluginDiscoveryPreservesRuntimeBoundary(t *testing.T) {
	list, err := parseOfficialPlugins([]byte(`{"schemaVersion":1,"plugins":[{"name":"Host plugin","repo":"owner/plugin"},{"name":"Bad","repo":"../escape"}]}`))
	if err != nil || len(list) != 1 || !list[0].External || list[0].URL != "https://github.com/owner/plugin" {
		t.Fatalf("official=%+v %v", list, err)
	}
	monorepo, err := parseOfficialPlugins([]byte(`{"schemaVersion":1,"plugins":[{"id":"first","name":"First","repo":"owner/plugins","subpath":"plugins/first"},{"id":"second","name":"Second","repo":"owner/plugins","subpath":"plugins/second"}]}`))
	if err != nil || len(monorepo) != 2 || monorepo[0].ID == monorepo[1].ID || monorepo[0].URL != "https://github.com/owner/plugins/tree/main/plugins/first" {
		t.Fatalf("monorepo entries collided: %+v %v", monorepo, err)
	}
	a := &app{}
	if _, err := a.installMarketPlugin(list[0]); err == nil {
		t.Fatal("installed a host plugin into the declarative runtime")
	}
	community, err := parseCommunityPlugins([]byte(`{"items":[{"full_name":"owner/community","name":"Community"}]}`))
	if err != nil || len(community) != 1 || !community[0].External {
		t.Fatalf("community=%+v %v", community, err)
	}
}
