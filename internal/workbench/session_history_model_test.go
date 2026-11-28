//go:build !js && !android && !ios

package workbench

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestOpeningHistoryRestoresModelAndThinkingWithoutAgent(t *testing.T) {
	for _, tt := range []struct {
		name     string
		last     string
		model    string
		thinking string
	}{
		{
			name: "selection after last reply",
			last: `{"type":"model_change","provider":"latest-provider","modelId":"latest-model"}` + "\n" +
				`{"type":"thinking_level_change","thinkingLevel":"high"}`,
			model: "latest-model", thinking: "high",
		},
		{
			name: "assistant records its model",
			last: `{"type":"message","message":{"role":"assistant","provider":"latest-provider","model":"reply-model","content":[]}}` + "\n" +
				`{"type":"thinking_level_change","thinkingLevel":"off"}`,
			model: "reply-model", thinking: "off",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			a, screen, s := startModelOptionsApp(t)
			file := writeLines(t,
				`{"type":"session","version":3,"id":"history-settings"}`,
				`{"type":"model_change","provider":"old-provider","modelId":"old-model"}`,
				`{"type":"thinking_level_change","thinkingLevel":"low"}`,
				`{"type":"message","message":{"role":"user","content":"saved question"}}`,
				`{"type":"message","message":{"role":"assistant","provider":"old-provider","model":"old-model","content":[]}}`,
				tt.last,
			)
			onNativeUI(t, screen, a, func() {
				s.model.Set(modelInfo{})
				s.thinking.Set("")
				s.levels.Set(nil)
				s.loaded.Set(false)
				s.File = file
				a.selectSession(s)
			})
			screen.WaitUntil(5*time.Second, func() bool { return s.loaded.GetUntracked() })
			if got := s.model.GetUntracked(); got.ID != tt.model || got.Provider != "latest-provider" {
				t.Errorf("history model = %+v, want latest-provider/%s", got, tt.model)
			}
			if got := s.thinking.GetUntracked(); got != tt.thinking {
				t.Errorf("history thinking = %q, want %q", got, tt.thinking)
			}
			if got := screen.Find("id:model-picker-name").Text; got != tt.model {
				t.Errorf("model chip = %q, want %q", got, tt.model)
			}
			if !screen.Exists("id:effort-picker") || !strings.Contains(strings.Join(screen.Texts(), " "), levelLabel(tt.thinking)) {
				t.Error("saved thinking level is not visible before the agent starts")
			}
			if s.hasAgent() || s.starting || s.readySig.GetUntracked() || s.piGeneration.Load() != 0 {
				t.Fatal("reading saved settings launched an agent")
			}
			if s.modelSelection.model || s.modelSelection.thinking {
				t.Fatal("reading saved settings queued a model selection")
			}
		})
	}
}

func TestSessionHistorySettingsSurviveCacheAndAppends(t *testing.T) {
	file := writeLines(t,
		`{"type":"model_change","provider":"fixture","modelId":"original"}`,
		`{"type":"thinking_level_change","thinkingLevel":"high"}`,
		`{"type":"message","message":{"role":"user","content":"first question"}}`,
	)
	check := func(model, thinking string, messages int) historyEntry {
		t.Helper()
		entry, err := sessionFileHistory(file)
		if err != nil {
			t.Fatal(err)
		}
		if entry.model.ID != model || entry.model.Provider != "fixture" || entry.thinking != thinking || len(entry.view) != messages {
			t.Fatalf("history settings = %+v / %q, %d messages; want fixture/%s / %q, %d messages",
				entry.model, entry.thinking, len(entry.view), model, thinking, messages)
		}
		return entry
	}
	first := check("original", "high", 1)
	cached := check("original", "high", 1)
	if &first.msgs[0] != &cached.msgs[0] {
		t.Fatal("reading settings reparsed unchanged messages")
	}

	appendLines(t, file, `{"type":"message","message":{"role":"user","content":"next question"}}`)
	check("original", "high", 2)
	appendLines(t, file, `{"type":"model_change","provider":"fixture","modelId":"new-model"}`)
	check("new-model", "high", 2)
	appendLines(t, file,
		`{"type":"thinking_level_change","thinkingLevel":"off"}`,
		`{"type":"model_change","modelId":`,
		`{"type":"model_change","provider":"bad","modelId":""}`,
		`{"type":"thinking_level_change","thinkingLevel":false}`,
		`{"type":"thinking_level_change","thinkingLevel":""}`,
	)
	check("new-model", "off", 2)
	if first.model.ID != "original" || first.thinking != "high" {
		t.Fatal("appending settings mutated an earlier cached snapshot")
	}

	// A rewritten file must not inherit settings from the discarded history.
	if err := os.WriteFile(file, []byte("{\"type\":\"session\",\"id\":\"replacement\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	entry, err := sessionFileHistory(file)
	if err != nil || entry.model.ID != "" || entry.thinking != "" || len(entry.view) != 0 {
		t.Fatalf("rewritten history kept stale settings: model=%+v thinking=%q messages=%d err=%v", entry.model, entry.thinking, len(entry.view), err)
	}
}

func TestHistorySettingsKeepChoicesMadeDuringRead(t *testing.T) {
	for _, changeModel := range []bool{false, true} {
		name := "thinking only"
		if changeModel {
			name = "model and thinking"
		}
		t.Run(name, func(t *testing.T) {
			a, screen, s := startModelOptionsApp(t)
			file := writeLines(t,
				`{"type":"model_change","provider":"saved","modelId":"saved-model"}`,
				`{"type":"thinking_level_change","thinkingLevel":"low"}`,
			)
			onNativeUI(t, screen, a, func() {
				s.model.Set(modelInfo{})
				s.thinking.Set("")
				s.loaded.Set(false)
				s.File = file
				a.loadHistoryFromFile(s)
				// These handlers run before the queued file-read callback.
				if changeModel {
					a.applyModel(s, "chosen", "chosen-model", false)
				}
				a.applyThinking(s, "medium", false)
			})
			screen.WaitUntil(5*time.Second, func() bool { return s.loaded.GetUntracked() })
			wantProvider, wantModel := "saved", "saved-model"
			if changeModel {
				wantProvider, wantModel = "chosen", "chosen-model"
			}
			if got := s.model.GetUntracked(); got.Provider != wantProvider || got.ID != wantModel {
				t.Errorf("model after file read = %+v, want %s/%s", got, wantProvider, wantModel)
			}
			if got := s.thinking.GetUntracked(); got != "medium" {
				t.Errorf("file read overwrote chosen thinking level: %q", got)
			}
			if s.hasAgent() || s.starting {
				t.Fatal("reading settings started an agent")
			}
		})
	}
}

func TestHistorySettingsUseCachedCapabilitiesAndYieldToPi(t *testing.T) {
	a, screen, s := startModelOptionsApp(t)
	file := writeLines(t,
		`{"type":"model_change","provider":"fixture","modelId":"reasoner"}`,
		`{"type":"thinking_level_change","thinkingLevel":"high"}`,
	)
	onNativeUI(t, screen, a, func() {
		s.model.Set(modelInfo{})
		s.thinking.Set("")
		s.loaded.Set(false)
		s.File = file
		options := a.modelOptionsFor(s.WS)
		options.items, options.checked = fixtureModelOptions(), time.Now()
		a.loadHistoryFromFile(s)
	})
	screen.WaitUntil(5*time.Second, func() bool { return s.loaded.GetUntracked() })
	if got := screen.Find("id:model-picker-name").Text; got != "Reasoner" {
		t.Errorf("cached model name = %q, want Reasoner", got)
	}
	if levels := s.levels.GetUntracked(); strings.Join(levels, ",") != "off,low,high" {
		t.Errorf("cached thinking levels = %v", levels)
	}
	if !screen.Exists("id:effort-picker") || s.hasAgent() {
		t.Fatal("cached capabilities were not shown without an agent")
	}

	onNativeUI(t, screen, a, func() {
		a.engineReady(s, nil, &modelInfo{Provider: "pi", ID: "actual-model"}, "off", file, 0, false)
	})
	if got := s.model.GetUntracked(); got.Provider != "pi" || got.ID != "actual-model" {
		t.Errorf("pi state did not replace saved model: %+v", got)
	}
	if got := s.thinking.GetUntracked(); got != "off" {
		t.Errorf("pi state did not replace saved thinking: %q", got)
	}
}
