//go:build !js && !android && !ios

package workbench

// A pi RPC client: spawns `pi --mode rpc` for one session and speaks its
// JSONL protocol. Commands are correlated by id, events are handed to the
// app, and extension UI requests are forwarded so they can be answered.
//
// Everything here runs off the UI thread: the reader goroutine posts to the
// app's scope, and callers decide when a call may block.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"example.com/pideck-v2/internal/viewkit"
)

// piUsage is the usage a provider reports for one assistant response.
type piUsage struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
	Total      int `json:"totalTokens"`
	Cost       struct {
		Input      float64 `json:"input"`
		Output     float64 `json:"output"`
		CacheRead  float64 `json:"cacheRead"`
		CacheWrite float64 `json:"cacheWrite"`
		Total      float64 `json:"total"`
	} `json:"cost"`
}

// piContent is one content block of an assistant message.
type piContent struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	Data      string          `json:"data"`
	MimeType  string          `json:"mimeType"`
}

// piMessage is an AgentMessage as the protocol sends and stores it.
type piMessage struct {
	EntryID   string          `json:"-"`
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	Timestamp int64           `json:"timestamp"`
	// DurationMs is how long the message took to arrive: pi records it on the
	// message itself, for a model's answer and for a tool's run alike.
	DurationMs int64    `json:"durationMs"`
	Model      string   `json:"model"`
	Provider   string   `json:"provider"`
	Usage      *piUsage `json:"usage"`
	StopReason string   `json:"stopReason"`
	ErrorMsg   string   `json:"errorMessage"`

	// toolResult
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName"`
	IsError    bool            `json:"isError"`
	Details    json.RawMessage `json:"details,omitempty"`

	// bashExecution
	Command          string `json:"command"`
	Output           string `json:"output"`
	ExitCode         *int   `json:"exitCode"`
	Cancelled        bool   `json:"cancelled"`
	Truncated        bool   `json:"truncated"`
	FullOutputPath   string `json:"fullOutputPath"`
	ExcludeFromCtx   bool   `json:"excludeFromContext"`
	CustomType       string `json:"customType"`
	Display          bool   `json:"display"`
	Summary          string `json:"summary"`
	TokensBefore     int    `json:"tokensBefore"`
	BranchSummaryFrm string `json:"fromId"`
}

// blocks reads the message's content blocks, whichever shape it holds.
func (m *piMessage) blocks() []piContent {
	if len(m.Content) == 0 {
		return nil
	}
	var text string
	if json.Unmarshal(m.Content, &text) == nil {
		if text == "" {
			return nil
		}
		return []piContent{{Type: "text", Text: text}}
	}
	var blocks []piContent
	if json.Unmarshal(m.Content, &blocks) != nil {
		return nil
	}
	return blocks
}

// text is the message's plain text, blocks joined without separators.
func (m *piMessage) text() string {
	return piBlockText(m.blocks())
}

func piBlockText(blocks []piContent) string {
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "")
}

// toolCalls are the message's tool calls, in order.
func (m *piMessage) toolCalls() []piContent {
	var calls []piContent
	for _, b := range m.blocks() {
		if b.Type == "toolCall" {
			calls = append(calls, b)
		}
	}
	return calls
}

// piToolResult is what a tool returned.
type piToolResult struct {
	Content []piContent `json:"content"`
	Details json.RawMessage
}

func (r *piToolResult) text() string {
	if r == nil {
		return ""
	}
	var parts []string
	for _, b := range r.Content {
		if b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// piCompaction is a compaction result.
type piCompaction struct {
	Summary        string   `json:"summary"`
	TokensBefore   int      `json:"tokensBefore"`
	EstimatedAfter int      `json:"estimatedTokensAfter"`
	Usage          *piUsage `json:"usage"`
}

// piEvent is one stdout record that is not a response or a UI request.
type piEvent struct {
	Type         string `json:"type"`
	finishedTool *toolRun

	AssistantMessageEvent *struct {
		Type         string          `json:"type"`
		ContentIndex int             `json:"contentIndex"`
		Delta        string          `json:"delta"`
		Content      string          `json:"content"`
		ID           string          `json:"id"`
		ToolName     string          `json:"toolName"`
		ToolCall     json.RawMessage `json:"toolCall"`
		Reason       string          `json:"reason"`
		Error        json.RawMessage `json:"error"`
	} `json:"assistantMessageEvent"`

	Message       json.RawMessage `json:"message"`
	Usage         *piUsage        `json:"usage"`
	ToolCallID    string          `json:"toolCallId"`
	ToolName      string          `json:"toolName"`
	Args          json.RawMessage `json:"args"`
	PartialResult *piToolResult   `json:"partialResult"`
	Result        json.RawMessage `json:"result"`
	IsError       bool            `json:"isError"`
	DurationMs    int64           `json:"durationMs"`

	Aborted   bool `json:"aborted"`
	WillRetry bool `json:"willRetry"`

	// compaction
	Reason       string `json:"reason"`
	ErrorMessage string `json:"errorMessage"`

	// retry
	Attempt     int   `json:"attempt"`
	MaxAttempts int   `json:"maxAttempts"`
	DelayMs     int64 `json:"delayMs"`

	// queue and session info
	Steering []string `json:"steering"`
	FollowUp []string `json:"followUp"`
	Name     string   `json:"name"`
	Level    string   `json:"level"`
}

// uiRequest is an extension_ui_request: a dialog the client answers, or a
// notification.
type uiRequest struct {
	Type        string   `json:"type"`
	ID          string   `json:"id"`
	Method      string   `json:"method"`
	Title       string   `json:"title"`
	Message     string   `json:"message"`
	Placeholder string   `json:"placeholder"`
	Prefill     string   `json:"prefill"`
	Options     []string `json:"options"`
	AllowOther  bool     `json:"allowOther"`
	Timeout     int      `json:"timeout"`
	NotifyType  string   `json:"notifyType"`
	StatusKey   string   `json:"statusKey"`
	StatusText  *string  `json:"statusText"`
	WidgetKey   string   `json:"widgetKey"`
	WidgetLines []string `json:"widgetLines"`
	Text        string   `json:"text"`
}

// response is a command's answer.
type response struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Command string          `json:"command"`
	Success bool            `json:"success"`
	Error   string          `json:"error"`
	Data    json.RawMessage `json:"data"`
}

// piClient is one `pi --mode rpc` child process.
type piClient struct {
	cmd     *exec.Cmd
	in      io.WriteCloser
	mu      sync.Mutex
	seq     int
	pending map[string]chan response
	closed  bool

	hooks    atomic.Value // hooks
	stderr   *ringBuffer
	exitOnce sync.Once
}

// startPi starts pi for one session: on this machine or through a target,
// keeping the app's sessions under appSessions. onEvent, onUI and onExit
// run on the reader goroutine.
type piLocalTools struct {
	extension string
	env       []string
}

func startPi(t target, piPath, dir, appSessions, id, sessionFile string, onEvent func(piEvent), onUI func(uiRequest), onExit func(error), local ...piLocalTools) (*piClient, error) {
	if piPath == "" {
		piPath = "pi"
	}
	if !t.remote() {
		if path, err := resolvePiExecutable(piPath); err == nil {
			piPath = path
		} else {
			return nil, err
		}
	}
	args := []string{"--mode", "rpc"}
	if !t.remote() {
		if path := extensionToInject(askExtensionPath); path != "" {
			args = append(args, "-e", path)
		}
		if path := extensionToInject(retryExtensionPath); path != "" {
			args = append(args, "-e", path)
		}
	}
	var env []string
	if !t.remote() && len(local) > 0 {
		if path := extensionToInject(local[0].extension); path != "" {
			args = append(args, "-e", path)
			env = local[0].env
		}
	}
	if !t.remote() {
		args = append(args, bundledExtensionArgs()...)
		if pideckSkillPath != "" {
			args = append(args, "--skill", pideckSkillPath)
		}
		if securityPolicyPath != "" {
			env = append(env, "PIDECK_SECURITY_CONFIG="+securityPolicyPath, "PIDECK_SESSION_ID="+id)
		}
	}
	cmd, err := t.command(piPath, dir, appSessions, id, sessionFile, args)
	if err != nil {
		return nil, err
	}
	proxyEnv := agentProxy.env()
	cmd.Env = append(append(os.Environ(), proxyEnv...), env...)
	if !t.remote() && len(proxyEnv) > 0 {
		// The shell-proxy extension clears these for bash only; the model
		// client keeps using the proxy.
		cmd.Env = append(cmd.Env, piProxyScopeEnv+"="+piProxyScopeModelOnly)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("启动 pi 失败：%w", err)
	}

	c := &piClient{cmd: cmd, in: stdin, pending: map[string]chan response{},
		stderr: &ringBuffer{limit: 64 << 10}}
	c.hooks.Store(hooks{onEvent: onEvent, onUI: onUI, onExit: onExit})

	go c.read(stdout)
	go func() { _, _ = io.Copy(c.stderr, stderr) }()
	track(c)
	return c, nil
}

// read splits stdout on LF only, as the protocol requires.
func (c *piClient) read(r io.Reader) {
	br := bufio.NewReaderSize(r, 256<<10)
	var err error
	for {
		line, readErr := br.ReadBytes('\n')
		if len(line) > 0 {
			line = bytes.TrimSuffix(line, []byte("\n"))
			line = bytes.TrimSuffix(line, []byte("\r"))
			if len(bytes.TrimSpace(line)) > 0 {
				c.dispatch(line)
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				err = readErr
			}
			break
		}
	}
	c.shutdown(err)
}

func (c *piClient) dispatch(line []byte) {
	var kind struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(line, &kind) != nil {
		return
	}
	switch kind.Type {
	case "response":
		var r response
		if json.Unmarshal(line, &r) != nil {
			return
		}
		c.mu.Lock()
		ch := c.pending[r.ID]
		delete(c.pending, r.ID)
		c.mu.Unlock()
		if ch != nil {
			select {
			case ch <- r:
			default:
			}
		} else if !r.Success && r.ID == "" {
			// A response without an id (a parse error) has nowhere to go.
			if exit := c.callbacks().onExit; exit != nil {
				go exit(fmt.Errorf("pi 协议错误：%s", r.Error))
			}
		}
	case "extension_ui_request":
		var req uiRequest
		if json.Unmarshal(line, &req) == nil {
			if ui := c.callbacks().onUI; ui != nil {
				ui(req)
			}
		}
	default:
		var ev piEvent
		if json.Unmarshal(line, &ev) == nil && ev.Type != "" {
			if on := c.callbacks().onEvent; on != nil {
				on(ev)
			}
		}
	}
}

// shutdown fails outstanding calls and tells the app once.
func (c *piClient) shutdown(err error) {
	c.exitOnce.Do(func() {
		untrack(c)
		c.mu.Lock()
		c.closed = true
		pending := c.pending
		c.pending = map[string]chan response{}
		c.mu.Unlock()
		for _, ch := range pending {
			close(ch)
		}
		if exit := c.callbacks().onExit; exit != nil {
			exit(err)
		}
	})
}

// call sends one command and waits for its response. It must not run on the
// UI thread.
func (c *piClient) call(cmd map[string]any, out any, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return errors.New("pi 进程已退出")
	}
	c.seq++
	id := fmt.Sprintf("req-%d", c.seq)
	cmd["id"] = id
	ch := make(chan response, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	rec, err := json.Marshal(cmd)
	if err != nil {
		c.forget(id)
		return err
	}
	rec = append(rec, '\n')
	c.mu.Lock()
	_, err = c.in.Write(rec)
	c.mu.Unlock()
	if err != nil {
		c.forget(id)
		return fmt.Errorf("写入 pi 失败：%w", err)
	}

	select {
	case r, ok := <-ch:
		if !ok {
			return errors.New("pi 进程已退出")
		}
		if !r.Success {
			if r.Error == "" {
				r.Error = "未知错误"
			}
			return errors.New(r.Error)
		}
		if out != nil && len(r.Data) > 0 {
			if err := json.Unmarshal(r.Data, out); err != nil {
				return err
			}
		}
		return nil
	case <-time.After(timeout):
		c.forget(id)
		return fmt.Errorf("pi 在 %s 内没有响应 %v", timeout, cmd["type"])
	}
}

func (c *piClient) forget(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// write sends a record that expects no response.
func (c *piClient) write(rec map[string]any) error {
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errors.New("pi 进程已退出")
	}
	_, err = c.in.Write(append(data, '\n'))
	return err
}

// uiResponse answers an extension dialog.
func (c *piClient) uiResponse(id string, value map[string]any) {
	rec := map[string]any{"type": "extension_ui_response", "id": id}
	for k, v := range value {
		rec[k] = v
	}
	_ = c.write(rec)
}

// stop closes stdin, gives pi time to settle, then kills it.
func (c *piClient) stop() {
	c.mu.Lock()
	closed := c.closed
	c.closed = true
	_ = c.in.Close()
	c.mu.Unlock()
	if closed || c.cmd == nil || c.cmd.Process == nil {
		return
	}
	done := make(chan struct{})
	go func() {
		_ = c.cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		killTree(c.cmd)
		// Wait for the process to be gone, so its files are free again.
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
}

// pid is the process id, 0 before it starts.
func (c *piClient) pid() int {
	if c == nil || c.cmd == nil || c.cmd.Process == nil {
		return 0
	}
	return c.cmd.Process.Pid
}

// isClosed reports a process that ended or was asked to stop.
func (c *piClient) isClosed() bool {
	if c == nil {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// stderrText is the newest stderr, one line.
func (c *piClient) stderrText() string {
	if c == nil || c.stderr == nil {
		return ""
	}
	return viewkit.FirstLine(c.stderr.String(), 160)
}

// lastStderr is what pi logged, for an error message.
func (c *piClient) lastStderr() string {
	return strings.TrimSpace(c.stderr.String())
}

// ringBuffer keeps the last limit bytes written to it, safe for concurrent
// writers and readers.
type ringBuffer struct {
	mu    sync.Mutex
	buf   []byte
	limit int
}

func (r *ringBuffer) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, p...)
	if len(r.buf) > r.limit {
		r.buf = r.buf[len(r.buf)-r.limit:]
	}
	return len(p), nil
}

func (r *ringBuffer) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.buf)
}

// The app's live pi processes, so quitting can stop them all.
var (
	trackMu sync.Mutex
	tracked = map[*piClient]struct{}{}
)

func track(c *piClient) {
	trackMu.Lock()
	tracked[c] = struct{}{}
	trackMu.Unlock()
}

func untrack(c *piClient) {
	trackMu.Lock()
	delete(tracked, c)
	trackMu.Unlock()
}

// closeAllPi stops every child, letting pi shut down its session first.
// The app's callbacks are detached first: the window is gone by the time a
// child exits, and posting to it would be a mistake.
func closeAllPi() {
	trackMu.Lock()
	all := make([]*piClient, 0, len(tracked))
	for c := range tracked {
		all = append(all, c)
	}
	tracked = map[*piClient]struct{}{}
	trackMu.Unlock()
	for _, c := range all {
		c.detach()
		c.stop()
	}
}

// detach drops the app's callbacks, for a child being stopped at exit.
func (c *piClient) detach() { c.hooks.Store(hooks{}) }

// setHooks binds the app's callbacks: at launch, or when a prewarmed
// process is handed to the session that adopts it.
func (c *piClient) setHooks(h hooks) { c.hooks.Store(h) }

// callbacks are the app's hooks, nil once detached.
func (c *piClient) callbacks() hooks {
	if h, ok := c.hooks.Load().(hooks); ok {
		return h
	}
	return hooks{}
}

// hooks are the app's callbacks for one child's records.
type hooks struct {
	onEvent func(piEvent)
	onUI    func(uiRequest)
	onExit  func(error)
}
