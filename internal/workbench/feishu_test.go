//go:build !js && !android && !ios

package workbench

// Checks for the Feishu bot: the signature and the webhook call.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestFeishuSign checks the signature against a fixed vector.
func TestFeishuSign(t *testing.T) {
	want := "fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA="
	if got := feishuSign("secret", 1700000000); got != want {
		t.Fatalf("sign = %q, want %q", got, want)
	}
	if feishuSign("other", 1700000000) == want {
		t.Fatal("a different secret gave the same signature")
	}
}

// TestSendFeishu checks the request and the two answers.
func TestSendFeishu(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s", r.Method)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("body: %v", err)
		}
		_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
	}))
	defer srv.Close()
	if err := sendFeishu(srv.URL, "secret", "hello"); err != nil {
		t.Fatal(err)
	}
	if body["msg_type"] != "text" {
		t.Fatalf("payload = %+v", body)
	}
	content, _ := body["content"].(map[string]any)
	if content["text"] != "hello" {
		t.Fatalf("content = %+v", content)
	}
	if body["sign"] == "" || body["timestamp"] == "" {
		t.Fatalf("signed fields missing: %+v", body)
	}
}

// TestSendFeishuErrors checks HTTP and Feishu errors.
func TestSendFeishuErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "bad") {
			_, _ = w.Write([]byte(`{"code":19021,"msg":"sign match fail"}`))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("boom"))
	}))
	defer srv.Close()
	if err := sendFeishu(srv.URL, "", "hi"); err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("http error = %v", err)
	}
	if err := sendFeishu(srv.URL+"/bad", "", "hi"); err == nil || !strings.Contains(err.Error(), "19021") {
		t.Fatalf("feishu error = %v", err)
	}
	if err := sendFeishu("ftp://example.com", "", "hi"); err == nil {
		t.Fatal("a non-http webhook was accepted")
	}
}
