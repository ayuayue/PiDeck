//go:build !js && !android && !ios

package workbench

// The preview only runs the example shipped in this binary. Its embedded
// root is not an external publisher trust store or an installation API.

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/tsx"
	"github.com/nsgo-dev/nsgo/tsx/pkg"
	_ "github.com/nsgo-dev/nsgo/tsx/ui"
)

const pluginPreviewID = "dev.pideck.lite.examples.session-tools"

// Compiled and signed by TestPluginPreviewBundleCurrent's explicit update
// command. Compilers and private keys never enter the desktop binary.
//
//go:embed plugin_examples/nsgo-session-tools/preview.bundle.json
var pluginPreviewBundleJSON []byte

type pluginPreviewBundle struct {
	Root    string `json:"root"`
	Package []byte `json:"package"`
}

type pluginPreviewLoad struct {
	pkg *pkg.Package
	err error
}

type pluginPreviewState struct {
	grant *core.Signal[bool]
	ready *core.Signal[pluginPreviewLoad]
}

func newPluginPreview(cx *core.Scope) *pluginPreviewState {
	s := &pluginPreviewState{grant: core.NewSignal(cx, false), ready: core.NewSignal(cx, pluginPreviewLoad{})}
	// Verification is CPU work, never part of rendering. Scope.Post drops
	// publication when this preview was closed, reopened or navigated away.
	go func() {
		p, err := verifyPluginPreview(pluginPreviewBundleJSON)
		cx.Post(func() { s.ready.Set(pluginPreviewLoad{p, err}) })
	}()
	return s
}

func verifyPluginPreview(raw []byte) (*pkg.Package, error) {
	var bundle pluginPreviewBundle
	if err := json.Unmarshal(raw, &bundle); err != nil {
		return nil, fmt.Errorf("preview bundle: %w", err)
	}
	root, err := pkg.DecodePublicKey(bundle.Root)
	if err != nil {
		return nil, err
	}
	trust := pkg.NewTrust()
	trust.AddRoot(root)
	p, err := trust.Verify(bundle.Package)
	if err != nil {
		return nil, err
	}
	if p.App.ID != pluginPreviewID {
		return nil, errors.New("unexpected preview package identity")
	}
	return p, nil
}

// A fresh channel belongs to exactly one VM. Even the fixed example handler
// checks its scope and current grant; a queued request cannot outlive either.
func pluginPreviewSandbox(cx *core.Scope, allowed func() bool) tsx.Sandbox {
	host := core.NewHost()
	host.Handle("sessions.list", func(call *core.HostCall) {
		if cx.Disposed() || !allowed() {
			call.Reject(core.AccessDenied("host", "sessions.list"))
			return
		}
		rows, err := pluginPreviewSessions(call.Data)
		if err != nil {
			call.Reject(err)
			return
		}
		call.Resolve(rows)
	})
	grant := &pkg.Capabilities{}
	if allowed() {
		grant.Host = []string{"sessions.list"}
	}
	limits := tsx.DefaultLimits
	limits.Load, limits.Call, limits.CallTotal = time.Second, 500*time.Millisecond, 5*time.Second
	limits.Nodes, limits.Timers, limits.Requests = 500, 16, 1
	limits.Body, limits.Storage, limits.Memory = 64<<10, 4<<10, 8<<20
	return tsx.Sandbox{Host: host, Grant: grant, Limits: &limits}
}

type pluginPreviewSession struct {
	Backend  string `json:"backend"`
	Messages int    `json:"messages"`
}

// This handler projects no real sessions, names, paths or message bodies.
// Keep the same bounded request contract as the standalone example.
func pluginPreviewSessions(data any) ([]pluginPreviewSession, error) {
	args, ok := data.(map[string]any)
	limit, number := args["limit"].(float64)
	if !ok || len(args) != 1 || !number || math.IsNaN(limit) || math.IsInf(limit, 0) ||
		limit != math.Trunc(limit) || limit < 1 || limit > 200 {
		return nil, errors.New("sessions.list: limit must be an integer between 1 and 200")
	}
	rows := []pluginPreviewSession{{Backend: "pi", Messages: 3}, {Backend: "acp", Messages: 2}, {Backend: "pi", Messages: 1}}
	return rows[:min(int(limit), len(rows))], nil
}

type pluginPreviewFunctionState struct {
	cx       *core.Scope
	function *tsx.Plugin
	loadErr  error
	busy     *core.Signal[bool]
	status   *core.Signal[string]
}

func newPluginPreviewFunction(cx *core.Scope, p *pkg.Package, allowed func() bool) *pluginPreviewFunctionState {
	s := &pluginPreviewFunctionState{cx: cx, busy: core.NewSignal(cx, false), status: core.NewSignal(cx, "")}
	// Load does not mount UI. The scope owns cleanup of this runtime,
	// independently of the preview's panel and badge instances.
	s.function, s.loadErr = tsx.Load(cx, p, pluginPreviewSandbox(cx, allowed))
	if s.loadErr != nil {
		s.status.Set(apptext.T("示例函数调用失败：%s", s.loadErr.Error()))
	}
	return s
}

func (s *pluginPreviewFunctionState) disabled() bool { return s.busy.Get() || s.loadErr != nil }

func (s *pluginPreviewFunctionState) call() {
	if s.cx.Disposed() || s.busy.GetUntracked() || s.loadErr != nil {
		return
	}
	s.busy.Set(true)
	s.status.Set("")
	s.function.Call("readSessionTotals", nil, func(value any, err error) {
		if s.cx.Disposed() {
			return
		}
		s.busy.Set(false)
		if err != nil {
			if core.ErrorCode(err) == core.CodeAccessDenied {
				s.status.Set(apptext.T("宿主未授予会话摘要权限"))
			} else {
				s.status.Set(apptext.T("示例函数调用失败：%s", err.Error()))
			}
			return
		}
		var totals struct{ Sessions, Messages int }
		raw, encodeErr := json.Marshal(value)
		if encodeErr != nil {
			s.status.Set(apptext.T("示例函数调用失败：%s", encodeErr.Error()))
		} else if err := json.Unmarshal(raw, &totals); err != nil {
			s.status.Set(apptext.T("示例函数调用失败：%s", err.Error()))
		} else {
			s.status.Set(apptext.T("函数结果：%d 个会话 · %d 条消息", totals.Sessions, totals.Messages))
		}
	})
}
