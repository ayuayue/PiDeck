//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func authRegistryFixture(t *testing.T) (string, string) {
	t.Helper()
	pkg := filepath.Join(t.TempDir(), "node_modules", "@earendil-works", "pi-coding-agent")
	module := filepath.Join(pkg, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js")
	for path, body := range map[string]string{
		filepath.Join(pkg, "package.json"):                                             `{"name":"@earendil-works/pi-coding-agent","type":"module"}`,
		filepath.Join(pkg, "dist", "index.js"):                                         `export {};`,
		filepath.Join(pkg, "node_modules", "@earendil-works", "pi-ai", "package.json"): `{"type":"module"}`,
		module: `export function builtinProviders() { return [{id:"fixture",name:"Fixture",auth:{apiKey:{name:"API key",login(){}}}}]; }`,
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return pkg, module
}

func TestPiAuthRegistryPackageDir(t *testing.T) {
	pkg, want := authRegistryFixture(t)
	t.Setenv("PI_PACKAGE_DIR", pkg)
	got, err := findPiAIProvidersModule(filepath.Join(t.TempDir(), "pi"))
	if err != nil || got != want {
		t.Fatalf("registry = %q, %v; want %q", got, err, want)
	}
	sdk, err := findPiSDKEntry(filepath.Join(t.TempDir(), "pi"))
	if wantSDK := filepath.Join(pkg, "dist", "index.js"); err != nil || sdk != wantSDK {
		t.Fatalf("login SDK = %q, %v; want %q", sdk, err, wantSDK)
	}
}

func TestPiAuthRegistryGlobalRoot(t *testing.T) {
	pkg, want := authRegistryFixture(t)
	bin, home := t.TempDir(), t.TempDir()
	t.Setenv("PI_PACKAGE_DIR", "")
	t.Setenv("PI_CODING_AGENT_DIR", "")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("APPDATA", home)
	t.Setenv("PIDECK_TEST_NPM_ROOT", filepath.Dir(filepath.Dir(pkg)))
	name, script := "npm", "#!/bin/sh\n[ \"$1\" = root ] && [ \"$2\" = -g ] || exit 1\nprintf '%s\\n' \"$PIDECK_TEST_NPM_ROOT\"\n"
	path := bin
	if runtime.GOOS == "windows" {
		name, script = "npm.cmd", "@echo off\r\nif not \"%~1\"==\"root\" exit /b 1\r\nif not \"%~2\"==\"-g\" exit /b 1\r\necho %PIDECK_TEST_NPM_ROOT%\r\n"
		path += string(os.PathListSeparator) + filepath.Join(os.Getenv("SystemRoot"), "System32")
	}
	t.Setenv("PATH", path)
	if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	got, err := findPiAIProvidersModule(filepath.Join(bin, "pi"))
	if err != nil || got != want {
		t.Fatalf("registry behind executable shim = %q, %v; want %q", got, err, want)
	}
	if sdk, err := findPiSDKEntry(filepath.Join(bin, "pi")); err != nil || sdk != filepath.Join(pkg, "dist", "index.js") {
		t.Fatalf("login SDK behind executable shim = %q, %v", sdk, err)
	}
	t.Setenv("PIDECK_TEST_NPM_ROOT", t.TempDir())
	if got, err := findPiAIProvidersModule(filepath.Join(bin, "pi")); err == nil || got != "" {
		t.Fatalf("missing global registry = %q, %v; want an error", got, err)
	}
}

func TestLoadPiAuthProvidersPackageDir(t *testing.T) {
	if _, err := piRegistryRunner(); err != nil {
		t.Skip(err)
	}
	pkg, _ := authRegistryFixture(t)
	t.Setenv("PI_PACKAGE_DIR", pkg)
	got, err := loadPiAuthProviders(filepath.Join(t.TempDir(), "pi"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "fixture" || got[0].APIKey == nil || !got[0].APIKey.Login {
		t.Fatalf("loaded providers = %+v; want fixture's API key login", got)
	}
}
