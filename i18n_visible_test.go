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
)

func TestVisibleStringsTranslated(t *testing.T) {
	entries, err := filepath.Glob("ui_*.go")
	if err != nil {
		t.Fatal(err)
	}
	entries = append(entries, "mobile.go", "mobile_git.go")
	en := messages[langEnUS]
	for _, path := range entries {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(raw)
		for _, re := range []*regexp.Regexp{visibleText, visibleCore} {
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
