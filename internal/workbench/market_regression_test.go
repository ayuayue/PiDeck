//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMarketUpdatesInstalledManifestAndPreservesRejectedUpdate(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st, cfg: st.config()}
	body := `{"id":"team","name":"Team","version":"1.0.0","contributes":{"commands":[{"id":"hello","title":"Hello","action":{"type":"prompt","prompt":"v1"}}]}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	entry := marketEntry{ID: "team", Name: "Team", URL: srv.URL, Version: "1.0.0"}
	if _, err := a.installMarketPlugin(entry); err != nil {
		t.Fatal(err)
	}
	body = strings.ReplaceAll(strings.ReplaceAll(body, "1.0.0", "1.1.0"), "v1", "v2")
	entry.Version = "1.1.0"
	if _, err := a.installMarketPlugin(entry); err != nil {
		t.Fatalf("update failed: %v", err)
	}
	path := filepath.Join(a.pluginsDir(), "team.json")
	before, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(before), "v2") {
		t.Fatalf("updated manifest=%q, err=%v", before, err)
	}
	for _, bad := range []string{
		`{"id":"other","name":"Other","version":"1.2.0"}`,
		`{"id":"team","name":"Team","version":"1.1.0","contributes":{"agents":[{"id":"a","name":"A","prompt":"hello"}]}}`,
		`{"id":"team","name":"Team","version":"1.2.0","runtime":"pideck-electron"}`,
	} {
		body, entry.Version = bad, "1.2.0"
		if _, err := a.installMarketPlugin(entry); err == nil {
			t.Errorf("accepted invalid update: %s", bad)
		}
		after, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(before, after) {
			t.Fatalf("rejected update changed installed manifest: %q, %v", after, err)
		}
	}
}

func TestMarketInstallsAgentOnlyPlugin(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"agents","name":"Agents","contributes":{"agents":[{"id":"review","name":"Review","prompt":"Review carefully."}]}}`))
	}))
	defer srv.Close()
	a := &app{st: st, cfg: st.config()}
	p, err := a.installMarketPlugin(marketEntry{ID: "agents", Name: "Agents", URL: srv.URL})
	if err != nil || len(p.Contributes.Agents) != 1 {
		t.Fatalf("agent-only plugin=%+v, err=%v", p, err)
	}
}

func TestMarketRefusesCrossRuntimeInstallAndUpdate(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st, cfg: st.config()}
	var requested bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requested = true
		_, _ = w.Write([]byte(`{"schemaVersion":2,"runtime":"pideck-lite","id":"team","name":"Team","version":"2.0.0","contributes":{"agents":[{"id":"a","name":"A","prompt":"x"}]}}`))
	}))
	defer srv.Close()
	entry := marketEntry{ID: "team", Name: "Team", Runtime: "pideck-electron", Version: "2.0.0", URL: srv.URL}
	if _, err := a.installMarketPlugin(entry); err == nil || requested {
		t.Fatalf("foreign entry: err=%v, downloaded=%v", err, requested)
	}
	if err := os.MkdirAll(a.pluginsDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(a.pluginsDir(), "team.json")
	previous := `{"schemaVersion":1,"runtime":"pideck-electron","id":"team","name":"Team","version":"1.0.0"}`
	if err := os.WriteFile(path, []byte(previous), 0o644); err != nil {
		t.Fatal(err)
	}
	entry.Runtime = litePluginRuntime
	if _, err := a.installMarketPlugin(entry); err == nil {
		t.Fatal("replaced an installed foreign-runtime manifest with a Lite manifest")
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != previous {
		t.Fatalf("foreign manifest=%q, err=%v", got, err)
	}
}

func TestOfficialRegistryRoutesLiteAndElectronSeparately(t *testing.T) {
	raw := []byte(`{"schemaVersion":1,"plugins":[
		{"id":"notes","name":"Notes","repo":"owner/plugins","subpath":"plugins/notes"},
		{"id":"lite-notes","name":"Lite notes","repo":"owner/plugins","runtime":"pideck-lite","url":"https://example.com/lite.json"},
		{"id":"future","name":"Future","repo":"owner/plugins","runtime":"unknown","url":"https://example.com/future.json"}
	]}`)
	list, err := parseOfficialPlugins(raw)
	if err != nil || len(list) != 3 {
		t.Fatalf("list=%+v, err=%v", list, err)
	}
	if !list[0].External || list[1].External || list[1].ID != "lite-notes" || list[1].URL != "https://example.com/lite.json" || !list[2].External {
		t.Fatalf("registry lost runtime boundary: %+v", list)
	}
}

func TestMixedRegistryV2RequiresRuntime(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"schemaVersion":2,"plugins":[
			{"id":"legacy","name":"Missing runtime","repo":"owner/plugins"},
			{"id":"notes","name":"Notes","repo":"owner/plugins","runtime":"pideck-electron"},
			{"id":"lite","name":"Lite","repo":"owner/plugins","runtime":"pideck-lite","url":"https://example.com/lite.json"}
		]}`))
	}))
	defer srv.Close()
	list, err := fetchPluginIndex(context.Background(), srv.URL)
	if err != nil || len(list) != 2 || !list[0].External || list[1].External || list[1].ID != "lite" {
		t.Fatalf("mixed registry=%+v, err=%v", list, err)
	}
}

func TestOfficialRegistryPrefersMixedFeedAndFallsBackBeforePublish(t *testing.T) {
	for _, published := range []bool{true, false} {
		name := "legacy fallback"
		if published {
			name = "mixed feed"
		}
		t.Run(name, func(t *testing.T) {
			requests := make(chan string, 3)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests <- r.URL.Path
				switch r.URL.Path {
				case "/registry-v2.json":
					if !published {
						http.NotFound(w, r)
						return
					}
					_, _ = fmt.Fprintf(w, `{"schemaVersion":2,"plugins":[
						{"id":"notes","name":"Notes","repo":"owner/plugins","runtime":"pideck-electron"},
						{"id":"lite-notes","name":"Lite Notes","version":"1.0.0","repo":"owner/plugins","runtime":"pideck-lite","url":"http://%s/plugin.json"}
					]}`, r.Host)
				case "/registry.json":
					_, _ = w.Write([]byte(`{"schemaVersion":1,"plugins":[{"id":"notes","name":"Notes","repo":"owner/plugins"}]}`))
				case "/plugin.json":
					_, _ = w.Write([]byte(`{"schemaVersion":2,"runtime":"pideck-lite","id":"lite-notes","version":"1.0.0","name":"Lite Notes","contributes":{"commands":[{"id":"note","title":"Note","action":{"type":"insert","prompt":"example"}}]}}`))
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			list, err := fetchOfficialPlugins(t.Context(), []string{srv.URL + "/registry-v2.json", srv.URL + "/registry.json"})
			want := 1
			if published {
				want = 2
			}
			if err != nil || len(list) != want || !list[0].External {
				t.Fatalf("official feed=%+v err=%v, want %d entries with Electron discovery", list, err, want)
			}
			wantRequests := 1
			if !published {
				wantRequests++
			}
			if len(requests) != wantRequests || <-requests != "/registry-v2.json" {
				t.Fatal("did not try the mixed feed first and fall back only when needed")
			}
			if !published {
				if got := <-requests; got != "/registry.json" {
					t.Fatalf("fallback request=%q, want /registry.json", got)
				}
				return
			}
			st, err := newStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			a := &app{st: st, lifetime: t.Context()}
			plugin, err := a.installMarketPlugin(list[1])
			if err != nil || plugin.ID != "lite-notes" || len(plugin.Commands) != 1 {
				t.Fatalf("official install=%+v err=%v", plugin, err)
			}
		})
	}
}

func TestMarketRejectsOversizedManifestAndConcurrentEdit(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st, cfg: st.config()}
	base := `{"id":"team","name":"Team","version":"1.0.0","contributes":{"agents":[{"id":"review","name":"Review","prompt":"Review."}]}}`
	body := base
	var editDuringDownload func()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if editDuringDownload != nil {
			editDuringDownload()
		}
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	entry := marketEntry{ID: "team", Name: "Team", Version: "1.0.0", URL: srv.URL}
	if _, err := a.installMarketPlugin(entry); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(a.pluginsDir(), "team.json")
	body = strings.ReplaceAll(base, "1.0.0", "1.1.0") + strings.Repeat(" ", 512<<10)
	entry.Version = "1.1.0"
	if _, err := a.installMarketPlugin(entry); err == nil {
		t.Fatal("accepted oversized manifest")
	}
	body = strings.ReplaceAll(base, "1.0.0", "1.1.0")
	edited := strings.ReplaceAll(base, "Team", "Local edit")
	editDuringDownload = func() {
		if err := os.WriteFile(path, []byte(edited), 0o644); err != nil {
			t.Error(err)
		}
	}
	if _, err := a.installMarketPlugin(entry); err == nil {
		t.Fatal("overwrote a local edit made during download")
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != edited {
		t.Fatalf("local edit=%q, err=%v", got, err)
	}
}

func TestMarketUpdatesFolderManifestInPlace(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st, cfg: st.config()}
	dir := filepath.Join(a.pluginsDir(), "custom-folder")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	old := `{"id":"team","name":"Team","version":"1.0.0","contributes":{"agents":[{"id":"a","name":"A","prompt":"x"}]}}`
	path := filepath.Join(dir, "plugin.json")
	if err := os.WriteFile(path, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.ReplaceAll(old, "1.0.0", "1.1.0")))
	}))
	defer srv.Close()
	p, err := a.installMarketPlugin(marketEntry{ID: "team", Name: "Team", Version: "1.1.0", URL: srv.URL})
	if err != nil || p.Path != path {
		t.Fatalf("updated plugin=%+v, err=%v", p, err)
	}
	if _, err := os.Stat(filepath.Join(a.pluginsDir(), "team.json")); !os.IsNotExist(err) {
		t.Fatalf("created a competing flat manifest: %v", err)
	}
}

func TestBuiltinPluginExamplesInstallOfflineAndCoverContributions(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st, cfg: st.config()}
	entries := builtinPluginExamples()
	if len(entries) != 3 {
		t.Fatalf("examples=%d, want 3", len(entries))
	}
	keys := map[string]string{}
	for _, binding := range defaultKeybindings() {
		keys[normalizeKey(binding.Key)] = binding.Command
	}
	for _, entry := range entries {
		p, err := a.installMarketPlugin(entry)
		if err != nil {
			t.Fatalf("install %s: %v", entry.ID, err)
		}
		if p.Runtime != litePluginRuntime || p.SchemaVersion != litePluginSchema || len(p.Warnings) != 0 ||
			len(p.Commands) == 0 || len(p.ThemeSpecs) == 0 || len(p.Contributes.Settings) == 0 ||
			len(p.Contributes.Keybindings) == 0 || len(p.Contributes.Hooks) == 0 || len(p.Contributes.Agents) == 0 {
			t.Fatalf("incomplete example %s: %+v", entry.ID, p)
		}
		if _, conflicts := resolvePluginKeybindings(keys, []plugin{p}); len(conflicts) != 0 {
			t.Errorf("example %s has key conflicts: %v", entry.ID, conflicts)
		}
		// Persisted bytes, not normalized copies, are the editable examples.
		raw, err := os.ReadFile(p.Path)
		var saved plugin
		if err != nil || json.Unmarshal(raw, &saved) != nil || saved.ID != entry.ID {
			t.Fatalf("saved example %s=%q, err=%v", entry.ID, raw, err)
		}
	}
	if plugins := a.loadPlugins(nil); len(plugins) != len(entries) {
		t.Fatalf("loaded %d examples, want %d", len(plugins), len(entries))
	}
}
