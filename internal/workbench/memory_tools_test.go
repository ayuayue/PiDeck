//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMemoryProjectBoundaryAndConflicts(t *testing.T) {
	scope := &session{Target: localTarget, WS: t.TempDir()}
	project := scope.Target.key() + "|" + scope.WS
	a := &app{}
	a.memory.store = newMemoryStore(t.TempDir())
	store := a.memory.store
	global, err := store.put(memoryEntry{Title: "Global", Body: "known needle"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := store.put(memoryEntry{Title: "Other", Body: "confidential needle", Project: "other"})
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.put(memoryEntry{Title: "This project", Body: "project needle", Project: project})
	if err != nil {
		t.Fatal(err)
	}
	next := note
	next.Body = "new needle"
	if _, err := store.put(next); err != nil {
		t.Fatal(err)
	}
	if _, err := store.put(note); err == nil {
		t.Fatal("saved over a newer edit")
	}
	if added, err := store.merge([]memoryEntry{note}); err != nil || added != 0 {
		t.Fatalf("duplicate import = %d, %v", added, err)
	}
	server, client := mcp.NewInMemoryTransports()
	ss, err := a.memoryServer(scope).Connect(t.Context(), server, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ss.Close()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "scope-test", Version: "1"}, nil).Connect(t.Context(), client, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	result, err := cs.CallTool(t.Context(), &mcp.CallToolParams{Name: "memory_search", Arguments: memoryLookup{Query: "needle"}})
	if err != nil || result.IsError {
		t.Fatalf("memory_search = %+v, %v", result, err)
	}
	raw, _ := json.Marshal(result.StructuredContent)
	if !strings.Contains(string(raw), global.ID) || !strings.Contains(string(raw), note.ID) || strings.Contains(string(raw), other.ID) {
		t.Fatalf("incorrectly scoped search: %s", raw)
	}
	for _, e := range []memoryEntry{global, other} {
		res, err := cs.CallTool(t.Context(), &mcp.CallToolParams{Name: "memory_write", Arguments: memorySave{ID: e.ID, Title: "Overwrite", Body: "overwrite"}})
		if err != nil || !res.IsError {
			t.Fatalf("modified out of scope note %s: %+v, %v", e.Title, res, err)
		}
	}
}

func TestPiMemoryToolsAndSystemTrajectory(t *testing.T) {
	if os.Getenv("PIDECK_LITE_TEST_PI_TOOLS") == "" {
		t.Skip("set PIDECK_LITE_TEST_PI_TOOLS to run pi 1.5 against the loopback model fixture")
	}
	requirePi(t)
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	piDir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", piDir)
	t.Setenv("PI_CODING_AGENT_DIR", piDir)
	t.Setenv("PI_OFFLINE", "1")
	t.Setenv("PI_TELEMETRY", "0")
	requests := make(chan string, 4)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body json.RawMessage
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil || r.URL.Path != "/v1/chat/completions" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		select {
		case requests <- string(body):
		default:
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"id\":\"probe\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"fixture response\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer model.Close()
	models := fmt.Sprintf(`{"providers":{"fixture":{"api":"openai-completions","apiKey":"fixture-key","baseUrl":%q,"models":[{"id":"fixture-1","contextWindow":32000,"maxTokens":1024}]}}}`, model.URL+"/v1")
	if err := os.WriteFile(filepath.Join(piDir, "models.json"), []byte(models), 0o600); err != nil {
		t.Fatal(err)
	}
	project := t.TempDir()
	if err := os.WriteFile(filepath.Join(project, "AGENTS.md"), []byte("trajectory-fixture-marker"), 0o600); err != nil {
		t.Fatal(err)
	}
	var a *app
	var s *session
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		a.cfg.MemoryTools = true
		a.addWorkspace(project)
		ws := a.workspaceOf(project)
		a.trustProject(ws)
		s = a.blankSession(newSessionID(), ws, "Fixture")
		return core.View{}
	})
	url, token, stop, err := a.startMemoryTools(s)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	c, err := startPi(localTarget, "", project, a.st.sessions, s.ID, "", nil, nil, nil, piLocalTools{
		extension: a.localToolsExtension,
		env:       []string{"PIDECK_LITE_MEMORY_URL=" + url, "PIDECK_LITE_MEMORY_TOKEN=" + token, "PIDECK_LITE_TRACE=1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.stop()
	done := make(chan error, 1)
	var state struct {
		SessionFile string `json:"sessionFile"`
	}
	started := time.Now()
	go func() {
		if err := c.call(map[string]any{"type": "set_model", "provider": "fixture", "modelId": "fixture-1"}, nil, 20*time.Second); err != nil {
			done <- err
			return
		}
		if err := c.call(map[string]any{"type": "prompt", "message": "fixture question"}, nil, 20*time.Second); err != nil {
			done <- err
			return
		}
		done <- c.call(map[string]any{"type": "get_state"}, &state, 20*time.Second)
	}()
	app.WaitUntil(25*time.Second, func() bool { return len(done) > 0 })
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	app.WaitUntil(10*time.Second, func() bool { return len(requests) > 0 })
	request := <-requests
	if !strings.Contains(request, "memory_search") || !strings.Contains(request, "session_search") {
		t.Fatal("pi did not offer Lite's project memory tools to the model")
	}
	if !strings.Contains(request, "trajectory-fixture-marker") {
		t.Fatal("pi did not include project instructions in the model request")
	}
	var recorded []string
	app.WaitUntil(10*time.Second, func() bool {
		recorded, _ = readTrajectory(state.SessionFile, "", started)
		return len(recorded) > 0
	})
	if !strings.Contains(recorded[0], "trajectory-fixture-marker") {
		t.Fatal("stored prompt omitted the project instructions transmitted by pi")
	}
	stop()
	if response, err := (&http.Client{Timeout: time.Second}).Get(url); err == nil {
		response.Body.Close()
		t.Fatalf("memory endpoint survived close: HTTP %d", response.StatusCode)
	}
}
