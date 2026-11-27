//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"time"
)

const modelOptionsCommand = "pideck-model-options"
const modelOptionsStatusKey = "pideck:model-options"

// modelOption is pi's model plus pi's own reasoning capabilities. It is a
// projection only; model/provider rules continue to belong to pi.
type modelOption struct {
	modelInfo
	Levels  []string          `json:"levels"`
	Clamped map[string]string `json:"clamped"`
}

func (c *piClient) readModelOptions() ([]modelOption, error) {
	c.modelOptionsMu.Lock()
	defer c.modelOptionsMu.Unlock()
	var commands struct {
		Commands []struct {
			Name   string `json:"name"`
			Source string `json:"source"`
		} `json:"commands"`
	}
	if err := c.call(map[string]any{"type": "get_commands"}, &commands, 20*time.Second); err != nil {
		return nil, err
	}
	found := false
	for _, cmd := range commands.Commands {
		if cmd.Name == modelOptionsCommand && cmd.Source == "extension" {
			found = true
			break
		}
	}
	// Never send an unregistered slash command: pi could interpret it as
	// a user prompt and make a model request.
	if !found {
		return nil, errors.New("pi model options extension is unavailable")
	}
	reply := make(chan []byte, 1)
	c.mu.Lock()
	c.modelOptionsReply = reply
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.modelOptionsReply = nil
		c.mu.Unlock()
	}()
	if err := c.call(map[string]any{"type": "prompt", "message": "/" + modelOptionsCommand}, nil, 25*time.Second); err != nil {
		return nil, err
	}
	select {
	case raw := <-reply:
		if len(raw) > 8<<20 {
			return nil, errors.New("pi model options exceed 8 MiB")
		}
		var result struct {
			Models []modelOption `json:"models"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			return nil, fmt.Errorf("pi model options: %w", err)
		}
		for _, m := range result.Models {
			if m.ID == "" || m.Provider == "" || len(m.Levels) == 0 {
				return nil, errors.New("pi returned incomplete model options")
			}
		}
		return result.Models, nil
	default:
		return nil, errors.New("pi returned no model options")
	}
}

// probeModelOptions has no persistent session and never sends a model prompt.
// User/project extensions stay enabled, since they may register providers.
func probeModelOptions(ctx context.Context, piPath, dir, sessions, dataDir string) ([]modelOption, error) {
	path := filepath.Join(dataDir, "extensions", "pi-deck-model-options.ts")
	c, err := startPi(localTarget, piPath, dir, sessions, "", "", nil, nil, nil,
		piLocalTools{extension: path, modelProbe: true, env: []string{"PI_CODING_AGENT_DIR=" + piConfigDir()}})
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, c.stop)
	defer stop()
	defer c.stop()
	return c.readModelOptions()
}
