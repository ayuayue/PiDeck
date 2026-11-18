//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"fmt"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

// applyModel switches the session's model.
func (a *app) applyModel(s *session, provider, id string, remember bool) {
	if s == nil || id == "" {
		return
	}
	if remember {
		a.defaultModel = modelChoice{Provider: provider, ID: id}
		a.st.edit(func(c *config) { c.Model = a.defaultModel })
	}
	a.ensureEngine(s, func() {
		c := s.engine
		if c == nil {
			return
		}
		go func() {
			var m modelInfo
			err := c.call(map[string]any{"type": "set_model", "provider": provider, "modelId": id}, &m, 30*time.Second)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "切换模型失败", err.Error())
					return
				}
				s.model.Set(m)
				a.startStats(s)
				a.refreshModelState(s)
			})
		}()
	})
}

// refreshModels asks pi for its model list again, after models.json or
// auth changed outside the session.
func (a *app) refreshModels(s *session) {
	if s == nil || s.backend == "acp" || s.modelsBusy.GetUntracked() {
		return
	}
	c := s.engine
	if c == nil {
		a.toast(ui.ToastInfo, "会话还没就绪", "等 Agent 启动后再刷新。")
		return
	}
	s.modelsBusy.Set(true)
	go func() {
		var models struct {
			Models []modelInfo `json:"models"`
		}
		err := c.call(map[string]any{"type": "get_available_models"}, &models, 40*time.Second)
		var levels struct {
			Levels []string `json:"levels"`
		}
		levelsErr := c.call(map[string]any{"type": "get_available_thinking_levels"}, &levels, 20*time.Second)
		a.cx.Post(func() {
			s.modelsBusy.Set(false)
			if err != nil {
				a.toast(ui.ToastError, "刷新模型失败", err.Error())
				return
			}
			s.models.Set(models.Models)
			if levelsErr == nil && len(levels.Levels) > 0 {
				s.levels.Set(levels.Levels)
			}
			a.toast(ui.ToastSuccess, "模型列表已刷新", fmt.Sprintf("共 %d 个模型。", len(models.Models)))
		})
	}()
}

// refreshModelState reads what the current model accepts again: its
// levels and its resolved name. Every model has its own levels, so the
// picker is rebuilt from this.
func (a *app) refreshModelState(s *session) {
	c := s.engine
	if c == nil {
		return
	}
	go func() {
		var levels struct {
			Levels []string `json:"levels"`
		}
		var state struct {
			Model         *modelInfo `json:"model"`
			ThinkingLevel string     `json:"thinkingLevel"`
		}
		levelsErr := c.call(map[string]any{"type": "get_available_thinking_levels"}, &levels, 20*time.Second)
		stateErr := c.call(map[string]any{"type": "get_state"}, &state, 20*time.Second)
		a.cx.Post(func() {
			if levelsErr == nil && len(levels.Levels) > 0 {
				s.levels.Set(levels.Levels)
			}
			if stateErr == nil {
				if state.Model != nil {
					s.model.Set(*state.Model)
				}
				if state.ThinkingLevel != "" {
					s.thinking.Set(state.ThinkingLevel)
				}
			}
		})
	}()
}

// applyThinking sets the reasoning level.
func (a *app) applyThinking(s *session, level string, remember bool) {
	if s == nil || level == "" {
		return
	}
	if remember {
		a.defaultThinking = level
		a.st.edit(func(c *config) { c.Thinking = level })
	}
	a.ensureEngine(s, func() {
		c := s.engine
		if c == nil {
			return
		}
		go func() {
			err := c.call(map[string]any{"type": "set_thinking_level", "level": level}, nil, 20*time.Second)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "切换思考等级失败", err.Error())
					return
				}
				s.thinking.Set(level)
			})
		}()
	})
}
