//go:build !js && !android && !ios

package workbench

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLocalWhisperTranscription(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audio/transcriptions" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if err := r.ParseMultipartForm(maxVoiceBytes); err != nil {
			t.Error(err)
		}
		if r.FormValue("model") != "whisper-1" || len(r.MultipartForm.File["file"]) != 1 {
			t.Error("missing audio or model")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"text":"本地识别结果"}`))
	}))
	defer srv.Close()
	text, err := transcribeWhisper(t.Context(), srv.URL, []byte("RIFF0000WAVE"))
	if err != nil || text != "本地识别结果" {
		t.Fatalf("local transcript = %q, %v", text, err)
	}
	for _, url := range []string{"https://127.0.0.1", "http://example.com", "http://localhost.evil", "http://a@localhost", "http://localhost?token=x"} {
		if _, err := whisperURL(url); err == nil {
			t.Errorf("accepted %q", url)
		}
	}
}
