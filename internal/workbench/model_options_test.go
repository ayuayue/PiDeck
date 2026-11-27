//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"example.com/pideck-v2/extensions"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func TestModelSelectionBeforePiDoesNotStartSession(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		a.env.Set(envInfo{Probed: true, PiError: "fixture must not launch pi"})
		s.turns.Set(nil)
		s.models.Set([]modelInfo{{Provider: "fixture", ID: "reasoner", Name: "Reasoner", Reasoning: true}})
		a.applyModel(s, "fixture", "reasoner", false)
		a.applyThinking(s, "high", false)
		if got := s.model.GetUntracked(); got.Provider != "fixture" || got.ID != "reasoner" {
			t.Errorf("preselected model = %+v, want fixture/reasoner", got)
		}
		if got := s.thinking.GetUntracked(); got != "high" {
			t.Errorf("preselected thinking = %q, want high", got)
		}
		if s.engine != nil || s.starting || s.readySig.GetUntracked() {
			t.Error("selecting model/thinking started a session")
		}
		if s.status.GetUntracked() == statusFailed {
			t.Error("selecting model/thinking attempted to launch pi")
		}
	})
}

func TestModelOptionsPickerBeforePi(t *testing.T) {
	a, screen, s := startModelOptionsApp(t)
	onNativeUI(t, screen, a, func() {
		entry := a.modelOptionsFor(s.WS)
		entry.items, entry.checked = fixtureModelOptions(), time.Now()
		a.publishModelOptions(s.WS, entry)
	})
	screen.Press("id:model-picker")
	screen.WaitFor("role:option Plain", 5*time.Second)
	screen.Press("role:option Plain")
	onNativeUI(t, screen, a, func() {
		if got := s.model.GetUntracked().ID; got != "plain" {
			t.Errorf("picked model = %q, want plain", got)
		}
		if got := s.levels.GetUntracked(); !slices.Equal(got, []string{"off"}) || s.thinking.GetUntracked() != "off" {
			t.Errorf("plain model reasoning = %v / %s", got, s.thinking.GetUntracked())
		}
		if s.hasAgent() || s.starting || s.status.GetUntracked() == statusFailed {
			t.Error("opening or selecting from the model picker launched pi")
		}
	})
}

func TestModelOptionsRestoredSessionsOnlyUseCachedChoices(t *testing.T) {
	a, screen, s := startModelOptionsApp(t)
	onNativeUI(t, screen, a, func() {
		entry := a.modelOptionsFor(s.WS)
		entry.items, entry.checked = fixtureModelOptions(), a.cx.Now()
		a.env.Set(envInfo{Probed: true, PiPath: "pi"})
		restored := a.blankSession("restored-model-options", &workspace{Path: s.WS, Target: localTarget}, "History")
		if entry.busy || restored.hasAgent() {
			t.Error("restoring a session started a model probe or an agent")
		}
		if len(restored.models.GetUntracked()) != len(entry.items) || len(restored.levels.GetUntracked()) == 0 {
			t.Error("restored session did not receive cached model capabilities")
		}
	})
}

func TestModelOptionsCachedSnapshotAvoidsProbeUntilExpiry(t *testing.T) {
	a, screen, s := startModelOptionsApp(t)
	// A missing project directory makes any unexpected probe fail immediately.
	dir := filepath.Join(t.TempDir(), "missing-project")
	stamp, err := modelOptionsStamp(piConfigDir(), dir)
	if err != nil {
		t.Fatal(err)
	}
	onNativeUI(t, screen, a, func() {
		s.WS = dir
		entry := a.modelOptionsFor(s.WS)
		entry.items, entry.stamp, entry.checked = fixtureModelOptions(), stamp, a.cx.Now()
		entry.dirty = false
		a.env.Set(envInfo{Probed: true, PiPath: "pi"})
		a.ensureSessionModelOptions(s, false, false)
	})
	screen.WaitUntil(5*time.Second, func() bool { return !a.modelOptions[s.WS].busy })
	if got := a.modelOptions[s.WS].err; got != "" {
		t.Fatalf("unchanged cached options attempted a probe: %s", got)
	}
	screen.Advance(5*time.Minute + time.Second)
	onNativeUI(t, screen, a, func() { a.ensureSessionModelOptions(s, false, false) })
	screen.WaitUntil(5*time.Second, func() bool { return !a.modelOptions[s.WS].busy })
	if a.modelOptions[s.WS].err == "" {
		t.Fatal("expired model options did not attempt refresh")
	}
	if len(s.models.GetUntracked()) != len(fixtureModelOptions()) || s.hasAgent() {
		t.Fatal("failed cache refresh erased choices or started the session")
	}
}

func TestModelOptionsRefreshBeforePiAndKeepLastGood(t *testing.T) {
	requirePi(t)
	a, screen, s := startModelOptionsApp(t)
	configDir := piConfigDir()
	t.Setenv("PI_CODING_AGENT_DIR", configDir)
	writeModelOptionsConfig(t, configDir, "first")
	onNativeUI(t, screen, a, func() {
		a.env.Set(envInfo{Probed: true, PiPath: "pi"})
		a.ensureSessionModelOptions(s, false, false)
		// A second open shares the same in-flight request.
		a.ensureSessionModelOptions(s, false, false)
	})
	waitForModelOption(t, screen, a, s, "first")
	if s.hasAgent() || s.starting {
		t.Fatal("prefetch attached an engine to the session")
	}
	firstRevision := a.modelOptions[s.WS].revision
	writeModelOptionsConfig(t, configDir, "external-change")
	onNativeUI(t, screen, a, func() { a.ensureSessionModelOptions(s, false, false) })
	waitForModelOption(t, screen, a, s, "external-change")
	if a.modelOptions[s.WS].revision != firstRevision {
		t.Fatal("ordinary opens unnecessarily forced cache invalidation")
	}
	if err := os.WriteFile(filepath.Join(configDir, "models.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	onNativeUI(t, screen, a, func() { a.refreshModels(s) })
	screen.WaitUntil(25*time.Second, func() bool {
		entry := a.modelOptions[s.WS]
		return !entry.busy && entry.err != ""
	})
	if !slices.ContainsFunc(s.models.GetUntracked(), func(m modelInfo) bool { return m.Provider == "fixture" && m.ID == "external-change" }) {
		t.Fatal("failed refresh erased the last good model list")
	}
	writeModelOptionsConfig(t, configDir, "recovered")
	onNativeUI(t, screen, a, func() { a.ensureSessionModelOptions(s, false, false) })
	waitForModelOption(t, screen, a, s, "recovered")
	if s.engine != nil || s.starting {
		t.Fatal("refresh/recovery started the user session")
	}
	files, err := os.ReadDir(a.st.sessions)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("model probes persisted %d session entries", len(files))
	}
}

func TestModelOptionsRunningRegistryRefreshAgainstPi(t *testing.T) {
	requirePi(t)
	configDir, dataDir, project, sessions := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", configDir)
	t.Setenv("PIDECK_V2_PI_CONFIG", configDir)
	path := writeBundledExtension(dataDir, "pi-deck-model-options.ts", extensions.ModelOptions)
	writeModelOptionsConfig(t, configDir, "before")
	c, err := startPi(localTarget, "pi", project, sessions, "", "", nil, nil, nil, piLocalTools{extension: path, modelProbe: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.stop)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	stop := context.AfterFunc(ctx, c.stop)
	defer stop()
	options, err := c.readModelOptions()
	if err != nil || !slices.ContainsFunc(options, func(m modelOption) bool { return m.Provider == "fixture" && m.ID == "before" }) {
		t.Fatalf("initial model options = %v, err = %v", options, err)
	}
	writeModelOptionsConfig(t, configDir, "after")
	options, err = c.readModelOptions()
	if err != nil || !slices.ContainsFunc(options, func(m modelOption) bool { return m.Provider == "fixture" && m.ID == "after" }) {
		t.Fatalf("same process did not reload models.json: options = %v, err = %v", options, err)
	}
	if slices.ContainsFunc(options, func(m modelOption) bool { return m.Provider == "fixture" && m.ID == "before" }) {
		t.Fatal("removed model survived registry refresh")
	}
	var state struct {
		MessageCount int `json:"messageCount"`
	}
	if err := c.call(map[string]any{"type": "get_state"}, &state, 5*time.Second); err != nil || state.MessageCount != 0 {
		t.Fatalf("model refresh created transcript messages: count=%d, err=%v", state.MessageCount, err)
	}
}

func TestModelOptionsLatestSelectionWinsDuringStartup(t *testing.T) {
	a, screen, s := startModelOptionsApp(t)
	gate, first := make(chan struct{}), make(chan struct{}, 1)
	var release sync.Once
	defer release.Do(func() { close(gate) })
	var c *piClient
	var selected = modelInfo{Provider: "fixture", ID: "initial"}
	thinking := "off"
	options, _ := json.Marshal(map[string]any{"models": fixtureModelOptions()})
	c = modelOptionsRPCFixture(t, func(cmd map[string]any) (any, error) {
		switch cmd["type"] {
		case "get_commands":
			return map[string]any{"commands": []map[string]string{{"name": modelOptionsCommand, "source": "extension"}}}, nil
		case "prompt":
			line, _ := json.Marshal(map[string]any{"type": "extension_ui_request", "method": "setStatus", "statusKey": modelOptionsStatusKey, "statusText": string(options)})
			c.dispatch(line)
		case "set_model":
			id := cmd["modelId"].(string)
			if id == "reasoner" {
				first <- struct{}{}
				<-gate
			}
			selected = modelInfo{Provider: "fixture", ID: id}
		case "set_thinking_level":
			thinking = cmd["level"].(string)
		case "get_state":
			return piModelState{Model: &selected, ThinkingLevel: thinking}, nil
		case "get_available_thinking_levels":
			return map[string]any{"levels": []string{"off"}}, nil
		}
		return nil, nil
	})
	finished := false
	onNativeUI(t, screen, a, func() {
		s.engine, s.starting = c, true
		s.piGeneration.Store(1)
		entry := a.modelOptionsFor(s.WS)
		entry.items, entry.checked = fixtureModelOptions(), time.Now()
		a.initializeEngineModels(s, c, 1, &modelInfo{Provider: "fixture", ID: "initial"}, "off", 0, func(model *modelInfo, level string) {
			if model == nil || model.ID != "plain" || level != "off" {
				t.Errorf("startup committed an older selection: model=%+v thinking=%s", model, level)
			}
			finished = true
		})
	})
	screen.WaitUntil(5*time.Second, func() bool {
		select {
		case <-first:
			return true
		default:
			return false
		}
	})
	onNativeUI(t, screen, a, func() {
		a.applyModel(s, "fixture", "plain", false)
		if finished || s.readySig.GetUntracked() {
			t.Error("first send was released before selection finished")
		}
	})
	release.Do(func() { close(gate) })
	screen.WaitUntil(5*time.Second, func() bool { return finished })
	onNativeUI(t, screen, a, func() { s.engine = nil })
}

func TestModelOptionsStartupFailureDoesNotReleaseSend(t *testing.T) {
	a, screen, s := startModelOptionsApp(t)
	c := modelOptionsRPCFixture(t, func(cmd map[string]any) (any, error) {
		return map[string]any{"commands": []any{}}, nil
	})
	released := false
	onNativeUI(t, screen, a, func() {
		s.engine, s.starting = c, true
		s.piGeneration.Store(1)
		s.waiters = []func(){func() { released = true }}
		a.initializeEngineModels(s, c, 1, nil, "off", 0, func(model *modelInfo, level string) {
			s.readySig.Set(true)
			a.historyReady(s)
		})
	})
	screen.WaitUntil(5*time.Second, func() bool { return s.status.GetUntracked() == statusFailed })
	if released || s.readySig.GetUntracked() || s.engine != nil || len(s.waiters) != 0 {
		t.Fatal("failed model initialization released a prompt or kept the engine ready")
	}
}

func TestModelOptionsMissingCommandNeverPrompts(t *testing.T) {
	var mu sync.Mutex
	var calls []string
	c := modelOptionsRPCFixture(t, func(cmd map[string]any) (any, error) {
		mu.Lock()
		calls = append(calls, cmd["type"].(string))
		mu.Unlock()
		return map[string]any{"commands": []any{}}, nil
	})
	if _, err := c.readModelOptions(); err == nil {
		t.Fatal("missing extension succeeded")
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(calls, []string{"get_commands"}) {
		t.Fatalf("missing extension sent commands %v", calls)
	}
}

func fixtureModelOptions() []modelOption {
	return []modelOption{
		{modelInfo: modelInfo{Provider: "fixture", ID: "reasoner", Name: "Reasoner", Reasoning: true},
			Levels: []string{"off", "low", "high"}, Clamped: map[string]string{"high": "high", "off": "off"}},
		{modelInfo: modelInfo{Provider: "fixture", ID: "plain", Name: "Plain"},
			Levels: []string{"off"}, Clamped: map[string]string{"high": "off", "off": "off"}},
	}
}

func startModelOptionsApp(t *testing.T) (*app, *nsgotest.App, *session) {
	t.Helper()
	home, project := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"scanPi":false,"telemetryEnabled":false,"autoModelCatalog":false,"theme":"light"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var a *app
	var s *session
	t.Cleanup(closeAllPi)
	t.Cleanup(sessionDraftWrites.Wait)
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		a.env.Set(envInfo{Probed: true, PiError: "fixture must not launch a session"})
		a.defaultModel = modelChoice{Provider: "fixture", ID: "reasoner"}
		a.defaultThinking = "high"
		s = a.blankSession("model-options-session", &workspace{Path: project, Target: localTarget}, "Model options")
		return core.View{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, Margin: core.All(40)}, Children: []core.Node{a.modelMenu(s, s.modelOpen), a.effortPicker(s)}},
			ui.Toasts{Toaster: a.toaster},
		}}
	}, nsgotest.Size(900, 650))
	t.Cleanup(a.closeDiag)
	return a, screen, s
}

func writeModelOptionsConfig(t *testing.T, dir, id string) {
	t.Helper()
	body, err := json.Marshal(map[string]any{"providers": map[string]any{"fixture": map[string]any{
		"api": "openai-completions", "baseUrl": "https://fixture.invalid/v1", "apiKey": "fixture-key",
		"models": []map[string]any{{"id": id, "name": id, "reasoning": true, "contextWindow": 32000, "maxTokens": 4096}},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "models.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
}

func waitForModelOption(t *testing.T, screen *nsgotest.App, a *app, s *session, id string) {
	t.Helper()
	screen.WaitUntil(25*time.Second, func() bool {
		entry := a.modelOptions[s.WS]
		return entry != nil && !entry.busy && entry.err == "" && slices.ContainsFunc(s.models.GetUntracked(), func(m modelInfo) bool {
			return m.Provider == "fixture" && m.ID == id
		})
	})
}

func modelOptionsRPCFixture(t *testing.T, answer func(map[string]any) (any, error)) *piClient {
	t.Helper()
	reader, writer := io.Pipe()
	c := &piClient{in: writer, pending: make(map[string]chan response)}
	done := make(chan struct{})
	go func() {
		defer close(done)
		decoder := json.NewDecoder(reader)
		for {
			var cmd map[string]any
			if decoder.Decode(&cmd) != nil {
				return
			}
			data, err := answer(cmd)
			raw, _ := json.Marshal(data)
			res := response{ID: cmd["id"].(string), Type: "response", Command: cmd["type"].(string), Success: err == nil, Data: raw}
			if err != nil {
				res.Error = err.Error()
			}
			line, _ := json.Marshal(res)
			c.dispatch(line)
		}
	}()
	t.Cleanup(func() {
		writer.Close()
		reader.Close()
		<-done
	})
	return c
}
