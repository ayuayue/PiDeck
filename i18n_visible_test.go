package main

// Checks every visible string the UI files write directly has a
// translation: a label added without one would show Chinese in English.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"unicode"
)

// Check lookup calls as well as direct UI labels. Catalog parity then
// requires every supported language to translate newly introduced text.
func TestTranslationCallsCovered(t *testing.T) {
	entries, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range entries {
		if strings.HasSuffix(path, "_test.go") || path == "i18n.go" {
			continue
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			fn, ok := call.Fun.(*ast.Ident)
			if !ok || (fn.Name != "T" && fn.Name != "setRow" && fn.Name != "setGroup" && fn.Name != "ui" && fn.Name != "core") {
				return true
			}
			args := call.Args[:1]
			if fn.Name == "setRow" && len(call.Args) > 1 {
				args = call.Args[:2]
			}
			if fn.Name == "ui" && len(call.Args) > 0 {
				selector, ok := call.Args[0].(*ast.SelectorExpr)
				if !ok || selector.Sel.Name != "Text" {
					return true
				}
			}
			if fn.Name == "core" && len(call.Args) > 0 {
				selector, ok := call.Args[0].(*ast.SelectorExpr)
				if !ok || selector.Sel.Name != "Text" {
					return true
				}
			}
			for _, arg := range args {
				literal, ok := arg.(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					continue
				}
				text, err := strconv.Unquote(literal.Value)
				if err != nil {
					t.Fatal(err)
				}
				if !strings.ContainsFunc(text, func(r rune) bool { return unicode.Is(unicode.Han, r) }) {
					continue
				}
				for lang, catalog := range messages {
					if strings.TrimSpace(catalog[text]) == "" {
						t.Errorf("%s: %q has no %s translation", fset.Position(literal.Pos()), text, lang)
					}
				}
			}
			return true
		})
	}
}

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
