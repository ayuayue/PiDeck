//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/base/textview"
	"github.com/nsgo-dev/nsgo/core"
)

func TestChatReferenceRecognition(t *testing.T) {
	files := []string{"README.md", "note.txt", "src/main.go", "pkg/@scope/a+b.go"}
	cases := []struct {
		text string
		want []string
	}{
		{"See src/main.go:12:3, README.md.", []string{"src/main.go", "README.md"}},
		{"见 `src/main.go#L12`。", []string{"src/main.go"}},
		{`见 C:\work\project\main.go:7。`, []string{`C:\work\project\main.go`}},
		{"See `/tmp/my project/main.go`.", []string{"/tmp/my project/main.go"}},
		{"See `C:\\work\\my project\\main.go`.", []string{`C:\work\my project\main.go`}},
		{"[source](src/main.go:3) [docs](https://example.com/a?q=1#part)", []string{"src/main.go", "https://example.com/a?q=1#part"}},
		{"(https://example.com/docs_(test)).", []string{"https://example.com/docs_(test)"}},
		{"www.example.com/help", []string{"http://www.example.com/help"}},
		{"pkg/@scope/a+b.go", []string{"pkg/@scope/a+b.go"}},
		{"/compact /skill:review @README.md user@example.com a/b 1/2", nil},
		{"[bad](javascript:alert) [mail](mailto:user@example.com)", nil},
		{"```go\n// src/main.go\n```", nil},
		{"`x := a / b`", nil},
		{"[remote](smb://host/share/a.go)", nil},
		{"[remote](file://host/share/a.go)", nil},
		{"[bad](file:///tmp/a%0Ab.go)", nil},
	}
	for _, c := range cases {
		t.Run(c.text, func(t *testing.T) {
			doc := chatReferenceDocument(c.text, files)
			var got []string
			var collect func([]textview.Inline)
			collect = func(in []textview.Inline) {
				for _, n := range in {
					if custom, ok := n.(textview.Custom); ok {
						if ref, ok := custom.Data.(chatReference); ok {
							got = append(got, ref.target)
						}
					}
				}
			}
			for _, block := range doc.Blocks {
				if p, ok := block.(textview.Paragraph); ok {
					collect(p.Content)
				}
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("targets = %q, want %q", got, c.want)
			}
			if want := textview.Parse(c.text).PlainText(); doc.PlainText() != want {
				t.Fatalf("visible text changed from %q to %q", want, doc.PlainText())
			}
		})
	}
}

func TestChatFileLocation(t *testing.T) {
	for _, raw := range []string{"src/main.go:12:3", "src/main.go:12", "src/main.go#L12"} {
		path, line := chatFileLocation(raw)
		if path != "src/main.go" || line != 12 {
			t.Errorf("location(%q) = %q:%d", raw, path, line)
		}
	}
}

func TestChatReferenceClickRouting(t *testing.T) {
	a, screen, s := chatDesignFixture(t, 0)
	const target = "https://example.com/docs?q=1#part"
	screen.Post(func() {
		s.turns.Update(func(turns []turn) []turn {
			out := append([]turn(nil), turns...)
			out[0].Final = "[open documentation](" + target + ")"
			return out
		})
	})
	screen.WaitFor("text:open documentation", 5*time.Second)
	screen.PressWith("text:open documentation", core.Modifiers{Control: true})
	if !reflect.DeepEqual(screen.OpenedURLs, []string{target}) {
		t.Fatalf("Ctrl+click external URLs = %q", screen.OpenedURLs)
	}
	screen.Press("text:open documentation")
	screen.WaitFor("id:browser-webview", 5*time.Second)
	if got := a.browser.source.GetUntracked().Src; got != target {
		t.Fatalf("built-in browser = %q, want %q", got, target)
	}
	if len(screen.OpenedURLs) != 1 {
		t.Fatal("ordinary click also opened an external browser")
	}
}

func TestChatReferenceOpensAbsoluteFilePreview(t *testing.T) {
	a, screen, s := chatDesignFixture(t, 0)
	path := filepath.Join(t.TempDir(), "outside project.md")
	if err := os.WriteFile(path, []byte("# External file preview"), 0o600); err != nil {
		t.Fatal(err)
	}
	screen.Post(func() {
		a.openChatReference(s, chatReference{target: path}, core.PressEvent{})
	})
	screen.WaitFor("text:External file preview", 5*time.Second)
}
