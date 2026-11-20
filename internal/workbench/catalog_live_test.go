package workbench

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Read-only public source validation is opt-in; normal tests never need a network.
func TestLivePublicCatalogs(t *testing.T) {
	if os.Getenv("PIDECK_LITE_TEST_CATALOGS") != "1" {
		t.Skip("set PIDECK_LITE_TEST_CATALOGS=1 for public catalog probes")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 6*time.Minute)
	defer cancel()
	a := &app{st: &store{dir: t.TempDir()}}
	t.Run("skills", func(t *testing.T) {
		raw, err := downloadCatalogData(ctx, "https://skills.sh/api/search?q=find-skills&limit=3", 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		list, err := parseSkillsSearch(raw)
		if err != nil {
			t.Fatal(err)
		}
		raw, err = downloadCatalogData(ctx, list[0].URL, 8<<20)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = installSkillSnapshotData(filepath.Join(t.TempDir(), "skill"), raw); err != nil {
			t.Fatal(err)
		}
		t.Logf("search and complete snapshot install: %s", list[0].Name)
	})
	t.Run("prompts", func(t *testing.T) {
		pack, err := fetchPromptPack(communityPromptsURL)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("prompts.chat: %d prompts", len(pack.Prompts))
		if _, _, err := a.importPromptPack(pack); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("chinese", func(t *testing.T) {
		var pack promptPack
		var err error
		if fixture := os.Getenv("PIDECK_LITE_TEST_CHINESE_DB"); fixture != "" {
			pack, err = readChinesePrompts(ctx, fixture)
			t.Log("using the supplied release database fixture")
		} else {
			pack, err = fetchChinesePrompts(ctx, chinesePromptsBase, filepath.Join(t.TempDir(), "xueprompts.db"))
		}
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("verified Chinese library: %d prompts", len(pack.Prompts))
		if _, _, err := a.importPromptPack(pack); err != nil {
			t.Fatal(err)
		}
		if _, err := a.settingsZip(); err != nil {
			t.Fatalf("online libraries cannot be backed up: %v", err)
		}
	})
	t.Run("plugins", func(t *testing.T) {
		var last error
		for _, source := range officialPluginSources {
			raw, err := downloadCatalogData(ctx, source, 1<<20)
			if err != nil {
				last = err
				continue
			}
			list, err := parseOfficialPlugins(raw)
			if err != nil {
				last = err
				continue
			}
			t.Logf("official registry: %d plugins", len(list))
			return
		}
		t.Fatal(last)
	})
}
