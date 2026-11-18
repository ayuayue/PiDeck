//go:build !js && !android && !ios

package apptext

// Checks for the language choice, the lookup and the catalogs the
// settings and command palette rely on.

import (
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// TestResolveLanguage checks the user's choice and the system's.
func TestResolveLanguage(t *testing.T) {
	cases := []struct{ setting, system, want string }{
		{"", "zh-Hans", LangZhCN},
		{"", "zh-CN", LangZhCN},
		{"", "zh-TW", LangZhTW},
		{"", "zh-Hant-HK", LangZhTW},
		{"", "en-US", LangEnUS},
		{"", "de-DE", LangZhCN},
		{"en-US", "zh-CN", LangEnUS},
		{"zh-TW", "en-US", LangZhTW},
		{"bogus", "en-GB", LangEnUS},
		{"", "zh_TW.UTF-8", LangZhTW},
		{"", "zh-HK", LangZhTW},
		{"", "zh-MO", LangZhTW},
		{"", "zh-Hans-HK", LangZhCN},
		{"", "zh-Hant-CN", LangZhTW},
		{"", "ko-KR", LangKoKR},
		{"", "ko", LangKoKR},
		{"", "ja_JP.UTF-8", LangJaJP},
		{"", "ru_RU.UTF-8", LangRuRU},
		{"", " FR-ca ", LangFrFR},
		{"", "fr_FR@euro", LangFrFR},
		{"", "english", LangZhCN},
	}
	for _, lang := range SupportedLanguages {
		cases = append(cases, struct{ setting, system, want string }{lang, "de-DE", lang})
	}
	for _, c := range cases {
		if got := ResolveLanguage(c.setting, c.system); got != c.want {
			t.Errorf("resolveLanguage(%q, %q) = %q, want %q", c.setting, c.system, got, c.want)
		}
	}
}

// TestT checks translation, fallback and formatting.
func TestT(t *testing.T) {
	defer SetLanguage(LangZhCN)
	SetLanguage(LangZhCN)
	if got := T("新建会话"); got != "新建会话" {
		t.Errorf("source = %q", got)
	}
	SetLanguage(LangEnUS)
	if got := T("新建会话"); got != "New session" {
		t.Errorf("English = %q", got)
	}
	if got := T("没有这条翻译"); got != "没有这条翻译" {
		t.Errorf("fallback = %q", got)
	}
	if got := T("运行中 · %s", "测试"); got != "Running · 测试" {
		t.Errorf("format = %q", got)
	}
	staticPercent := "0% 完全遮住图片，100% 完全显示；面板会一起变透明。"
	if got := T(staticPercent, "ignored"); strings.Contains(got, "%!") {
		t.Errorf("literal percent = %q", got)
	}
	SetLanguage(LangZhTW)
	if got := T("新建会话"); got != "新增工作階段" {
		t.Errorf("Traditional = %q", got)
	}
}

// TestLanguageCatalogCoverage checks every catalog has the same source
// messages, without empty values or broken formatting placeholders.
func TestLanguageCatalogCoverage(t *testing.T) {
	format := regexp.MustCompile(`%(?:\[[0-9]+\])?[-+#0]*(?:[0-9]+|\*)?(?:\.(?:[0-9]+|\*))?(?:\[[0-9]+\])?[bcdeEfFgGopqstTUVwxX%]`)
	for _, lang := range SupportedLanguages {
		if lang == LangZhCN {
			continue
		}
		t.Run(lang, func(t *testing.T) {
			catalog, ok := Catalogs[lang]
			if !ok {
				t.Fatal("no message catalog")
			}
			for _, other := range Catalogs {
				var missing []string
				for key := range other {
					if strings.TrimSpace(catalog[key]) == "" {
						missing = append(missing, key)
					}
				}
				sort.Strings(missing)
				if len(missing) > 0 {
					t.Fatalf("%d missing entries: %q", len(missing), missing[:min(len(missing), 12)])
				}
			}
			for key, text := range catalog {
				want := format.FindAllString(key, -1)
				if got := format.FindAllString(text, -1); !reflect.DeepEqual(got, want) {
					t.Errorf("%q placeholders = %v, want %v", key, got, want)
				}
			}
		})
	}
}

func TestNewLanguageTranslations(t *testing.T) {
	t.Cleanup(func() { SetLanguage(LangZhCN) })
	for _, c := range []struct{ code, session, running string }{
		{LangKoKR, "새 세션", "실행 중 · pi"},
		{LangJaJP, "新しいセッション", "実行中 · pi"},
		{LangRuRU, "Новая сессия", "Выполняется · pi"},
		{LangFrFR, "Nouvelle session", "En cours · pi"},
	} {
		SetLanguage(c.code)
		if got := T("新建会话"); got != c.session {
			t.Errorf("%s new session = %q", c.code, got)
		}
		if got := T("运行中 · %s", "pi"); got != c.running {
			t.Errorf("%s formatted = %q", c.code, got)
		}
		if got := T("0% 完全遮住图片，100% 完全显示；面板会一起变透明。", 0); strings.Contains(got, "%!") {
			t.Errorf("%s formatted literal percent = %q", c.code, got)
		}
	}
}
