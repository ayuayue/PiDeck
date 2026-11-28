//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/remotewire"
)

var errRemoteACPCommands = errors.New("ACP commands belong to the agent")

// remotePiCommand waits off the UI thread. In particular, extension commands
// must use prompt even while streaming; steer/follow_up reject them in pi.
func (h *remoteHost) remotePiCommand(r *http.Request, id string, command map[string]any) (json.RawMessage, error) {
	request, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	type result struct {
		data json.RawMessage
		err  error
	}
	done := make(chan result, 1)
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		ws := h.app.workspaceFor(s.Target, s.WS)
		if (s.Target.remote() && ws == nil) || !h.app.projectTrusted(ws) {
			failure = errors.New(apptext.T("这个项目还没有在电脑上被信任"))
			return
		}
		if s.backend == "acp" {
			failure = errRemoteACPCommands
			return
		}
		if s.deleting || s.agentStopping || s.historyLoading || s.retryPendingNow() || s.status.GetUntracked() == statusWaiting {
			failure = errors.New(apptext.T("先等这一轮结束"))
			return
		}
		h.app.ensureEngine(s, func() {
			if request.Err() != nil {
				return
			}
			c := s.engine
			if c == nil {
				done <- result{err: errors.New(apptext.T("会话还没就绪"))}
				return
			}
			if command["type"] == "prompt" {
				command["streamingBehavior"] = delivery(s)
			}
			go func() {
				var data json.RawMessage
				err := c.call(command, &data, 60*time.Second)
				done <- result{data: data, err: err}
			}()
		})
	})
	if !ok {
		return nil, errors.New("界面正忙，请稍后再试")
	}
	if failure != nil {
		return nil, failure
	}
	select {
	case reply := <-done:
		return reply.data, reply.err
	case <-request.Done():
		return nil, request.Err()
	}
}

func (h *remoteHost) sessionCommands(w http.ResponseWriter, r *http.Request, id string) {
	data, err := h.remotePiCommand(r, id, map[string]any{"type": "get_commands"})
	if errors.Is(err, errRemoteACPCommands) {
		writeRemoteJSON(w, http.StatusOK, remotewire.Commands{Commands: []remotewire.Command{}})
		return
	}
	if err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var out remotewire.Commands
	if err := json.Unmarshal(data, &out); err != nil {
		writeRemoteJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	// compact is a host RPC and is intentionally absent from get_commands.
	commands := []remotewire.Command{{Name: "compact", Description: apptext.T("压缩上下文"), Source: "builtin"}}
	seen := map[string]bool{"compact": true}
	for _, cmd := range out.Commands {
		cmd.Name = strings.TrimPrefix(strings.TrimSpace(cmd.Name), "/")
		if cmd.Name == "" || strings.ContainsAny(cmd.Name, " \t\r\n") || seen[cmd.Name] {
			continue
		}
		seen[cmd.Name] = true
		commands = append(commands, cmd)
	}
	writeRemoteJSON(w, http.StatusOK, remotewire.Commands{Commands: commands})
}
