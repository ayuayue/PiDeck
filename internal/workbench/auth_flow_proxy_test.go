//go:build !js && !android && !ios

package workbench

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestAuthBridgeUsesAgentProxyAndSelectedDirectory(t *testing.T) {
	pi, dir := authBridgeFixture(t)
	sdk, err := findPiSDKEntry(pi)
	if err != nil {
		t.Fatal(err)
	}
	// SDK import resets the dispatcher; the host must install the proxy afterward.
	source := "globalThis.fixtureProxyInstalled = false;\n" + strings.Replace(authSDKFixture,
		"    return new ModelRuntime(options);",
		`    if (!globalThis.fixtureProxyInstalled || process.env.HTTPS_PROXY !== 'http://127.0.0.1:9876' || process.env.NO_PROXY !== 'localhost,example.test') throw new Error('proxy configuration was not forwarded');
    if (options.authPath !== `+strconv.Quote(filepath.Join(dir, "auth.json"))+` || process.env.PI_CODING_AGENT_DIR !== `+strconv.Quote(dir)+`) throw new Error('wrong authentication directory');
    return new ModelRuntime(options);`, 1)
	if err := os.WriteFile(sdk, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	undici := filepath.Join(filepath.Dir(filepath.Dir(sdk)), "node_modules", "undici")
	if err := os.MkdirAll(undici, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"package.json": `{"main":"index.cjs"}`,
		"index.cjs": `exports.EnvHttpProxyAgent = class {};
exports.setGlobalDispatcher = () => {};
exports.install = () => { globalThis.fixtureProxyInstalled = true; };`,
	} {
		if err := os.WriteFile(filepath.Join(undici, name), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	agentProxy.set("http://127.0.0.1:9876", "localhost,example.test")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = runPiAuthFlow(ctx, pi, dir, authFlowCommand{Cmd: "login", ProviderID: "error", Type: "oauth"}, nil, func(authFlowMessage) {})
	if err == nil || err.Error() != "fixture login failed" {
		t.Fatalf("proxy/directory checks did not reach the provider: %v", err)
	}
}
