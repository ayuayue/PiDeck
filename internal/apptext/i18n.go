package apptext

// The interface's language. Messages are written in Chinese and looked up
// by that text, so a missing translation falls back to the source rather
// than to a key name; new screens can be added first and translated
// later. Plugins bring their own words and stay as they are.

import (
	"embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// Languages the app ships with.
const (
	LangSystem = ""
	LangZhCN   = "zh-CN"
	LangZhTW   = "zh-TW"
	LangEnUS   = "en-US"
	LangKoKR   = "ko-KR"
	LangJaJP   = "ja-JP"
	LangRuRU   = "ru-RU"
	LangFrFR   = "fr-FR"
)

// supportedLanguages is shared by the desktop and mobile language pickers.
var SupportedLanguages = []string{LangZhCN, LangEnUS, LangZhTW, LangKoKR, LangJaJP, LangRuRU, LangFrFR}

func SupportedLanguage(code string) bool {
	for _, lang := range SupportedLanguages {
		if lang == code {
			return true
		}
	}
	return false
}

var (
	uiLangMu        sync.RWMutex
	uiLang          = LangZhCN
	formatDirective = regexp.MustCompile(`%(?:\[[0-9]+\])?[-+#0]*(?:[0-9]+|\*)?(?:\.(?:[0-9]+|\*))?(?:\[[0-9]+\])?[bcdeEfFgGopqstTUVwxX]`)
)

// setUILanguage makes code the language T reads.
func SetLanguage(code string) {
	uiLangMu.Lock()
	uiLang = code
	uiLangMu.Unlock()
}

// currentUILanguage is the language T reads now.
func CurrentLanguage() string {
	uiLangMu.RLock()
	defer uiLangMu.RUnlock()
	return uiLang
}

// T says a message in the interface's language. The message is the
// source text; a translation replaces it, then args are formatted.
func T(message string, args ...any) string {
	uiLangMu.RLock()
	lang := uiLang
	uiLangMu.RUnlock()
	if table, ok := Catalogs[lang]; ok {
		if s, ok := table[message]; ok {
			message = s
		}
	}
	if len(args) == 0 || !formatDirective.MatchString(message) {
		return message
	}
	return fmt.Sprintf(message, args...)
}

// resolveLanguage picks the language to show: the user's choice, else the
// system's, else Chinese.
func ResolveLanguage(setting, system string) string {
	if SupportedLanguage(setting) {
		return setting
	}
	// Accept BCP 47 and POSIX locales, including zh_TW.UTF-8 and fr_CA.
	s := strings.ToLower(strings.TrimSpace(system))
	s = strings.ReplaceAll(s, "_", "-")
	s, _, _ = strings.Cut(s, ".")
	base, _, _ := strings.Cut(s, "-")
	base, _, _ = strings.Cut(base, "@")
	switch base {
	case "zh":
		// An explicit script takes precedence over the region.
		if strings.Contains(s, "hans") {
			return LangZhCN
		}
		if strings.Contains(s, "hant") || strings.Contains(s, "traditional") {
			return LangZhTW
		}
		for _, part := range strings.Split(s, "-")[1:] {
			part, _, _ = strings.Cut(part, "@")
			if part == "tw" || part == "hk" || part == "mo" {
				return LangZhTW
			}
		}
		return LangZhCN
	case "en":
		return LangEnUS
	case "ko":
		return LangKoKR
	case "ja":
		return LangJaJP
	case "ru":
		return LangRuRU
	case "fr":
		return LangFrFR
	}
	return LangZhCN
}

// languageName is a language's name in itself.
func LanguageName(code string) string {
	switch code {
	case LangSystem:
		return T("跟随系统")
	case LangZhTW:
		return "繁體中文"
	case LangEnUS:
		return "English"
	case LangKoKR:
		return "한국어"
	case LangJaJP:
		return "日本語"
	case LangRuRU:
		return "Русский"
	case LangFrFR:
		return "Français"
	}
	return "简体中文"
}

// New catalogs are embedded so every target works offline.
//
//go:embed locales/*.json
var localeCatalogs embed.FS

func readMessageCatalog(code string) map[string]string {
	raw, err := localeCatalogs.ReadFile("locales/" + code + ".json")
	if err != nil {
		panic(err)
	}
	var catalog map[string]string
	if err := json.Unmarshal(raw, &catalog); err != nil {
		panic(fmt.Errorf("language %s: %w", code, err))
	}
	return catalog
}

// Catalogs contains translations indexed by source text. Simplified Chinese is
// the source language and needs no table. Treat these embedded maps as read-only.
var Catalogs = map[string]map[string]string{
	LangEnUS: readMessageCatalog(LangEnUS),
	LangZhTW: readMessageCatalog(LangZhTW),
	LangKoKR: readMessageCatalog(LangKoKR),
	LangJaJP: readMessageCatalog(LangJaJP),
	LangRuRU: readMessageCatalog(LangRuRU),
	LangFrFR: readMessageCatalog(LangFrFR),
}
