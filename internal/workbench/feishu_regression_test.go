//go:build !js && !android && !ios

package workbench

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSendFeishuRejectsInvalidSuccess(t *testing.T) {
	for _, body := range []string{"", "not json", `{}`, `{"code":null}`, `{"msg":"success"}`} {
		t.Run(body, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(body))
			}))
			defer srv.Close()
			if err := sendFeishu(t.Context(), srv.URL, "", "hello"); err == nil {
				t.Fatalf("reported success for response %q", body)
			}
		})
	}
}

func TestFeishuIgnoresNonUserEvents(t *testing.T) {
	for _, body := range []string{
		`{"header":{"event_type":"im.message.message_read_v1","token":"tok"},"event":{"message":{"message_type":"text","content":"{\"text\":\"ignore\"}"}}}`,
		`{"header":{"event_type":"im.message.receive_v1","token":"tok"},"event":{"sender":{"sender_type":"app"},"message":{"message_type":"text","content":"{\"text\":\"ignore\"}"}}}`,
		`{"header":{"event_type":"im.message.receive_v1","token":"tok"},"event":{"sender":{"sender_type":"bot"},"message":{"message_type":"text","content":"{\"text\":\"ignore\"}"}}}`,
	} {
		_, _, text, err := parseFeishuCallback([]byte(body))
		if err != nil || text != "" {
			t.Fatalf("non-user event yielded %q, %v", text, err)
		}
	}
}

func TestFeishuRejectsOversizedCallback(t *testing.T) {
	h := &remoteHost{app: &app{st: &store{c: &config{FeishuInbound: true, FeishuVerifyToken: "tok"}}}}
	body := `{"challenge":"abc","token":"tok"}` + strings.Repeat(" ", 1<<20)
	rec := httptest.NewRecorder()
	h.handleFeishu(rec, httptest.NewRequest(http.MethodPost, "/api/feishu", strings.NewReader(body)))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized callback = %d %s", rec.Code, rec.Body.String())
	}
}

func TestFeishuCallbackRejectsMessageWithoutSource(t *testing.T) {
	h := &remoteHost{app: &app{st: &store{c: &config{FeishuInbound: true, FeishuVerifyToken: "tok"}}}}
	for _, body := range []string{
		`{"token":"tok","type":"message","text":"no source"}`,
		`{"header":{"token":"tok","event_type":"im.message.receive_v1"},"event":{"message":{"chat_id":"chat","message_type":"text","content":"{\"text\":\"no message ID\"}"}}}`,
	} {
		rec := httptest.NewRecorder()
		h.handleFeishu(rec, httptest.NewRequest(http.MethodPost, "/api/feishu", strings.NewReader(body)))
		if rec.Code != http.StatusBadRequest || len(h.feishuSeen) != 0 {
			t.Fatalf("callback without a source was accepted: %d %s", rec.Code, rec.Body.String())
		}
	}
}
