package main

// Checks for the language choice, the lookup and the catalogs the
// settings and command palette rely on.

import (
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

// TestResolveLanguage checks the user's choice and the system's.
func TestResolveLanguage(t *testing.T) {
	cases := []struct{ setting, system, want string }{
		{"", "zh-Hans", langZhCN},
		{"", "zh-CN", langZhCN},
		{"", "zh-TW", langZhTW},
		{"", "zh-Hant-HK", langZhTW},
		{"", "en-US", langEnUS},
		{"", "de-DE", langZhCN},
		{"en-US", "zh-CN", langEnUS},
		{"zh-TW", "en-US", langZhTW},
		{"bogus", "en-GB", langEnUS},
	}
	for _, c := range cases {
		if got := resolveLanguage(c.setting, c.system); got != c.want {
			t.Errorf("resolveLanguage(%q, %q) = %q, want %q", c.setting, c.system, got, c.want)
		}
	}
}

// TestT checks translation, fallback and formatting.
func TestT(t *testing.T) {
	defer setUILanguage(langZhCN)
	setUILanguage(langZhCN)
	if got := T("新建会话"); got != "新建会话" {
		t.Errorf("source = %q", got)
	}
	setUILanguage(langEnUS)
	if got := T("新建会话"); got != "New session" {
		t.Errorf("English = %q", got)
	}
	if got := T("没有这条翻译"); got != "没有这条翻译" {
		t.Errorf("fallback = %q", got)
	}
	if got := T("运行中 · %s", "测试"); got != "Running · 测试" {
		t.Errorf("format = %q", got)
	}
	setUILanguage(langZhTW)
	if got := T("新建会话"); got != "新增工作階段" {
		t.Errorf("Traditional = %q", got)
	}
}

// TestCommandTranslations checks every command and group the palette
// shows has both translations.
func TestCommandTranslations(t *testing.T) {
	check := func(kind, text string) {
		for _, lang := range []string{langEnUS, langZhTW} {
			if strings.TrimSpace(messages[lang][text]) == "" {
				t.Errorf("%s %q has no %s translation", kind, text, lang)
			}
		}
	}
	for _, c := range builtinCommands() {
		check("command", c.Label)
		check("group", c.Group)
	}
	for _, s := range settingsSections() {
		check("section", s.Label)
		check("title", s.Title)
		check("summary", s.Summary)
	}
}

// TestLanguageSettingPersists checks the choice reaches config.json.
func TestLanguageSettingPersists(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) { c.Language = langEnUS })
	st2, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := st2.config().Language; got != langEnUS {
		t.Fatalf("language = %q", got)
	}
}

// TestLanguageSwitch checks the settings page changes language at once.
func TestLanguageSwitch(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-general")
	app.WaitFor("id:settings-tab-general", 5*time.Second)
	app.Press("text:English")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:Interface")) > 0 })
	if len(app.Query("text:通用")) != 0 {
		t.Fatal("the Chinese section label is still there after switching to English")
	}
	app.Press("text:简体中文")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:界面")) > 0 })
}
