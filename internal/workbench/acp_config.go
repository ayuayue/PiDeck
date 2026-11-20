//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"maps"
	"slices"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

const acpConfigTimeout = 20 * time.Second

// ACP agents can expose selects such as model, mode and thought level.
// A server may send a flat list or groups of the same option values.
type acpConfigOption struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Category     string          `json:"category"`
	Type         string          `json:"type"`
	CurrentValue string          `json:"currentValue"`
	Values       json.RawMessage `json:"options"`
}

type acpConfigChoice struct {
	Value       string `json:"value"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (o acpConfigOption) Choices() []acpConfigChoice {
	if o.Type != "select" {
		return nil
	}
	var wire []struct {
		acpConfigChoice
		Options []acpConfigChoice `json:"options"`
	}
	if err := json.Unmarshal(o.Values, &wire); err != nil {
		return nil
	}
	var out []acpConfigChoice
	for _, group := range wire {
		if group.Value != "" {
			out = append(out, group.acpConfigChoice)
		}
		for _, choice := range group.Options {
			if choice.Value != "" {
				out = append(out, choice)
			}
		}
	}
	return out
}

type acpSessionConfig struct {
	Modes   acpModeState      `json:"modes"`
	Options []acpConfigOption `json:"configOptions"`
}

func (c acpSessionConfig) modeState() acpModeState {
	c.Modes.Options = c.Options
	return c.Modes
}

func (c *acpClient) setConfigOption(sessionID, id, value string) ([]acpConfigOption, error) {
	var out acpSessionConfig
	err := c.call("session/set_config_option", map[string]string{
		"sessionId": sessionID, "configId": id, "value": value,
	}, &out, acpConfigTimeout)
	return out.Options, err
}

type acpPreference struct {
	Mode   string            `json:"mode,omitempty"`
	Values map[string]string `json:"values,omitempty"`
}

func (a *app) rememberACPPreference(preset string, update func(*acpPreference)) {
	if a.st == nil || preset == "" {
		return
	}
	a.st.change(func(c *config) {
		if c.ACPChoices == nil {
			c.ACPChoices = map[string]acpPreference{}
		}
		pref := c.ACPChoices[preset]
		update(&pref)
		c.ACPChoices[preset] = pref
	})
	go func() {
		if err := a.st.save(); err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "保存失败", err.Error()) })
		}
	}()
}

func (o acpConfigOption) hasValue(value string) bool {
	return value != "" && slices.ContainsFunc(o.Choices(), func(c acpConfigChoice) bool { return c.Value == value })
}

// Do not replay arbitrary agent-specific options (in particular approvals).
func (o acpConfigOption) remembered() bool {
	switch o.Category {
	case "model", "thought_level", "mode", "reasoning_effort":
		return true
	}
	return false
}

func (a *app) restoreACPChoices(c *acpClient, preset, sid string, state acpModeState) acpModeState {
	if a.st == nil {
		return state
	}
	pref := a.st.config().ACPChoices[preset]
	if pref.Mode != "" && pref.Mode != state.CurrentModeID && slices.ContainsFunc(state.AvailableModes, func(m acpMode) bool { return m.ID == pref.Mode }) {
		if err := c.setMode(sid, pref.Mode); err == nil {
			state.CurrentModeID = pref.Mode
		}
	}
	// A model change can change the available reasoning settings, so
	// validate every choice against the most recent response.
	for _, category := range []string{"model", "mode", "thought_level", "reasoning_effort"} {
		for _, opt := range state.Options {
			if opt.Category != category {
				continue
			}
			value := pref.Values[opt.ID]
			if value == opt.CurrentValue || !opt.hasValue(value) {
				continue
			}
			if options, err := c.setConfigOption(sid, opt.ID, value); err == nil && options != nil {
				state.Options = options
			}
			break
		}
	}
	return state
}

func (a *app) chooseACPOption(s *session, id, value string) {
	if s.acp == nil || s.acpSID == "" || s.busyNow() || s.acpOptionBusy.GetUntracked() {
		return
	}
	var option acpConfigOption
	for _, opt := range s.acpOptions.GetUntracked() {
		if opt.ID == id && opt.CurrentValue != value && opt.hasValue(value) {
			option = opt
			break
		}
	}
	if option.ID == "" {
		return
	}
	s.acpOptionBusy.Set(true)
	c, sid, preset := s.acp, s.acpSID, s.acpPreset
	go func() {
		options, err := c.setConfigOption(sid, id, value)
		a.cx.Post(func() {
			if s.acp != c {
				return
			}
			s.acpOptionBusy.Set(false)
			if err != nil {
				a.toast(ui.ToastError, "保存失败", err.Error())
				return
			}
			if options != nil {
				s.acpOptions.Set(options)
			}
			if option.remembered() && slices.ContainsFunc(options, func(o acpConfigOption) bool { return o.ID == id && o.CurrentValue == value }) {
				a.rememberACPPreference(preset, func(p *acpPreference) {
					if p.Values == nil {
						p.Values = map[string]string{}
					}
					p.Values[id] = value
				})
			}
		})
	}()
}

func cloneACPPreferences(in map[string]acpPreference) map[string]acpPreference {
	out := maps.Clone(in)
	for k, v := range out {
		v.Values = maps.Clone(v.Values)
		out[k] = v
	}
	return out
}
