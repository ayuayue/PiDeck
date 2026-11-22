//go:build !js && !android && !ios

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
		list, err := fetchOfficialPlugins(ctx, officialPluginSources)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("official registry: %d plugins", len(list))
	})
	t.Run("pi-packages", func(t *testing.T) {
		catalogCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		page, err := fetchPiCatalog(catalogCtx, "", 1)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) == 0 || page.Total < len(page.Items) {
			t.Fatalf("pi.dev directory: %d items, total %d", len(page.Items), page.Total)
		}
		t.Logf("pi.dev directory: %d items, %d total, first %q (%s)",
			len(page.Items), page.Total, page.Items[0].Name, page.Items[0].InstallSource)
	})
	t.Run("pi-extension-manifest", func(t *testing.T) {
		manifestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		manifest, err := fetchPiExtensionManifest(manifestCtx)
		if err != nil {
			t.Fatal(err)
		}
		if len(manifest.Files) == 0 {
			t.Fatal("remote manifest has no files")
		}
		file := manifest.Files[0]
		data, err := fetchPiExtensionRepoFile(manifestCtx, "resources/extensions/"+file.Name, piExtensionFileMax)
		if err != nil {
			t.Fatal(err)
		}
		if !piExtensionContentMatches(data, file) {
			t.Fatalf("%s does not match the manifest", file.Name)
		}
		t.Logf("pi extensions: version %s, %d files; verified %s", manifest.Version, len(manifest.Files), file.Name)
	})
}
