//go:build !js && !android && !ios

package workbench

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"github.com/nsgo-dev/nsgo/core"
	"go.yaml.in/yaml/v3"
)

type wechatConnection struct {
	Version                             int
	Base, Token, Owner, Session, Cursor string
	Seen                                []string
}
type wechatReply struct{ session, to, token string }
type wechatHost struct {
	lifetime                           context.Context
	runContext                         context.Context
	ready, linked, needCode            *core.Signal[bool]
	status, verify                     *core.Signal[string]
	qr                                 *core.Signal[[]byte]
	connection                         wechatConnection
	loginCancel, runCancel             context.CancelFunc
	loginSeq, runSeq, saveSeq, written uint64
	codes                              chan string
	writeMu                            sync.Mutex
	pending                            *wechatReply
}

var wechatWrites sync.WaitGroup

func readWechat(file string) wechatConnection {
	f, err := os.Open(file)
	if err != nil {
		return wechatConnection{Version: 1}
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, (64<<10)+1))
	if err != nil || len(raw) > 64<<10 {
		return wechatConnection{Version: 1}
	}
	var c wechatConnection
	if yaml.Unmarshal(raw, &c) != nil || c.Version != 1 || len(c.Token) > 8192 || len(c.Cursor) > 32<<10 {
		return wechatConnection{Version: 1}
	}
	if base, err := trustedWechatBase(c.Base); err != nil {
		return wechatConnection{Version: 1}
	} else {
		c.Base = base
	}
	if len(c.Seen) > 256 {
		c.Seen = c.Seen[len(c.Seen)-256:]
	}
	return c
}

func (a *app) initWechat() {
	h := &wechatHost{lifetime: a.cx.Context(), ready: core.NewSignal(a.cx, false), linked: core.NewSignal(a.cx, false), needCode: core.NewSignal(a.cx, false), status: core.NewSignal(a.cx, ""), verify: core.NewSignal(a.cx, ""), qr: core.NewSignalFunc(a.cx, []byte(nil), nil)}
	a.wechat = h
	a.cx.Cleanup(func() {
		if h.loginCancel != nil {
			h.loginCancel()
		}
		if h.runCancel != nil {
			h.runCancel()
		}
	})
	a.on(eventTurnDone, a.onWechatTurn)
	file := filepath.Join(a.st.dir, "wechat", "connection.yaml")
	go func() {
		c := readWechat(file)
		a.cx.Post(func() {
			h.connection = c
			h.linked.Set(c.Token != "")
			h.ready.Set(true)
			if a.cfg.WeChatEnabled {
				a.startWechat()
			}
		})
	}()
}

func (a *app) saveWechat() {
	h := a.wechat
	c := h.connection
	c.Seen = slices.Clone(c.Seen)
	h.saveSeq++
	seq := h.saveSeq
	file := filepath.Join(a.st.dir, "wechat", "connection.yaml")
	wechatWrites.Add(1)
	go func() {
		defer wechatWrites.Done()
		h.writeMu.Lock()
		defer h.writeMu.Unlock()
		if seq <= h.written {
			return
		}
		raw, err := yaml.Marshal(c)
		if err == nil {
			err = os.MkdirAll(filepath.Dir(file), 0o700)
		}
		if err == nil {
			err = writeFileAtomic(file, raw, 0o600)
		}
		if err == nil {
			h.written = seq
		} else {
			a.cx.Post(func() { h.status.Set(err.Error()) })
		}
	}()
}
