//go:build !js && !android && !ios

package workbench

// Checks for file previews: which kind a file opens in, how a document's
// pictures are resolved, and a Markdown file driven through the window.

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestFilePreviewKinds checks the extension table.
func TestFilePreviewKinds(t *testing.T) {
	cases := map[string]string{
		"a.csv":          previewTable,
		"b.TSV":          previewTable,
		"README.md":      previewMarkdown,
		"docs/page.html": previewHTML,
		"paper.PDF":      previewPDF,
		"shot.png":       previewImage,
		"icon.svg":       previewImage,
		"voice.mp3":      previewAudio,
		"clip.mp4":       previewVideo,
		"report.docx":    previewDocx,
		"book.xlsx":      previewXLSX,
		"old.doc":        previewOffice,
		"deck.pptx":      previewOffice,
		"bundle.zip":     previewBinary,
		"main.go":        "",
		"notes.txt":      "",
		"no-extension":   "",
	}
	for path, want := range cases {
		if got := filePreviewKind(path); got != want {
			t.Errorf("filePreviewKind(%q) = %q, want %q", path, got, want)
		}
	}
}

// TestResolvePreviewImages checks a document's pictures point at its own
// directory, while the ones that need no help stay as they are.
func TestResolvePreviewImages(t *testing.T) {
	dir := filepath.FromSlash("/w/docs")
	cases := map[string]string{
		"![a](shot.png)":                  "![a](" + fileURL(filepath.Join(dir, "shot.png")) + ")",
		`<img src="img/a.png">`:           `<img src="` + fileURL(filepath.Join(dir, "img/a.png")) + `">`,
		"![a](https://e.com/a.png)":       "![a](https://e.com/a.png)",
		"![a](data:image/png;base64,AAA)": "![a](data:image/png;base64,AAA)",
		"![a](#anchor)":                   "![a](#anchor)",
		"![a](/root/a.png)":               "![a](/root/a.png)",
	}
	for body, want := range cases {
		if got := resolvePreviewImages(body, dir); got != want {
			t.Errorf("resolvePreviewImages(%q) = %q, want %q", body, got, want)
		}
	}
}

// TestSizeText checks the sizes the file information shows.
func TestSizeText(t *testing.T) {
	cases := map[int64]string{
		0:       "0 B",
		999:     "999 B",
		2048:    "2 KB",
		3 << 20: "3.0 MB",
		5 << 30: "5.0 GB",
	}
	for size, want := range cases {
		if got := sizeText(size); got != want {
			t.Errorf("sizeText(%d) = %q, want %q", size, got, want)
		}
	}
}

// TestPreviewReadXLSX checks a workbook's first sheet becomes a table, and
// that a file which is not one says so.
func TestPreviewReadXLSX(t *testing.T) {
	sheet := `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>7</v></c></row>
<row r="2"><c r="A2"><v>9</v></c></row>
</sheetData></worksheet>`
	shared := `<sst><si><t>Name</t></si></sst>`
	var buf bytes.Buffer
	archive := zip.NewWriter(&buf)
	for name, body := range map[string]string{
		"xl/sharedStrings.xml":     shared,
		"xl/worksheets/sheet1.xml": sheet,
	} {
		f, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "book.xlsx")
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	rows, columns, limited, err := readXLSXPreview(path)
	if err != nil {
		t.Fatal(err)
	}
	if columns != 2 || limited || len(rows) != 2 {
		t.Fatalf("sheet = %d columns, %d rows, limited %v", columns, len(rows), limited)
	}
	if strings.Join(rows[0], "|") != "Name|7" || strings.Join(rows[1], "|") != "9" {
		t.Errorf("rows = %q", rows)
	}

	broken := filepath.Join(t.TempDir(), "broken.xlsx")
	if err := os.WriteFile(broken, []byte("not a workbook"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := readXLSXPreview(broken); err == nil || !strings.Contains(err.Error(), "打不开") {
		t.Errorf("error = %v, want a readable refusal", err)
	}
}

// TestFilePreviewMarkdownInWindow opens a Markdown file from the drawer and
// checks the dialog renders it, then hands it to the editor.
func TestFilePreviewMarkdownInWindow(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := editorWorkspace(t)
	// startApp's picker flow waits for this file, which proves the folder
	// listed.
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# 标题\n\n正文段落。\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := startApp(t, dir, 1280, 860)
	app.Key("mod+j")
	app.WaitFor("id:drawer-tab-files", 5*time.Second)
	app.Press("id:drawer-tab-files")
	app.WaitFor("text:README.md", 5*time.Second)
	app.Press("text:README.md")
	app.WaitFor("id:file-preview", 5*time.Second)
	app.WaitFor("text:正文段落。", 5*time.Second)
	if len(app.Query("id:editor")) != 0 {
		t.Fatal("a Markdown file opened in the editor instead of its preview")
	}
	app.Press("id:preview-edit-text")
	app.WaitFor("id:editor", 5*time.Second)
}

// TestPreviewIsASplitPane checks a preview shows in the work area as a tab
// beside the sessions, not in a dialog over them.
func TestPreviewIsASplitPane(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# 标题\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := startApp(t, dir, 1280, 860)
	app.Key("mod+j")
	app.WaitFor("id:drawer-tab-files", 5*time.Second)
	app.Press("id:drawer-tab-files")
	app.WaitFor("text:README.md", 5*time.Second)
	app.Press("text:README.md")
	app.WaitFor("id:file-preview", 5*time.Second)
	app.Find("id:pane-tab-preview")
	app.Press("id:pane-tab-close-preview")
	app.WaitForGone("id:file-preview", 5*time.Second)
}

// TestChangedFileShowsItsPatch checks a file a turn changed opens as what
// changed in it, in the diff pane rather than the editor.
func TestChangedFileShowsItsPatch(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, run := gitFixture(t)
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("hello world\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "changed by a turn")

	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		return a.paneView()
	}, nsgotest.Size(1200, 800))
	a.openChangedFile(&session{WS: dir}, "note.txt")
	screen.WaitFor("id:git-diff", 10*time.Second)
	screen.WaitUntil(10*time.Second, func() bool {
		return strings.Contains(a.gitDiffPatch.Get(), "+hello world")
	})
	if len(screen.Query("id:editor")) != 0 {
		t.Fatal("a changed file opened in the editor instead of the diff pane")
	}
}
