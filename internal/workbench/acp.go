//go:build !js && !android && !ios

package workbench

// ACP (Agent Client Protocol): one external coding agent CLI per session,
// spoken to over NDJSON JSON-RPC on stdin and stdout. This is the client
// only: the UI projection comes next, so the protocol is testable on its
// own.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
)

// acpCommand is one command an ACP agent offers.
type acpCommand struct {
	Name        string
	Description string
	Hint        string
}

// acpUpdate is one session/update notification's payload.
type acpUpdate struct {
	SessionID string
	Kind      string // agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan…
	Text      string
	ToolID    string
	Title     string
	ToolName  string   // the programmatic tool name
	ToolKind  string   // read, edit, execute…
	Locations []string // paths the tool touched
	Status    string
	Mode      string
	Commands  []acpCommand
	Options   []acpConfigOption
	Raw       json.RawMessage
}

// acpMode is one operating mode an ACP agent offers.
type acpMode struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// acpModeState is a session's mode state, as returned by session/new or
// session/load.
type acpModeState struct {
	CurrentModeID  string            `json:"currentModeId"`
	AvailableModes []acpMode         `json:"availableModes"`
	Options        []acpConfigOption `json:"-"`
}

// acpPermissionOption is one answer a permission request offers.
type acpPermissionOption struct {
	ID   string
	Name string
	Kind string
}

// acpPermission is a request from the agent to use a tool.
type acpPermission struct {
	ID        int
	SessionID string
	ToolID    string
	Title     string
	Options   []acpPermissionOption
	Done      <-chan struct{}
}

// acpClient is one agent process and its JSON-RPC connection.
type acpClient struct {
	cmd    *exec.Cmd
	in     io.WriteCloser
	stderr *ringBuffer

	mu              sync.Mutex
	writeMu         sync.Mutex
	seq             int
	pending         map[int]chan acpResponse
	closed          bool
	loadSupported   bool // immutable after initialize
	resumeSupported bool
	imageSupported  bool
	done            chan struct{}
	exited          chan struct{}

	onUpdate     func(acpUpdate)
	onPermission func(acpPermission) string
	onExit       func(error)
}

type acpResponse struct {
	Result json.RawMessage
	Err    *acpError
}

type acpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *acpError) Error() string { return fmt.Sprintf("ACP 错误 %d：%s", e.Code, e.Message) }

type acpMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int            `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *acpError       `json:"error,omitempty"`
}

// ACP presets are the external CLIs the app can drive. A preset is only a
// launch command: the app runs it in the project and speaks ACP over its
// stdio. Npx presets download their package on first use; the others need
// the CLI installed here, signed in, before the preset works.
type acpPreset struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	// Homepage is the CLI's documentation.
	Homepage string `json:"homepage,omitempty"`
	// Install is the npm package that provides the command, empty when the
	// CLI installs from its own site.
	Install string `json:"install,omitempty"`
	// Npx marks presets npx fetches on demand: they need Node.js, not the
	// CLI itself.
	Npx bool `json:"npx,omitempty"`
}

// acpPresets is the built-in list, checked against each CLI's ACP docs:
//
//	gemini --acp                       @google/gemini-cli
//	npx -y @agentclientprotocol/claude-agent-acp
//	npx -y @agentclientprotocol/codex-acp
//	kimi acp                           @moonshot-ai/kimi-code
//	qwen --acp                         @qwen-code/qwen-code
//	opencode acp                       opencode-ai
//	agent acp                          Cursor, its own installer
//	npx -y @tencent-ai/codebuddy-code --acp
//	npx -y @minimax-ai/code acp
//	mimo acp                           @mimo-ai/cli
//	copilot --acp                      @github/copilot
//	kilo acp                           @kilocode/cli
//	cline --acp                        cline
//	qodercli --acp --permission-mode bypass_permissions
//	qoderclicn --acp --permission-mode bypass_permissions
//	dsh --profile acp                  @deepseek-ai/dsh
//
// Qoder's adapter lists bypass permissions as a config option but refuses
// to set it, so the flag has to be given at launch.
func acpPresets() []acpPreset {
	return []acpPreset{
		{ID: "gemini", Name: "Gemini CLI", Command: "gemini", Args: []string{"--acp"},
			Homepage: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md", Install: "@google/gemini-cli"},
		{ID: "claude", Name: "Claude Agent", Command: "npx", Args: []string{"-y", "@agentclientprotocol/claude-agent-acp"},
			Homepage: "https://github.com/agentclientprotocol/claude-agent-acp", Npx: true},
		{ID: "codex", Name: "Codex CLI", Command: "npx", Args: []string{"-y", "@agentclientprotocol/codex-acp"},
			Homepage: "https://github.com/agentclientprotocol/codex-acp", Npx: true},
		{ID: "kimi", Name: "Kimi CLI", Command: "kimi", Args: []string{"acp"},
			Homepage: "https://github.com/moonshotai/kimi-code", Install: "@moonshot-ai/kimi-code"},
		{ID: "qwen", Name: "Qwen Code", Command: "qwen", Args: []string{"--acp"},
			Homepage: "https://github.com/QwenLM/qwen-code", Install: "@qwen-code/qwen-code"},
		{ID: "opencode", Name: "OpenCode", Command: "opencode", Args: []string{"acp"},
			Homepage: "https://opencode.ai/docs/cli/acp", Install: "opencode-ai"},
		{ID: "cursor-agent", Name: "Cursor Agent", Command: "agent", Args: []string{"acp"},
			Homepage: "https://cursor.com/docs/cli/acp"},
		{ID: "codebuddy", Name: "CodeBuddy", Command: "npx", Args: []string{"-y", "@tencent-ai/codebuddy-code", "--acp"},
			Homepage: "https://codebuddy.ai/docs/cli/acp", Npx: true},
		{ID: "minimax", Name: "MiniMax Code", Command: "npx", Args: []string{"-y", "@minimax-ai/code", "acp"},
			Homepage: "https://agent.minimax.io/docs/cli/integrations", Npx: true},
		{ID: "mimo", Name: "MiMo Code", Command: "mimo", Args: []string{"acp"},
			Homepage: "https://github.com/XiaomiMiMo/MiMo-Code", Install: "@mimo-ai/cli"},
		{ID: "copilot", Name: "Copilot CLI", Command: "copilot", Args: []string{"--acp"},
			Homepage: "https://github.com/github/copilot-cli", Install: "@github/copilot"},
		{ID: "kilo", Name: "Kilo Code", Command: "kilo", Args: []string{"acp"},
			Homepage: "https://github.com/Kilo-Org/kilocode", Install: "@kilocode/cli"},
		{ID: "cline-cli", Name: "Cline", Command: "cline", Args: []string{"--acp"},
			Homepage: "https://github.com/cline/cline", Install: "cline"},
		{ID: "qoder", Name: "Qoder CLI", Command: "qodercli", Args: []string{"--acp", "--permission-mode", "bypass_permissions"},
			Homepage: "https://docs.qoder.com/cli/acp"},
		{ID: "qoder-cn", Name: "Qoder CLI CN", Command: "qoderclicn", Args: []string{"--acp", "--permission-mode", "bypass_permissions"},
			Homepage: "https://docs.qoder.cn/cli/acp"},
		{ID: "dsh", Name: "DeepSeek Harness", Command: "dsh", Args: []string{"--profile", "acp"},
			Homepage: "https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.zh.md", Install: "@deepseek-ai/dsh"},
	}
}

// startACP spawns an agent in dir and connects to it.
func startACP(dir, command string, args []string, onUpdate func(acpUpdate), onPermission func(acpPermission) string, onExit func(error)) (*acpClient, error) {
	if strings.TrimSpace(command) == "" {
		return nil, fmt.Errorf("没有 ACP 命令")
	}
	cmd, err := acpProcessCommand(context.Background(), command, args)
	if err != nil {
		return nil, err
	}
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), agentProxy.env()...)
	cmd.Env = append(cmd.Env, "PIDECK_V2=1")
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &ringBuffer{limit: 64 << 10}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := &acpClient{cmd: cmd, in: in, stderr: stderr, pending: map[int]chan acpResponse{},
		done: make(chan struct{}), exited: make(chan struct{}),
		onUpdate: onUpdate, onPermission: onPermission, onExit: onExit}
	trackACP(c)
	go func() {
		c.read(out)
		// Reap the process when stdout closes, even if it exited by itself.
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		close(c.exited)
		untrackACP(c)
	}()
	return c, nil
}

// read dispatches one JSON object per line.
func (c *acpClient) read(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 16<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var msg acpMessage
		if json.Unmarshal(line, &msg) != nil {
			continue
		}
		switch {
		case msg.ID != nil && msg.Method == "":
			c.mu.Lock()
			ch := c.pending[*msg.ID]
			delete(c.pending, *msg.ID)
			c.mu.Unlock()
			if ch != nil {
				select {
				case ch <- acpResponse{Result: msg.Result, Err: msg.Error}:
				default:
				}
			}
		case msg.Method == "session/update":
			c.dispatchUpdate(msg.Params)
		case msg.Method == "session/request_permission" && msg.ID != nil:
			go c.dispatchPermission(*msg.ID, msg.Params)
		case msg.ID != nil && msg.Method != "":
			c.respond(*msg.ID, nil, &acpError{Code: -32601, Message: "Method not found"})
		}
	}
	c.mu.Lock()
	closed := c.closed
	c.closed = true
	c.mu.Unlock()
	close(c.done)
	if c.onExit != nil {
		if closed {
			c.onExit(nil)
			return
		}
		why := c.stderrText()
		if why == "" {
			why = "ACP 进程退出了"
		}
		c.onExit(fmt.Errorf("%s", why))
	}
}

// dispatchUpdate turns a session/update into an acpUpdate.
func (c *acpClient) dispatchUpdate(raw json.RawMessage) {
	if c.onUpdate == nil {
		return
	}
	var params struct {
		SessionID string `json:"sessionId"`
		Update    struct {
			SessionUpdate string            `json:"sessionUpdate"`
			Content       json.RawMessage   `json:"content"`
			ToolCallID    string            `json:"toolCallId"`
			Title         string            `json:"title"`
			Name          string            `json:"name"`
			ToolKind      string            `json:"kind"`
			Status        string            `json:"status"`
			CurrentModeID string            `json:"currentModeId"`
			Options       []acpConfigOption `json:"configOptions"`
			Locations     []struct {
				Path string `json:"path"`
			} `json:"locations"`
			Commands []struct {
				Name        string `json:"name"`
				Description string `json:"description"`
				Input       *struct {
					Hint string `json:"hint"`
				} `json:"input"`
			} `json:"availableCommands"`
		} `json:"update"`
	}
	if json.Unmarshal(raw, &params) != nil {
		return
	}
	u := acpUpdate{SessionID: params.SessionID, Kind: params.Update.SessionUpdate,
		Text: acpContentText(params.Update.Content), ToolID: params.Update.ToolCallID,
		Title: params.Update.Title, ToolName: params.Update.Name, ToolKind: params.Update.ToolKind,
		Status: params.Update.Status, Mode: params.Update.CurrentModeID, Options: params.Update.Options, Raw: raw}
	for _, l := range params.Update.Locations {
		if l.Path != "" {
			u.Locations = append(u.Locations, l.Path)
		}
	}
	for _, c := range params.Update.Commands {
		cmd := acpCommand{Name: c.Name, Description: c.Description}
		if c.Input != nil {
			cmd.Hint = c.Input.Hint
		}
		u.Commands = append(u.Commands, cmd)
	}
	c.onUpdate(u)
}

// dispatchPermission asks the app for an answer and replies.
func (c *acpClient) dispatchPermission(id int, raw json.RawMessage) {
	var params struct {
		SessionID string `json:"sessionId"`
		ToolCall  struct {
			ToolCallID string `json:"toolCallId"`
			Title      string `json:"title"`
		} `json:"toolCall"`
		Options []struct {
			OptionID string `json:"optionId"`
			Name     string `json:"name"`
			Kind     string `json:"kind"`
		} `json:"options"`
	}
	if json.Unmarshal(raw, &params) != nil {
		return
	}
	req := acpPermission{ID: id, SessionID: params.SessionID, ToolID: params.ToolCall.ToolCallID, Title: params.ToolCall.Title, Done: c.done}
	for _, o := range params.Options {
		req.Options = append(req.Options, acpPermissionOption{ID: o.OptionID, Name: o.Name, Kind: o.Kind})
	}
	choice := ""
	if c.onPermission != nil {
		choice = c.onPermission(req)
	}
	var result any
	if choice == "" {
		result = map[string]any{"outcome": map[string]string{"outcome": "cancelled"}}
	} else {
		result = map[string]any{"outcome": map[string]string{"outcome": "selected", "optionId": choice}}
	}
	c.respond(id, result, nil)
}

// acpContentText reads a chunk's text, whichever shape it has.
func acpContentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	type block struct {
		Type    string `json:"type"`
		Text    string `json:"text"`
		Content *struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	var one block
	if json.Unmarshal(raw, &one) == nil {
		if one.Text != "" {
			return one.Text
		}
		if one.Content != nil && one.Content.Text != "" {
			return one.Content.Text
		}
	}
	var blocks []block
	if json.Unmarshal(raw, &blocks) == nil {
		var b strings.Builder
		for _, bl := range blocks {
			if bl.Text != "" {
				b.WriteString(bl.Text)
			}
			if bl.Content != nil && bl.Content.Text != "" {
				b.WriteString(bl.Content.Text)
			}
		}
		return b.String()
	}
	return ""
}

// call sends one request and waits for its answer.
func (c *acpClient) call(method string, params any, out any, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	id, ch := c.next()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()
	payload := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		payload["params"] = params
	}
	if err := c.write(payload); err != nil {
		return err
	}
	finish := func(res acpResponse) error {
		if res.Err != nil {
			return res.Err
		}
		if out != nil && len(res.Result) > 0 {
			return json.Unmarshal(res.Result, out)
		}
		return nil
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case res := <-ch:
		return finish(res)
	case <-c.done:
		// The final response may already have arrived just before EOF.
		select {
		case res := <-ch:
			return finish(res)
		default:
			return fmt.Errorf("ACP 连接已关闭")
		}
	case <-timer.C:
		return fmt.Errorf("ACP %s 超时", method)
	}
}

// notify sends a notification without an answer.
func (c *acpClient) notify(method string, params any) error {
	payload := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		payload["params"] = params
	}
	return c.write(payload)
}

// respond answers an agent's request.
func (c *acpClient) respond(id int, result any, err *acpError) {
	payload := map[string]any{"jsonrpc": "2.0", "id": id}
	if err != nil {
		payload["error"] = err
	} else {
		payload["result"] = result
	}
	_ = c.write(payload)
}

// next reserves a request id and its answer channel.
func (c *acpClient) next() (int, chan acpResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	ch := make(chan acpResponse, 1)
	c.pending[c.seq] = ch
	return c.seq, ch
}

// write sends one JSON line.
func (c *acpClient) write(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.isClosed() {
		return fmt.Errorf("ACP 连接已关闭")
	}
	_, err = c.in.Write(append(data, '\n'))
	return err
}

func (c *acpClient) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// initialize shakes hands with the agent.
func (c *acpClient) initialize(name, version string) (int, error) {
	var out struct {
		ProtocolVersion int `json:"protocolVersion"`
		Capabilities    struct {
			Load     bool `json:"loadSession"`
			Sessions struct {
				Resume *struct{} `json:"resume"`
			} `json:"sessionCapabilities"`
			Prompt struct {
				Image bool `json:"image"`
			} `json:"promptCapabilities"`
		} `json:"agentCapabilities"`
	}
	err := c.call("initialize", map[string]any{
		"protocolVersion":    1,
		"clientCapabilities": map[string]any{},
		"clientInfo":         map[string]string{"name": name, "version": version},
	}, &out, 30*time.Second)
	if err == nil {
		c.loadSupported = out.Capabilities.Load
		c.resumeSupported = out.Capabilities.Sessions.Resume != nil
		c.imageSupported = out.Capabilities.Prompt.Image
	}
	return out.ProtocolVersion, err
}

// newSession starts a session in cwd and returns its id and mode state.
func (c *acpClient) newSession(cwd string) (string, acpModeState, error) {
	var out struct {
		SessionID string `json:"sessionId"`
		acpSessionConfig
	}
	err := c.call("session/new", map[string]any{"cwd": cwd, "mcpServers": []any{}}, &out, 60*time.Second)
	if err == nil && out.SessionID == "" {
		err = fmt.Errorf("ACP 没有返回会话 ID")
	}
	return out.SessionID, out.modeState(), err
}

// loadSession reattaches to a session the CLI kept and returns its mode
// state.
func (c *acpClient) loadSession(sessionID, cwd string) (acpModeState, error) {
	var out acpSessionConfig
	method := "session/load"
	if c.resumeSupported && !c.loadSupported {
		method = "session/resume"
	}
	err := c.call(method, map[string]any{
		"sessionId": sessionID, "cwd": cwd, "mcpServers": []any{},
	}, &out, 60*time.Second)
	return out.modeState(), err
}

// setMode switches the agent's operating mode.
func (c *acpClient) setMode(sessionID, modeID string) error {
	return c.call("session/set_mode", map[string]any{
		"sessionId": sessionID, "modeId": modeID,
	}, nil, 20*time.Second)
}

// prompt sends a prompt and waits for the turn's stop reason.
func (c *acpClient) prompt(sessionID, text string, images ...remotewire.Image) (string, error) {
	var out struct {
		StopReason string `json:"stopReason"`
	}
	prompt := append([]map[string]any{{"type": "text", "text": text}}, encodeImages(images)...)
	err := c.call("session/prompt", map[string]any{
		"sessionId": sessionID,
		"prompt":    prompt,
	}, &out, 6*time.Hour)
	return out.StopReason, err
}

// cancel asks the agent to stop the turn.
func (c *acpClient) cancel(sessionID string) {
	_ = c.notify("session/cancel", map[string]string{"sessionId": sessionID})
}

// stderrText is the newest stderr, one line.
func (c *acpClient) stderrText() string {
	if c == nil || c.stderr == nil {
		return ""
	}
	return viewkit.FirstLine(c.stderr.String(), 160)
}

// stop closes the connection and the process.
func (c *acpClient) stop() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	_ = c.in.Close()
	select {
	case <-c.exited:
	case <-time.After(3 * time.Second):
		_ = c.cmd.Process.Kill()
		select {
		case <-c.exited:
		case <-time.After(2 * time.Second):
		}
	}
}

// The app's live ACP processes, so quitting can stop them all.
var (
	acpMu      sync.Mutex
	acpTracked = map[*acpClient]struct{}{}
)

func trackACP(c *acpClient) {
	acpMu.Lock()
	acpTracked[c] = struct{}{}
	acpMu.Unlock()
}

func untrackACP(c *acpClient) {
	acpMu.Lock()
	delete(acpTracked, c)
	acpMu.Unlock()
}

// closeAllACP stops every agent process.
func closeAllACP() {
	acpMu.Lock()
	all := make([]*acpClient, 0, len(acpTracked))
	for c := range acpTracked {
		all = append(all, c)
	}
	acpTracked = map[*acpClient]struct{}{}
	acpMu.Unlock()
	for _, c := range all {
		c.stop()
	}
}
