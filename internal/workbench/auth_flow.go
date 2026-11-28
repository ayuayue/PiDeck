//go:build !js && !android && !ios

package workbench

// The SDK owns OAuth, callback servers and token persistence. This bridge only
// transports its prompts/events; no provider's authentication is reimplemented.

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
)

//go:embed auth_host.mjs
var piAuthHostScript string

type authPromptOption struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}
type authPrompt struct {
	Kind        string             `json:"kind"`
	Message     string             `json:"message"`
	Placeholder string             `json:"placeholder"`
	Options     []authPromptOption `json:"options"`
}
type authFlowEvent struct {
	Type                 string `json:"type"`
	Message              string `json:"message"`
	URL                  string `json:"url"`
	Instructions         string `json:"instructions"`
	UserCode             string `json:"userCode"`
	VerificationURI      string `json:"verificationUri"`
	OpenBrowserOnConfirm *bool  `json:"openBrowserOnConfirm"`
	Links                []struct {
		URL   string `json:"url"`
		Label string `json:"label"`
	} `json:"links"`
}
type authFlowMessage struct {
	Type      string        `json:"type"`
	ID        string        `json:"id"`
	Event     authFlowEvent `json:"event"`
	Prompt    *authPrompt   `json:"prompt"`
	OK        bool          `json:"ok"`
	Cancelled bool          `json:"cancelled"`
	Message   string        `json:"message"`
	Error     *struct {
		Message string `json:"message"`
	} `json:"error"`
}
type authFlowCommand struct {
	Cmd        string `json:"cmd"`
	ProviderID string `json:"providerId,omitempty"`
	Type       string `json:"type,omitempty"`
	ID         string `json:"id,omitempty"`
	Value      string `json:"value"`
}
type authFlowView struct {
	Open       bool
	Phase      string // running, succeeded, failed
	Provider   string
	APIKey     bool
	NoBrowser  bool
	Message    string
	URL        string
	Code       string
	OpenFailed bool
	PromptID   string
	Prompt     *authPrompt
	Events     []authFlowEvent
}
type authUIState struct {
	Busy        *core.Signal[bool]
	Error       *core.Signal[string]
	ShowKey     *core.Signal[bool]
	Mode        *core.Signal[string]
	Flow        *core.Signal[authFlowView]
	Answer      *core.Signal[string]
	Lifetime    context.Context
	KeyEditing  string
	LoadSeq     int
	Generation  int
	MethodsPath string
	Cancel      context.CancelFunc
	Answers     chan authFlowCommand
	Opened      map[string]bool
}

func newAuthUIState(cx *core.Scope) *authUIState {
	s := &authUIState{
		Lifetime: cx.Context(),
		Busy:     core.NewSignal(cx, false), Error: core.NewSignal(cx, ""), ShowKey: core.NewSignal(cx, false),
		Mode: core.NewSignal(cx, "api_key"),
		Flow: core.NewSignalFunc(cx, authFlowView{}, nil), Answer: core.NewSignal(cx, ""),
	}
	cx.Cleanup(func() {
		if s.Cancel != nil {
			s.Cancel()
		}
	})
	return s
}

func findPiSDKEntry(piPath string) (string, error) {
	module, err := findPiAIProvidersModule(piPath)
	if err != nil {
		return "", err
	}
	for dir, depth := filepath.Dir(module), 0; depth < 10 && dir != filepath.Dir(dir); dir, depth = filepath.Dir(dir), depth+1 {
		for _, candidate := range []string{
			filepath.Join(dir, "dist", "index.js"),
			filepath.Join(dir, "@earendil-works", "pi-coding-agent", "dist", "index.js"),
		} {
			root := filepath.Dir(filepath.Dir(candidate))
			var pkg struct {
				Name string `json:"name"`
			}
			raw, readErr := os.ReadFile(filepath.Join(root, "package.json"))
			if readErr != nil || json.Unmarshal(raw, &pkg) != nil || pkg.Name != "@earendil-works/pi-coding-agent" {
				continue
			}
			if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
				return candidate, nil
			}
		}
	}
	return "", errors.New(apptext.T("找不到 Pi 的认证 SDK，请检查 Pi 安装后重试。"))
}

// piAuthEnvironment binds all auth commands to the same directory as the UI.
// Appending overrides preserves the existing Agent-proxy inheritance policy.
func piAuthEnvironment(base []string, dir string) []string {
	env := append(append([]string(nil), base...), agentProxy.env()...)
	return append(env, "PI_CODING_AGENT_DIR="+dir)
}

func runPiAuthFlow(ctx context.Context, piPath, configDir string, initial authFlowCommand, answers <-chan authFlowCommand, notify func(authFlowMessage)) error {
	sdk, err := findPiSDKEntry(piPath)
	if err != nil {
		return err
	}
	runner, err := piRegistryRunner()
	if err != nil {
		return err
	}
	parent := ctx
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	cmd := exec.CommandContext(ctx, runner, "--input-type=module", "-e", piAuthHostScript, sdk, configDir)
	cmd.Dir = loginDir()
	cmd.Env = piAuthEnvironment(os.Environ(), configDir)
	hideWindow(cmd)
	input, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return err
	}
	// Let the SDK close its callback server and settle pending writes before exit.
	// A broken helper is still terminated within a bounded grace period.
	var inputMu sync.Mutex
	encoder := json.NewEncoder(input)
	send := func(command authFlowCommand) error {
		inputMu.Lock()
		defer inputMu.Unlock()
		return encoder.Encode(command)
	}
	cmd.Cancel = func() error { return send(authFlowCommand{Cmd: "cancel"}) }
	cmd.WaitDelay = 2 * time.Second
	// Do not expose stderr: providers may include authorization data in it.
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		input.Close()
		return err
	}
	defer input.Close()
	writeErr := make(chan error, 1)
	go func() {
		if e := send(initial); e != nil {
			writeErr <- e
			cancel()
			return
		}
		for {
			select {
			case <-ctx.Done():
				return
			case answer, ok := <-answers:
				if !ok {
					return
				}
				if e := send(answer); e != nil {
					writeErr <- e
					cancel()
					return
				}
			}
		}
	}()
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 4096), 64<<10)
	var terminal *authFlowMessage
	var protocolErr error
	for scanner.Scan() {
		var message authFlowMessage
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			protocolErr = errors.New(apptext.T("Pi 认证助手返回了无效数据，请重试。"))
			break
		}
		switch message.Type {
		case "ready", "event", "prompt", "prompt-cancelled":
			notify(message)
		case "result", "fatal":
			terminal = &message
		default:
			protocolErr = errors.New(apptext.T("Pi 认证助手返回了无效数据，请重试。"))
		}
		if terminal != nil || protocolErr != nil {
			break
		}
	}
	scanErr := scanner.Err()
	if terminal == nil {
		cancel()
	}
	waitErr := cmd.Wait()
	if terminal != nil {
		if terminal.Type == "result" && terminal.OK {
			return nil
		}
		if terminal.Cancelled {
			return context.Canceled
		}
		if terminal.Error != nil && terminal.Error.Message != "" {
			return errors.New(terminal.Error.Message)
		}
		if terminal.Message != "" {
			return errors.New(terminal.Message)
		}
	}
	if parent.Err() != nil {
		return parent.Err()
	}
	if protocolErr != nil {
		return protocolErr
	}
	if scanErr != nil {
		return errors.New(apptext.T("Pi 认证数据超出限制或连接中断，请重试。"))
	}
	select {
	case e := <-writeErr:
		return e
	default:
	}
	if waitErr != nil {
		return errors.New(apptext.T("Pi 认证助手意外退出，请检查 Pi 安装和代理后重试。"))
	}
	return errors.New(apptext.T("Pi 认证没有返回结果，请重试。"))
}

func safeAuthURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return ""
	}
	return u.String()
}
