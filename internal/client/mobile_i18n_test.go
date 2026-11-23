package client

// Checks the phone follows its language setting.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMobileLanguage(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	for _, lang := range apptext.SupportedLanguages {
		lang := lang
		t.Run(lang, func(t *testing.T) {
			t.Setenv("PIDECK_V2_MOBILE", "1")
			t.Setenv("PIDECK_V2_LANG", lang)
			t.Setenv("PIDECK_V2_HOME", t.TempDir())
			app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
			app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:"+apptext.Catalogs[lang]["连接"])) > 0 })
			app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:"+apptext.Catalogs[lang]["扫码连接"])) > 0 })
		})
	}
}

func TestMobileLanguageSwitchAndRestore(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", dir)
	t.Setenv("PIDECK_V2_LANG", apptext.LangEnUS)
	raw, err := json.Marshal(mobileSaved{Language: apptext.LangJaJP})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "remote.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var mobile *mobileApp
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		mobile = newMobileApp(cx)
		mobile.settingsOpen.Set(true)
		return mobile.view()
	}, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-settings-sheet", 5*time.Second)
	if got := mobile.language.GetUntracked(); got != apptext.LangJaJP {
		t.Fatalf("restored choice = %q, want %q", got, apptext.LangJaJP)
	}
	app.WaitFor("text:"+apptext.Catalogs[apptext.LangJaJP]["外观"], 5*time.Second)
	for _, lang := range apptext.SupportedLanguages {
		app.Press("label:" + apptext.LanguageName(lang))
		app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:"+apptext.T("语言"))) > 0 })
		app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:"+apptext.T("断开连接"))) > 0 })
		if got := mobile.language.GetUntracked(); got != lang {
			t.Fatalf("chosen language = %q, want %q", got, lang)
		}
		raw, err := os.ReadFile(filepath.Join(dir, "remote.json"))
		if err != nil {
			t.Fatal(err)
		}
		var saved mobileSaved
		if err := json.Unmarshal(raw, &saved); err != nil {
			t.Fatal(err)
		}
		if saved.Language != lang {
			t.Fatalf("saved language = %q, want %q", saved.Language, lang)
		}
	}
}

func TestSessionStatsLabel(t *testing.T) {
	if got := sessionStatsLabel(1234, 1234, 128000, 0.02); got != "1k / 128k · $0.02" {
		t.Fatalf("label = %q", got)
	}
	if got := sessionStatsLabel(900, 0, 0, 0); got != "900 tokens" {
		t.Fatalf("tokens only = %q", got)
	}
	if got := sessionStatsLabel(0, 0, 0, 0); got != "" {
		t.Fatalf("empty = %q", got)
	}
}
