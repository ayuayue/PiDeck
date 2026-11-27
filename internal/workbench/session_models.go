//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"fmt"
	"slices"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

// applyModel switches the session's model.
func (a *app) applyModel(s *session, provider, id string, remember bool) {
	if s == nil || s.deleting || id == "" {
		return
	}
	if remember {
		a.defaultModel = modelChoice{Provider: provider, ID: id}
		a.st.edit(func(c *config) { c.Model = a.defaultModel })
	}
	if !s.Target.remote() && s.backend != "acp" {
		chosen := modelInfo{Provider: provider, ID: id}
		for _, m := range s.models.GetUntracked() {
			if m.Provider == provider && m.ID == id {
				chosen = m
				break
			}
		}
		s.model.Set(chosen)
		s.levels.Set(nil)
		if entry := a.modelOptions[s.WS]; entry != nil {
			a.seedModelThinking(s, entry.items)
		}
		s.modelSelection.revision++
		s.modelSelection.model, s.modelSelection.thinking = true, true
		a.flushModelSelection(s)
		return
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
	a.refreshSessionModels(s, true)
}

func (a *app) refreshSessionModels(s *session, announce bool) {
	if s == nil || s.backend == "acp" || s.deleting {
		return
	}
	if !s.Target.remote() {
		a.ensureSessionModelOptions(s, announce, announce)
		return
	}
	if s.modelsBusy.GetUntracked() {
		return
	}
	c := s.engine
	if c == nil {
		if s.starting {
			// A blank session boots pi on its first keystroke or menu: refresh
			// once it is up instead of refusing.
			a.ensureEngine(s, func() { a.refreshSessionModels(s, announce) })
			return
		}
		if announce {
			a.toast(ui.ToastInfo, "会话还没就绪", "等 Agent 启动后再刷新。")
		}
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
			if s.engine != c || s.deleting {
				return
			}
			if err != nil {
				if announce {
					a.toast(ui.ToastError, "刷新模型失败", err.Error())
				}
				return
			}
			s.models.Set(models.Models)
			if levelsErr == nil && len(levels.Levels) > 0 {
				s.levels.Set(levels.Levels)
			}
			if announce {
				a.toast(ui.ToastSuccess, "模型列表已刷新", fmt.Sprintf("共 %d 个模型。", len(models.Models)))
			}
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
	selection := s.modelSelection.revision
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
			if s.engine != c || s.deleting || s.modelSelection.revision != selection {
				return
			}
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

// cycleModel switches the session to the next starred model, wrapping at
// the end, the way the Electron release's Ctrl+M does. Cycling is a look,
// not a choice: it leaves the default model for new sessions alone.
func (a *app) cycleModel(s *session) {
	if s == nil {
		return
	}
	if backendOf(s) != "pi" {
		a.toast(ui.ToastInfo, "ACP 会话自己管理模型", "在 ACP 那一侧切换模型。")
		return
	}
	candidates := favouriteCycle(a.favModels.GetUntracked(), s.models.GetUntracked())
	if len(candidates) < 2 {
		a.toast(ui.ToastInfo, "没有可切换的收藏模型", "在模型菜单里收藏两个以上，再用 Ctrl+M 循环。")
		return
	}
	cur := s.model.GetUntracked()
	ix := -1
	for i, m := range candidates {
		if m.Provider == cur.Provider && m.ID == cur.ID {
			ix = i
			break
		}
	}
	next := candidates[nextInCycle(len(candidates), ix)]
	a.applyModel(s, next.Provider, next.ID, false)
}

// favouriteCycle is the stars a catalog still offers, in the order the
// user starred them: a model renamed or withdrawn since cannot be
// switched to, and a duplicate star counts once.
func favouriteCycle(favs []string, offered []modelInfo) []modelInfo {
	byKey := make(map[string]modelInfo, len(offered))
	for _, m := range offered {
		if m.Provider != "" && m.ID != "" {
			byKey[m.Provider+"/"+m.ID] = m
		}
	}
	out := make([]modelInfo, 0, len(favs))
	seen := make(map[string]bool, len(favs))
	for _, key := range favs {
		m, ok := byKey[key]
		if !ok || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, m)
	}
	return out
}

// nextInCycle is the index after cur, wrapping at the end. A cur outside
// the list starts at the first: after switching to something unstarred,
// the next press should reach the first star, not the second.
func nextInCycle(n, cur int) int {
	if n < 1 || cur < 0 {
		return 0
	}
	return (cur + 1) % n
}

// cycleThinking moves to the next level the current model accepts, the
// way the Electron release's Ctrl+T does.
func (a *app) cycleThinking(s *session) {
	if s == nil {
		return
	}
	if backendOf(s) != "pi" {
		a.toast(ui.ToastInfo, "ACP 会话自己管理模型", "在 ACP 那一侧切换思考等级。")
		return
	}
	levels := s.levels.GetUntracked()
	if len(levels) < 2 {
		a.toast(ui.ToastInfo, "这个模型只有一档思考", "")
		return
	}
	ix := slices.Index(levels, s.thinking.GetUntracked())
	a.applyThinking(s, levels[nextInCycle(len(levels), ix)], false)
}

// applyThinking sets the reasoning level.
func (a *app) applyThinking(s *session, level string, remember bool) {
	if s == nil || s.deleting || level == "" {
		return
	}
	if remember {
		a.defaultThinking = level
		a.st.edit(func(c *config) { c.Thinking = level })
	}
	if !s.Target.remote() && s.backend != "acp" {
		s.thinking.Set(level)
		s.modelSelection.revision++
		s.modelSelection.thinking = true
		a.flushModelSelection(s)
		return
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
