package client

// A batch ask is answerable on the phone: the questions arrive with their
// types and choices, and what was answered or skipped goes back in the
// envelope the extension reads.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMobileBatchAskAnswersEveryQuestion(t *testing.T) {
	const token = "ask-token"
	state := remotewire.Snapshot{Name: "PiDeck V2", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{{ID: "s1", Title: "批量提问的会话"}},
	}}}
	batch := &remotewire.Ask{Method: remotewire.AskMethodBatch, Title: "批量提问", Questions: []remotewire.AskQuestion{
		{ID: "q1", Type: "select", Question: "用哪个方案？", Options: []remotewire.AskOption{
			{Label: "方案甲", Value: "a"}, {Label: "方案乙", Value: "b"}}},
		{ID: "q2", Type: "multi_select", Question: "带上哪些检查？", Options: []remotewire.AskOption{
			{Label: "单元测试", Value: "unit"}, {Label: "构建", Value: "build"}}},
		{ID: "q3", Type: "input", Question: "备注写什么？", Placeholder: "备注"},
	}}
	var mu sync.Mutex
	var answered map[string]any
	mux := http.NewServeMux()
	check := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	}
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "PiDeck V2", "host": "desk"})
		}
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(state)
		}
	})
	mux.HandleFunc("/api/session/", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		mu.Lock()
		ask := batch
		if answered != nil {
			ask = nil
		}
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(remotewire.Transcript{ID: "s1", Title: "批量提问的会话", Ask: ask})
	})
	mux.HandleFunc("/api/sessions/s1/answer", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		answered = body
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-server", 10*time.Second)
	app.Type("id:mobile-server", server.URL)
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")
	waitApp(app, "text:电脑项目", 15*time.Second)
	openPhoneRail(app)
	app.WaitFor("id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "id:mobile-ask", 15*time.Second)

	// The card carries every question, so the phone never says "go to the
	// desktop".
	for _, want := range []string{"用哪个方案？", "带上哪些检查？", "备注写什么？"} {
		app.WaitFor("text:"+want, 5*time.Second)
	}
	// Submit waits for the questions to be settled.
	if app.Enabled("id:mobile-ask-submit") {
		t.Fatal("submit was enabled with nothing answered")
	}
	shot(app, "69-mobile-batch-ask")
	app.Press("id:mobile-ask-question-0 >> text:方案乙")
	app.Press("id:mobile-ask-question-1 >> text:构建")
	app.Type("id:mobile-ask-question-2 >> id:mobile-ask-input", "按乙方案")
	app.Advance(200 * time.Millisecond)
	app.Press("id:mobile-ask-submit")
	waitFor(t, app, 10*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return answered != nil
	})
	mu.Lock()
	body := answered
	mu.Unlock()
	raw, _ := json.Marshal(body["answers"])
	var answers []remotewire.AskAnswer
	if err := json.Unmarshal(raw, &answers); err != nil {
		t.Fatalf("answers = %s: %v", raw, err)
	}
	if len(answers) != 3 {
		t.Fatalf("answers = %s; want three", raw)
	}
	if answers[0].Value != "b" || answers[0].Label != "方案乙" {
		t.Fatalf("select answer = %+v", answers[0])
	}
	values, _ := answers[1].Value.([]any)
	if len(values) != 1 || values[0] != "build" {
		t.Fatalf("multi_select answer = %+v", answers[1])
	}
	if answers[2].Value != "按乙方案" {
		t.Fatalf("input answer = %+v", answers[2])
	}
	app.WaitForGone("id:mobile-ask", 10*time.Second)
}

func TestMobileBatchAskSkipAndCancel(t *testing.T) {
	const token = "ask-token"
	state := remotewire.Snapshot{Name: "PiDeck V2", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{{ID: "s1", Title: "跳过与取消"}},
	}}}
	batch := &remotewire.Ask{Method: remotewire.AskMethodBatch, Title: "批量提问", Questions: []remotewire.AskQuestion{
		{ID: "q1", Type: "confirm", Question: "要现在改吗？"},
		{ID: "q2", Type: "editor", Question: "改哪些文件？"},
	}}
	var mu sync.Mutex
	var answered map[string]any
	mux := http.NewServeMux()
	check := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	}
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "PiDeck V2", "host": "desk"})
		}
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(state)
		}
	})
	mux.HandleFunc("/api/session/", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		mu.Lock()
		ask := batch
		if answered != nil {
			ask = nil
		}
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(remotewire.Transcript{ID: "s1", Title: "跳过与取消", Ask: ask})
	})
	mux.HandleFunc("/api/sessions/s1/answer", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		answered = body
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-server", 10*time.Second)
	app.Type("id:mobile-server", server.URL)
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")
	waitApp(app, "text:电脑项目", 15*time.Second)
	openPhoneRail(app)
	app.WaitFor("id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "id:mobile-ask", 15*time.Second)

	app.Press("id:mobile-ask-question-0 >> text:是")
	app.Press("id:mobile-ask-skip-1")
	app.Advance(200 * time.Millisecond)
	if !app.Enabled("id:mobile-ask-submit") {
		t.Fatal("submit still disabled with one answered and one skipped")
	}
	app.Press("id:mobile-ask-submit")
	waitFor(t, app, 10*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return answered != nil
	})
	raw, _ := json.Marshal(answered["answers"])
	var answers []remotewire.AskAnswer
	if err := json.Unmarshal(raw, &answers); err != nil {
		t.Fatalf("answers = %s: %v", raw, err)
	}
	if len(answers) != 2 || answers[0].Value != true || !answers[1].Skipped {
		t.Fatalf("answers = %s", raw)
	}
	app.WaitForGone("id:mobile-ask", 10*time.Second)
}
