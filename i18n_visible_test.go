package main

// Checks every visible string the UI files write directly has a
// translation: a label added without one would show Chinese in English.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var (
	visibleText = regexp.MustCompile(`ui\.Text\("([^"\n]*[\p{Han}][^"\n]*)"`)
	visibleCore = regexp.MustCompile(`core\.Text\{Content: "([^"\n]*[\p{Han}][^"\n]*)"`)
	// A field written straight, without T, shows Chinese in English too.
	visibleField = regexp.MustCompile(`(?:Text|Label|Placeholder|Title|Description):\s*"([^"\n]*\p{Han}[^"\n]*)"`)
)

func TestVisibleStringsTranslated(t *testing.T) {
	entries, err := filepath.Glob("ui_*.go")
	if err != nil {
		t.Fatal(err)
	}
	mobile, err := filepath.Glob("mobile*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range mobile {
		if !strings.HasSuffix(path, "_test.go") {
			entries = append(entries, path)
		}
	}
	en := messages[langEnUS]
	for _, path := range entries {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(raw)
		for _, re := range []*regexp.Regexp{visibleText, visibleCore, visibleField} {
			for _, m := range re.FindAllStringSubmatch(text, -1) {
				key := m[1]
				if strings.TrimSpace(en[key]) == "" {
					t.Errorf("%s shows %q without an en-US translation", path, key)
				}
			}
		}
	}
}

var toastTitle = regexp.MustCompile(`a\.toast(?:Action)?\(ui\.Toast\w+, "([^"\n]*\p{Han}[^"\n]*)"`)

func TestToastTitlesTranslated(t *testing.T) {
	entries, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	en := messages[langEnUS]
	for _, path := range entries {
		if strings.HasSuffix(path, "_test.go") || path == "i18n.go" {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range toastTitle.FindAllStringSubmatch(string(raw), -1) {
			key := m[1]
			if strings.HasSuffix(key, " ") {
				continue // a prefix the caller completes
			}
			if strings.TrimSpace(en[key]) == "" {
				t.Errorf("%s toasts %q without an en-US translation", path, key)
			}
		}
	}
}

var toastDetail = regexp.MustCompile(`a\.toast(?:Action)?\(ui\.Toast\w+, "[^"\n]*", "([^"\n]*\p{Han}[^"\n]*)"`)

func TestToastDetailsTranslated(t *testing.T) {
	entries, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	en := messages[langEnUS]
	for _, path := range entries {
		if strings.HasSuffix(path, "_test.go") || path == "i18n.go" {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range toastDetail.FindAllStringSubmatch(string(raw), -1) {
			key := m[1]
			if strings.TrimSpace(key) == "" || strings.HasSuffix(key, " ") {
				continue
			}
			if strings.TrimSpace(en[key]) == "" {
				t.Errorf("%s toasts %q without an en-US translation", path, key)
			}
		}
	}
}
