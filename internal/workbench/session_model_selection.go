//go:build !js && !android && !ios

package workbench

import (
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

type modelSelectionState struct {
	revision uint64
	model    bool
	thinking bool
	busy     bool
}

type piModelState struct {
	Model         *modelInfo `json:"model"`
	ThinkingLevel string     `json:"thinkingLevel"`
}

// applyPiModelSelection serializes registry refresh, selection and the resulting
// state. The ready signal/waiters are not released until this has succeeded.
func applyPiModelSelection(c *piClient, model *modelInfo, thinking string, refresh bool) (piModelState, []string, error) {
	var state piModelState
	if model != nil && model.ID != "" {
		if refresh {
			if _, err := c.readModelOptions(); err != nil {
				return state, nil, err
			}
		}
		if err := c.call(map[string]any{"type": "set_model", "provider": model.Provider, "modelId": model.ID}, nil, 25*time.Second); err != nil {
			return state, nil, err
		}
	}
	if thinking != "" {
		if err := c.call(map[string]any{"type": "set_thinking_level", "level": thinking}, nil, 20*time.Second); err != nil {
			return state, nil, err
		}
	}
	if err := c.call(map[string]any{"type": "get_state"}, &state, 20*time.Second); err != nil {
		return state, nil, err
	}
	var levels struct {
		Levels []string `json:"levels"`
	}
	err := c.call(map[string]any{"type": "get_available_thinking_levels"}, &levels, 20*time.Second)
	return state, levels.Levels, err
}

func selectionRequest(s *session) (*modelInfo, string) {
	var model *modelInfo
	if s.modelSelection.model {
		chosen := s.model.GetUntracked()
		model = &chosen
	}
	thinking := ""
	if s.modelSelection.thinking {
		thinking = s.thinking.GetUntracked()
	}
	return model, thinking
}

// initializeEngineModels runs before engineReady or historyReady can release
// the first send. A selection made while pi boots wins over earlier defaults.
func (a *app) initializeEngineModels(s *session, c *piClient, generation uint64, model *modelInfo, thinking string, count int, done func(*modelInfo, string)) {
	if count == 0 {
		chosen := s.model.GetUntracked()
		if chosen.ID != "" && (!s.Target.remote() || model == nil || chosen.ID != model.ID || chosen.Provider != model.Provider) {
			s.modelSelection.model = true
		}
		if level := s.thinking.GetUntracked(); level != "" && (level != thinking || s.modelSelection.model) {
			s.modelSelection.thinking = true
		}
	}
	if !s.modelSelection.model && !s.modelSelection.thinking {
		done(model, thinking)
		return
	}
	revision := s.modelSelection.revision
	chosen, level := selectionRequest(s)
	go func() {
		state, levels, err := applyPiModelSelection(c, chosen, level, !s.Target.remote())
		a.cx.Post(func() {
			if s.engine != c || s.piGeneration.Load() != generation {
				return
			}
			if s.deleting {
				done(state.Model, state.ThinkingLevel)
				return
			}
			if s.modelSelection.revision != revision {
				a.initializeEngineModels(s, c, generation, state.Model, state.ThinkingLevel, count, done)
				return
			}
			if err != nil {
				// Do not let a queued first prompt silently use another model.
				s.piGeneration.Add(1)
				s.engine, s.piStarting = nil, nil
				go c.stop()
				a.failSession(s, err.Error())
				return
			}
			s.modelSelection.model, s.modelSelection.thinking = false, false
			if state.Model != nil {
				s.model.Set(*state.Model)
			}
			s.thinking.Set(state.ThinkingLevel)
			s.levels.Set(levels)
			done(state.Model, state.ThinkingLevel)
		})
	}()
}

func (a *app) flushModelSelection(s *session) {
	c := s.engine
	if c == nil || s.starting || s.deleting || s.agentStopping || s.modelSelection.busy {
		return
	}
	if !s.modelSelection.model && !s.modelSelection.thinking {
		return
	}
	s.modelSelection.busy = true
	revision := s.modelSelection.revision
	chosen, level := selectionRequest(s)
	go func() {
		state, levels, err := applyPiModelSelection(c, chosen, level, true)
		a.cx.Post(func() {
			if s.engine != c || s.deleting {
				return
			}
			s.modelSelection.busy = false
			if s.modelSelection.revision != revision {
				a.flushModelSelection(s)
				return
			}
			s.modelSelection.model, s.modelSelection.thinking = false, false
			if err != nil {
				if len(s.waiters) > 0 {
					a.failSession(s, err.Error())
				} else {
					a.toast(ui.ToastError, "切换模型失败", err.Error())
					a.refreshModelState(s)
				}
				return
			}
			if state.Model != nil {
				s.model.Set(*state.Model)
			}
			s.thinking.Set(state.ThinkingLevel)
			s.levels.Set(levels)
			a.startStats(s)
			a.historyReady(s)
		})
	}()
}
