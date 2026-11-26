//go:build !js && !android && !ios

package workbench

import (
	"reflect"
	"testing"
	"time"
)

func TestComposerTokensUseKnownResources(t *testing.T) {
	files := []string{"note.txt", "src/main.go", "docs/my notes.md", "pkg/@scope/a+b.go"}
	commands := []string{"compact", "skill:review", "explain"}
	cases := []struct {
		text string
		want []string
	}{
		{"/compact", []string{"/compact"}},
		{"  /skill:review @src/main.go", []string{"/skill:review", "@src/main.go"}},
		{"/explain text", []string{"/explain"}},
		{"@\"docs/my notes.md\"，看看 @note.txt。", []string{"@\"docs/my notes.md\"", "@note.txt"}},
		{"(@pkg/@scope/a+b.go)", []string{"@pkg/@scope/a+b.go"}},
		{"/unknown @missing.go", nil},
		{"hello /compact", nil},
		{"/compact;rm", nil},
		{"https://example.com/@note.txt a@note.txt @@note.txt", nil},
		{"`@note.txt` ``@src/main.go``", nil},
		{"```\n@note.txt\n```\n@note.txt", []string{"@note.txt"}},
		{`\@note.txt @note.txt.bak @src/main.go/other`, nil},
	}
	for _, c := range cases {
		t.Run(c.text, func(t *testing.T) {
			var got []string
			for _, token := range composerTokens(c.text, files, commands) {
				got = append(got, c.text[token.start:token.end])
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("tokens = %q, want %q", got, c.want)
			}
		})
	}
}

func TestComposerHighlightPreservesInputAndComposition(t *testing.T) {
	app := composerRegressionApp(t)
	const draft = "看看 @note.txt，邮箱 a@note.txt 和 `@note.txt`。"
	app.Type("id:composer", draft)
	app.Key("tab")
	app.WaitFor("id:composer-highlight", 5*time.Second)
	if got := app.Find("id:composer").Text; got != draft {
		t.Fatalf("highlight changed native text to %q", got)
	}
	if displayed := app.Find("id:composer-highlight").Text; displayed != draft {
		t.Fatalf("highlight text = %q, want unchanged draft", displayed)
	}
	shot(app, "composer/reference-highlight")
	app.Focus("id:composer")
	app.Compose("id:composer", "你好")
	if app.Exists("id:composer-highlight") {
		t.Fatal("the display layer must leave composition to the native input")
	}
	app.Commit("id:composer", "你好")
	app.Key("tab")
	app.WaitFor("id:composer-highlight", 5*time.Second)
}
