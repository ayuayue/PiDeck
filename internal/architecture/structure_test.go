// Package architecture checks source boundaries on every host, including files
// excluded from that host's build. New packages need an explicit dependency rule.
package architecture

import (
	"go/ast"
	"go/build/constraint"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

const module = "example.com/pideck-v2/"

// Dependencies point from application hosts toward smaller reusable packages.
// Tests follow the same rule so a test helper cannot reconnect isolated hosts.
var dependencies = map[string][]string{
	".":                      {"internal/client", "internal/crashlog", "internal/workbench", "locales"},
	"assets":                 {},
	"extensions":             {},
	"locales":                {},
	"webassets":              {},
	"scripts":                {},
	"cmd/pideck-relay":       {"internal/relay"},
	"internal/alerts":        {"assets"},
	"internal/architecture":  {},
	"internal/appinfo":       {},
	"internal/apptext":       {},
	"internal/officedoc":     {},
	"internal/crashlog":      {"internal/appinfo"},
	"internal/relaywire":     {},
	"internal/relay":         {"internal/relaywire"},
	"internal/remotewire":    {},
	"internal/schedule":      {},
	"internal/sessionimport": {"internal/apptext"},
	"internal/viewkit":       {"internal/apptext"},
	"internal/volcvoice":     {},
	"internal/client": {
		"assets", "internal/alerts", "internal/appinfo", "internal/apptext", "internal/relaywire", "internal/remotewire", "internal/viewkit",
	},
	"internal/workbench": {
		"assets", "extensions", "webassets", "internal/alerts", "internal/appinfo", "internal/apptext",
		"internal/crashlog", "internal/officedoc", "internal/relaywire", "internal/remotewire", "internal/schedule",
		"internal/sessionimport", "internal/viewkit", "internal/volcvoice",
	},
}

type source struct {
	path, dir string
	raw       []byte
	file      *ast.File
}

func sources(t *testing.T) []source {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate architecture tests")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	var out []source
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if entry.IsDir() {
			if entry.Name() == ".nsgo" {
				return fs.SkipDir // generated tooling, including caches beside TSX examples
			}
			switch rel {
			case ".git", "dist", "webassets/site":
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		file, err := parser.ParseFile(token.NewFileSet(), rel, raw, parser.ImportsOnly)
		if err != nil {
			return err
		}
		out = append(out, source{rel, filepath.ToSlash(filepath.Dir(rel)), raw, file})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDependencyLayers(t *testing.T) {
	for _, src := range sources(t) {
		allowed, ok := dependencies[src.dir]
		if !ok {
			t.Errorf("%s: add an explicit package boundary to dependencies and ARCHITECTURE.md", src.path)
			continue
		}
		for _, imp := range src.file.Imports {
			path, err := strconv.Unquote(imp.Path.Value)
			if err != nil {
				t.Fatal(err)
			}
			if strings.HasPrefix(path, module) {
				dep := strings.TrimPrefix(path, module)
				if dep != src.dir && !contains(allowed, dep) {
					t.Errorf("%s: %s must not depend on %s", src.path, src.dir, dep)
				}
			}
			if (src.dir == "internal/remotewire" || src.dir == "internal/schedule" ||
				src.dir == "internal/sessionimport" || src.dir == "internal/apptext") &&
				strings.HasPrefix(path, "github.com/nsgo-dev/nsgo") {
				t.Errorf("%s: data and parsing packages must not import the UI framework", src.path)
			}
			if src.dir == "internal/client" && (strings.HasPrefix(path, "github.com/nsgo-dev/nsgo/desktop") ||
				strings.HasPrefix(path, "modernc.org/") || path == "os/exec") {
				t.Errorf("%s: client must use the remote API for desktop services (%s)", src.path, path)
			}
		}
	}
}

func TestDesktopBuildConstraints(t *testing.T) {
	for _, src := range sources(t) {
		if src.dir != "internal/workbench" && src.dir != "internal/sessionimport" {
			continue
		}
		// Workbench tests belong to a package that has many production files;
		// the Go tool ignores the directory when those files are excluded.
		// Every sessionimport source is desktop-only, so an untagged test would
		// make web and mobile vet see a package whose declarations are absent.
		if src.dir == "internal/workbench" && strings.HasSuffix(src.path, "_test.go") {
			continue
		}
		var expr constraint.Expr
		for _, line := range strings.Split(string(src.raw), "\n") {
			if strings.HasPrefix(line, "//go:build ") {
				var err error
				expr, err = constraint.Parse(line)
				if err != nil {
					t.Fatalf("%s: %v", src.path, err)
				}
				break
			}
		}
		if expr == nil {
			t.Errorf("%s: desktop source needs //go:build !js && !android && !ios", src.path)
			continue
		}
		for _, target := range []string{"js", "android", "ios"} {
			if expr.Eval(func(tag string) bool { return tag == target || tag == "webassets" }) {
				t.Errorf("%s: desktop code is enabled on %s", src.path, target)
			}
		}
	}
}

func TestSourceFileSize(t *testing.T) {
	for _, src := range sources(t) {
		limit := 800
		if strings.HasSuffix(src.path, "_test.go") {
			limit = 1000
		}
		lines := strings.Count(string(src.raw), "\n")
		if lines > limit {
			t.Errorf("%s: %d lines exceeds %d; split by responsibility within the package", src.path, lines, limit)
		}
		if src.dir == "." && !strings.HasSuffix(src.path, "_test.go") &&
			!contains([]string{"main.go", "root_desktop.go", "root_client.go"}, src.path) {
			t.Errorf("%s: keep application logic in internal/, root is only bootstrap", src.path)
		}
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
