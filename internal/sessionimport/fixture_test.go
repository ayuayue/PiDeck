//go:build !js && !android && !ios

package sessionimport

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

type testImport struct{ File, Cwd, Title string }

func importFixture(t *testing.T, source *Source, dir, name, body, cwd string) testImport {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(dir, name)
	if err := os.WriteFile(input, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
	parsed, err := source.Read(input)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Cwd != "" {
		cwd = parsed.Cwd
	}
	output := filepath.Join(t.TempDir(), "import.jsonl")
	f, err := os.Create(output)
	if err != nil {
		t.Fatal(err)
	}
	title := DisplayTitle(*source, firstNonEmpty(parsed.Title, FirstUserText(parsed.Messages)))
	err = WritePiSession(f, "fixture1234567890", filepath.Clean(cwd), title, time.Now(), parsed, *source,
		Candidate{Source: source.Key, ID: name, Path: input})
	closeErr := f.Close()
	if err != nil {
		t.Fatal(err)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	return testImport{File: output, Cwd: cwd, Title: title}
}

func importText(t *testing.T, file string) string {
	t.Helper()
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
