//go:build !js && !android && !ios

package workbench

import (
	"crypto/ed25519"
	"crypto/rand"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/tsx"
	"github.com/nsgo-dev/nsgo/tsx/bundler"
	"github.com/nsgo-dev/nsgo/tsx/pkg"
	yaml "go.yaml.in/yaml/v3"
)

// Source and signing tools belong to tests, not the shipped Lite runtime.
// The keys below are generated in memory per test and never saved.
//
//go:embed plugin_examples/nsgo-ui/* plugin_examples/nsgo-functions/*
var nsgoPluginExampleSources embed.FS

func verifiedNSGoExample(t *testing.T, dir, entry string) *pkg.Package {
	t.Helper()
	src, err := fs.Sub(nsgoPluginExampleSources, "plugin_examples/"+dir)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := fs.ReadFile(src, "nsgo.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		ID, Name, Version string
		Build             uint64 `yaml:"build_number"`
		Capabilities      pkg.Capabilities
	}
	if err := yaml.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	code, err := bundler.Compile(src, entry)
	if err != nil {
		t.Fatal(err)
	}
	rootPublic, root, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public, release, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := pkg.Certify(root, public, []string{"dev.pideck.lite.examples.*"}, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	data, err := pkg.Build(pkg.Contents{App: pkg.App{ID: manifest.ID, Name: manifest.Name, Version: manifest.Version, Build: manifest.Build},
		Source: code, Capabilities: manifest.Capabilities}, release, cert)
	if err != nil {
		t.Fatal(err)
	}
	trust := pkg.NewTrust()
	trust.AddRoot(rootPublic)
	p, err := trust.Verify(data)
	if err != nil {
		t.Fatal(err)
	}
	tampered := append([]byte(nil), data...)
	tampered[len(tampered)-1] ^= 1
	if _, err := trust.Verify(tampered); err == nil {
		t.Fatal("accepted a tampered example package")
	}
	return p
}

func TestNSGoPluginUIExampleUsesGrantedHostAndPartitionedStorage(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless integration example")
	}
	p := verifiedNSGoExample(t, "nsgo-ui", "App.tsx")
	host := core.NewHost()
	host.Handle("context.read", func(call *core.HostCall) {
		call.Resolve(map[string]string{"projectName": "示例项目"})
	})
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		return tsx.View{Package: p, Sandbox: tsx.Sandbox{Host: host}}
	})
	app.WaitFor("text:示例项目", 5*time.Second)
	app.WaitFor("text:准备完成", 5*time.Second)
	app.Press("id:example-mark")
	app.Press("id:example-mark")
	app.WaitFor("text:标记次数：2", 5*time.Second)
	app.WaitFor("text:已保存", 5*time.Second)
	if keys := app.Storage().Keys(); len(keys) != 0 {
		t.Fatalf("plugin storage leaked into host storage: %v", keys)
	}
}

func TestNSGoPluginFunctionExampleValidatesJSONInput(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless integration example")
	}
	p := verifiedNSGoExample(t, "nsgo-functions", "App.ts")
	var result any
	var callErr, refused, missing error
	nsgotest.Start(t, func(cx *core.Scope) core.Node {
		plugin, err := tsx.Load(cx, p, tsx.Sandbox{})
		if err != nil {
			callErr = err
			return nil
		}
		plugin.Call("summarizeSessions", []any{[]map[string]any{
			{"backend": "pi", "messages": 3}, {"backend": "acp", "messages": 2}, {"backend": "pi", "messages": 1},
		}}, func(value any, err error) { result, callErr = value, err })
		plugin.Call("summarizeSessions", []any{[]map[string]any{{"backend": "pi", "messages": -1}}},
			func(_ any, err error) { refused = err })
		plugin.Call("missing", nil, func(_ any, err error) { missing = err })
		return core.Text{Content: "Function example"}
	})
	var summary struct {
		Total, Messages int
		Backends        map[string]int
	}
	raw, encodeErr := json.Marshal(result)
	decodeErr := json.Unmarshal(raw, &summary)
	if callErr != nil || encodeErr != nil || decodeErr != nil || summary.Total != 3 || summary.Messages != 6 ||
		summary.Backends["pi"] != 2 || summary.Backends["acp"] != 1 {
		t.Fatalf("result=%#v, err=%v", result, callErr)
	}
	if refused == nil || !strings.Contains(refused.Error(), "消息数量无效") || !errors.Is(missing, tsx.ErrNoExport) {
		t.Fatalf("invalid input err=%v; missing export err=%v", refused, missing)
	}
}

func TestNSGoPluginUIExampleRefusesUngrantedHostCall(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless integration example")
	}
	p := verifiedNSGoExample(t, "nsgo-ui", "App.tsx")
	called := false
	host := core.NewHost()
	host.Handle("context.read", func(call *core.HostCall) {
		called = true
		call.Resolve(map[string]string{"projectName": "private"})
	})
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		return tsx.View{Package: p, Sandbox: tsx.Sandbox{Host: host, Grant: &pkg.Capabilities{}}}
	})
	app.WaitFor("text:宿主未授予项目信息权限", 5*time.Second)
	if called {
		t.Fatal("delivered a declared host call that the host did not grant")
	}
}
