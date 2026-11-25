//go:build !js && !android && !ios

package workbench

// Importing a theme file: what lands in the themes folder, and what is
// refused without writing anything.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// themeImportFixture writes a theme file outside the themes folder, as a
// file a friend sent would be.
func themeImportFixture(t *testing.T, name, body string) (themes, src string) {
	t.Helper()
	themes, src = t.TempDir(), filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(src, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return themes, src
}

// TestImportThemeCopiesTheLook guards the happy path: the file is copied
// into the themes folder, reads back as the same look, and reports the id
// the app will list it under.
func TestImportThemeCopiesTheLook(t *testing.T) {
	themes, src := themeImportFixture(t, "dusk.yaml", "id: dusk\nname: 黄昏\nappearance: dark\nradius: 6\nlight:\n  accent: '#334455'\ndark:\n  accent: '#aabbcc'\ntokens:\n  shadow: soft\n")
	spec, err := importThemeFile(themes, src)
	if err != nil {
		t.Fatalf("importing a theme: %v", err)
	}
	if spec.Name != "黄昏" {
		t.Errorf("imported name = %q, want 黄昏", spec.Name)
	}
	if spec.ID != "user:dusk" {
		t.Errorf("imported id = %q, want user:dusk", spec.ID)
	}
	if spec.Dark["accent"] != "#aabbcc" {
		t.Errorf("imported look lost its dark accent: %+v", spec.Dark)
	}
	landed := filepath.Join(themes, "dusk.yaml")
	if _, err := os.Stat(landed); err != nil {
		t.Fatalf("the copy is missing: %v", err)
	}
	again, err := parseThemeFile(landed, "dusk")
	if err != nil {
		t.Fatalf("reading the copy: %v", err)
	}
	if again.Tokens["shadow"] != "soft" || again.Radius != 6 {
		t.Errorf("the copy lost what the file said: %+v", again)
	}
}

// TestImportThemeKeepsBothCopies guards importing one name twice: the
// second lands beside the first instead of replacing it.
func TestImportThemeKeepsBothCopies(t *testing.T) {
	themes, src := themeImportFixture(t, "dusk.yaml", "name: 黄昏\nlight:\n  accent: '#334455'\n")
	for i := 0; i < 2; i++ {
		if _, err := importThemeFile(themes, src); err != nil {
			t.Fatalf("import %d: %v", i+1, err)
		}
	}
	entries, err := os.ReadDir(themes)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("themes folder holds %d files; want 2", len(entries))
	}
}

// TestImportThemeRefusesWhatIsNotOne guards the refusals: a file the app
// cannot read as a look never lands in the folder.
func TestImportThemeRefusesWhatIsNotOne(t *testing.T) {
	for _, c := range []struct {
		name, body string
		want       error
	}{
		{"notes.txt", "light:\n  accent: '#112233'\n", errThemeKind},
		{"empty.json", "", errThemeEmpty},
		{"odd.json", `{"hello": "world"}`, errThemeBlank},
		{"broken.yaml", "light: [oops\n", nil},
		{"huge.json", strings.Repeat("x", maxThemeFile+1), errThemeLarge},
	} {
		themes, src := themeImportFixture(t, c.name, c.body)
		_, err := importThemeFile(themes, src)
		if err == nil {
			t.Errorf("%s was imported; want a refusal", c.name)
			continue
		}
		if c.want != nil && err != c.want {
			t.Errorf("%s refused with %v; want %v", c.name, err, c.want)
		}
		if entries, _ := os.ReadDir(themes); len(entries) != 0 {
			t.Errorf("%s left %d files in the themes folder", c.name, len(entries))
		}
	}
}

// TestThemeImportErrorSaysWhy guards the words a refusal shows: each cause
// has its own sentence, and a cause of its own falls through to the error.
func TestThemeImportErrorSaysWhy(t *testing.T) {
	if got := themeImportError(errThemeKind); !strings.Contains(got, ".json") {
		t.Errorf("the kind refusal = %q; want the extensions named", got)
	}
	if got := themeImportError(errThemeBlank); got == "" {
		t.Error("the blank refusal says nothing")
	}
}
