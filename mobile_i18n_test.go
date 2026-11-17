package main

// Checks the phone follows its language setting.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMobileLanguage(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Cleanup(func() { setUILanguage(langZhCN) })
	for _, lang := range supportedLanguages {
		lang := lang
		t.Run(lang, func(t *testing.T) {
			t.Setenv("PIDECK_LITE_MOBILE", "1")
			t.Setenv("PIDECK_LITE_LANG", lang)
			t.Setenv("PIDECK_LITE_HOME", t.TempDir())
			app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
			app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:"+messages[lang]["连接"])) > 0 })
			app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:"+messages[lang]["扫码连接"])) > 0 })
		})
	}
}

func TestMobileLanguageSwitchAndRestore(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Cleanup(func() { setUILanguage(langZhCN) })
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", dir)
	t.Setenv("PIDECK_LITE_LANG", langEnUS)
	raw, err := json.Marshal(mobileSaved{Language: langJaJP})
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
	if got := mobile.language.GetUntracked(); got != langJaJP {
		t.Fatalf("restored choice = %q, want %q", got, langJaJP)
	}
	app.WaitFor("text:"+messages[langJaJP]["外观"], 5*time.Second)
	for _, lang := range supportedLanguages {
		app.Press("label:" + languageName(lang))
		app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:"+T("语言"))) > 0 })
		app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:"+T("断开连接"))) > 0 })
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
