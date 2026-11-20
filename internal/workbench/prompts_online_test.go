package workbench

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOnlinePromptSources(t *testing.T) {
	pack, err := parseCommunityPrompts([]byte("act,prompt,for_devs\nWriter,\"Write a story, please\",FALSE\n"))
	if err != nil || len(pack.Prompts) != 1 || pack.Prompts[0].Body != "Write a story, please" {
		t.Fatalf("CSV: %+v %v", pack, err)
	}
	if _, err := parseCommunityPrompts([]byte("name,unknown\na,b")); err == nil {
		t.Fatal("accepted invalid CSV")
	}
	source := filepath.Join(t.TempDir(), "source.db")
	createSQLite(t, source, `CREATE TABLE xueprompts (title TEXT,content TEXT,category TEXT)`, `INSERT INTO xueprompts VALUES ('测试','实际提示词','编程')`)
	raw, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	checksum := fmt.Sprintf("%x", sha256.Sum256(raw))
	bad := false
	downloads := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/xueprompts.db.sha256" {
			fmt.Fprint(w, checksum+" xueprompts.db")
			return
		}
		downloads++
		if bad {
			w.Write([]byte("corrupt"))
			return
		}
		w.Write(raw)
	}))
	defer srv.Close()
	cache := filepath.Join(t.TempDir(), "cache", "prompts.db")
	for range 2 {
		pack, err := fetchChinesePrompts(t.Context(), srv.URL, cache)
		if err != nil || len(pack.Prompts) != 1 || pack.Prompts[0].Body != "实际提示词" {
			t.Fatalf("Chinese library: %+v %v", pack, err)
		}
	}
	if downloads != 1 {
		t.Fatalf("same checksum downloaded %d times", downloads)
	}
	checksum = fmt.Sprintf("%x", sha256.Sum256([]byte("changed")))
	bad = true
	if _, err := fetchChinesePrompts(t.Context(), srv.URL, cache); err == nil {
		t.Fatal("accepted corrupt source")
	}
	if pack, err := readChinesePrompts(t.Context(), cache); err != nil || len(pack.Prompts) != 1 {
		t.Fatalf("last valid cache lost: %v", err)
	}
}

func TestChinesePromptCompressedContent(t *testing.T) {
	compress := func(text string) []byte {
		var out bytes.Buffer
		writer := gzip.NewWriter(&out)
		if _, err := writer.Write([]byte(text)); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		return out.Bytes()
	}
	for _, body := range [][]byte{[]byte("实际中文提示词"), compress("实际中文提示词")} {
		if got := chinesePromptContent(body); got != "实际中文提示词" {
			t.Fatalf("decoded content=%q", got)
		}
	}
	for _, body := range [][]byte{{0xff}, {0x1f, 0x8b, 0}, compress(strings.Repeat("x", (64<<10)+1))} {
		if got := chinesePromptContent(body); got != "" {
			t.Fatalf("accepted invalid or oversized content: %d bytes", len(got))
		}
	}
}
