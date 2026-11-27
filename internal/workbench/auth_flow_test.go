//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A hermetic SDK exercises the real Node bridge without browser, accounts or network.
const authSDKFixture = `import { readFile, writeFile } from 'node:fs/promises';
export class SettingsManager {
  static create() { return { getOrCreateDeviceId() { return 'fixture-device'; } }; }
}
export class ModelRuntime {
  static async create(options) {
    if (options.allowModelNetwork !== false || options.refreshOnCreate !== false) throw new Error('network refresh enabled');
    return new ModelRuntime(options);
  }
  constructor(options) { this.options = options; }
  async settleCredentialWrites() { await writeFile(this.options.authPath + '.settled', 'settled'); }
  async login(provider, type, io, options) {
    io.notify({type:'progress',message:'fixture-ready'});
    if (provider === 'wait') return await new Promise((_, reject) => {
      io.signal.addEventListener('abort', () => reject(new DOMException('cancelled','AbortError')), {once:true});
    });
    if (provider === 'error') throw new Error('fixture login failed');
    if (options.getDeviceId() !== 'fixture-device') throw new Error('missing device ID');
    const choice = await io.prompt({type:'select',message:'Select fixture plan',options:[{id:'plan',label:'Fixture plan'}]});
    if (choice !== 'plan') throw new Error('wrong selection');
    const tenant = await io.prompt({type:'text',message:'Fixture tenant'});
    if (tenant !== 'tenant') throw new Error('wrong text');
    const optional = await io.prompt({type:'text',message:'Optional fixture value'});
    if (optional !== '') throw new Error('default was not accepted');
    io.notify({type:'auth_url',url:'https://example.test/authorize',instructions:'Fixture authorization'});
    io.notify({type:'device_code',verificationUri:'https://example.test/device',userCode:'DEMO-CODE',openBrowserOnConfirm:false});
    const controller = new AbortController();
    const manual = io.prompt({type:'manual_code',message:'Fixture callback fallback',signal:controller.signal});
    io.notify({type:'progress',message:'Callback arrived'});
    controller.abort();
    await manual.catch(error => { if (error.name !== 'AbortError') throw error; });
    const key = await io.prompt({type:'secret',message:'Fixture secret'});
    if (key !== 'fixture-key') throw new Error('wrong secret');
    const credential = type === 'oauth' ? {type,access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000} : {type,key};
    const previous = await readFile(this.options.authPath, "utf8").then(JSON.parse).catch(() => ({}));
    await writeFile(this.options.authPath, JSON.stringify({...previous,[provider]:credential}));
  }
}`

func authBridgeFixture(t *testing.T) (string, string) {
	t.Helper()
	if _, err := piRegistryRunner(); err != nil {
		t.Skip(err)
	}
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		t.Setenv(key, "")
	}
	agentProxy.mu.Lock()
	previous := agentProxy.config
	agentProxy.config = nil
	agentProxy.mu.Unlock()
	t.Cleanup(func() { agentProxy.mu.Lock(); agentProxy.config = previous; agentProxy.mu.Unlock() })
	root := t.TempDir()
	pkg := filepath.Join(root, "node_modules", "@earendil-works", "pi-coding-agent")
	files := map[string]string{
		"package.json":  `{"name":"@earendil-works/pi-coding-agent","type":"module"}`,
		"dist/index.js": authSDKFixture,
		"node_modules/@earendil-works/pi-ai/dist/providers/all.js": "export const builtinProviders = () => [];",
	}
	for name, body := range files {
		path := filepath.Join(pkg, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	config := t.TempDir()
	return filepath.Join(root, "pi"), config
}

func TestAuthBridgePromptsAndCallbackCancellation(t *testing.T) {
	pi, dir := authBridgeFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	answers := make(chan authFlowCommand, 8)
	seen, cancelled := map[string]bool{}, false
	err := runPiAuthFlow(ctx, pi, dir, authFlowCommand{Cmd: "login", ProviderID: "fixture", Type: "api_key"}, answers, func(message authFlowMessage) {
		if message.Type == "prompt-cancelled" {
			cancelled = true
			return
		}
		if message.Prompt == nil {
			return
		}
		seen[message.Prompt.Kind] = true
		value := map[string]string{"select": "plan", "text": "tenant", "secret": "fixture-key"}[message.Prompt.Kind]
		if message.Prompt.Message == "Optional fixture value" {
			value = ""
		}
		if value == "" && message.Prompt.Kind != "text" {
			return
		}
		answers <- authFlowCommand{Cmd: "answer", ID: "stale-prompt", Value: "ignored"}
		answers <- authFlowCommand{Cmd: "answer", ID: message.ID, Value: value}
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"select", "text", "secret", "manual_code"} {
		if !seen[kind] {
			t.Errorf("missing %s prompt", kind)
		}
	}
	if !cancelled {
		t.Error("callback did not cancel only its fallback prompt")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]map[string]string
	if json.Unmarshal(raw, &doc) != nil || doc["fixture"]["type"] != "api_key" {
		t.Fatal("bridge did not persist through SDK")
	}
}

func TestAuthBridgeCancellationAndFailure(t *testing.T) {
	for _, provider := range []string{"wait", "error"} {
		t.Run(provider, func(t *testing.T) {
			pi, dir := authBridgeFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err := runPiAuthFlow(ctx, pi, dir, authFlowCommand{Cmd: "login", ProviderID: provider, Type: "oauth"}, nil, func(message authFlowMessage) {
				if provider == "wait" && message.Event.Message == "fixture-ready" {
					cancel()
				}
			})
			if provider == "wait" && !errors.Is(err, context.Canceled) {
				t.Fatalf("cancel error = %v", err)
			}
			if provider == "error" && (err == nil || !strings.Contains(err.Error(), "fixture login failed")) {
				t.Fatalf("provider error = %v", err)
			}
			if _, err := os.Stat(filepath.Join(dir, "auth.json.settled")); err != nil {
				t.Fatal("authentication exited before SDK credential writes settled:", err)
			}
		})
	}
}

func TestAuthProxyValidation(t *testing.T) {
	for _, value := range []string{"", "http://127.0.0.1:7890", "https://proxy.example.test"} {
		if validateAuthProxy(value) != "" {
			t.Errorf("rejected valid proxy %q", value)
		}
	}
	for _, value := range []string{"127.0.0.1:7890", "file:///tmp/proxy", "http://"} {
		if validateAuthProxy(value) == "" {
			t.Errorf("accepted invalid proxy %q", value)
		}
	}
	for _, value := range []string{"file:///tmp/link", "javascript:alert(1)", "https://user:pass@example.test"} {
		if safeAuthURL(value) != "" {
			t.Error("accepted unsafe authorization URL")
		}
	}
}
