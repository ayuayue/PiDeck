//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestTranscriptAttachmentFromClosedSession(t *testing.T) {
	var pixel bytes.Buffer
	if err := png.Encode(&pixel, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	data := base64.StdEncoding.EncodeToString(pixel.Bytes())
	path := filepath.Join(t.TempDir(), "session.jsonl")
	body := fmt.Sprintf(`{"type":"session","version":3,"id":"sample","cwd":"test"}
{"type":"message","message":{"role":"user","timestamp":1000,"content":[{"type":"image","data":%q,"mimeType":"image/png"}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"draw","toolName":"draw","timestamp":2000,"content":[{"type":"image","data":%q,"mimeType":"image/png"},{"type":"image","data":"invalid"}]}}
`, data, data)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	turns, err := readSessionTurns(path)
	if err != nil {
		t.Fatal(err)
	}
	messages, _, _ := remoteMessages(turns, 0)
	var refs []string
	for _, m := range messages {
		if m.Image != "" {
			refs = append(refs, m.Image)
		}
	}
	if len(refs) != 2 || refs[0] == refs[1] {
		t.Fatalf("attachment references: %v", refs)
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	var host *remoteHost
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a := newApp(cx)
		s := &session{File: path, loaded: core.NewSignal(cx, false)}
		a.byID["sample"] = s
		host = a.remote
		host.token = "test-token"
		return core.View{}
	})
	handler := host.handler()
	request := func(ref, token string) *httptest.ResponseRecorder {
		t.Helper()
		result := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			q := url.Values{"session": {"sample"}, "ref": {ref}}
			req := httptest.NewRequest(http.MethodGet, "/api/transcript-image?"+q.Encode(), nil)
			req.Header.Set("Authorization", "Bearer "+token)
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)
			result <- res
		}()
		var res *httptest.ResponseRecorder
		screen.WaitUntil(5*time.Second, func() bool {
			select {
			case res = <-result:
				return true
			default:
				return false
			}
		})
		return res
	}
	for _, ref := range refs {
		if res := request(ref, "test-token"); res.Code != http.StatusOK || res.Header().Get("Content-Type") != "image/png" || !bytes.Equal(res.Body.Bytes(), pixel.Bytes()) {
			t.Fatalf("image response: %d %s", res.Code, res.Header().Get("Content-Type"))
		}
	}
	if res := request(refs[0], "wrong"); res.Code != http.StatusUnauthorized {
		t.Fatalf("image without the token: %d", res.Code)
	}
	if res := request("0:-1:-1:5:1000000000", "test-token"); res.Code != http.StatusNotFound {
		t.Fatalf("missing image: %d", res.Code)
	}
}
