//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
)

type piAuthProvider struct {
	ID     string       `json:"id"`
	Name   string       `json:"name"`
	APIKey *piAPIKey    `json:"apiKey,omitempty"`
	OAuth  *piOAuthAuth `json:"oauth,omitempty"`
}

type piAPIKey struct {
	Name  string `json:"name,omitempty"`
	Login bool   `json:"login"`
}

type piOAuthAuth struct {
	Name           string `json:"name,omitempty"`
	LoginLabel     string `json:"loginLabel,omitempty"`
	IsSubscription bool   `json:"isSubscription,omitempty"`
}

const piAuthProvidersScript = `import { pathToFileURL } from "node:url";
const { builtinProviders } = await import(pathToFileURL(process.argv[1]).href);
const providers = builtinProviders().map((provider) => {
  const auth = provider.auth ?? {};
  return {
    id: provider.id,
    name: provider.name,
    apiKey: auth.apiKey ? { name: auth.apiKey.name ?? "", login: typeof auth.apiKey.login === "function" } : null,
    oauth: auth.oauth ? { name: auth.oauth.name ?? "", loginLabel: auth.oauth.loginLabel ?? "", isSubscription: !!auth.oauth.isSubscription } : null,
  };
});
console.log(JSON.stringify(providers));`

func loadPiAuthProviders(piPath string) ([]piAuthProvider, error) {
	modulePath, err := findPiAIProvidersModule(piPath)
	if err != nil {
		return nil, err
	}
	runner, err := piRegistryRunner()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, runner, "--input-type=module", "-e", piAuthProvidersScript, modulePath)
	cmd.Dir = loginDir()
	cmd.Env = os.Environ()
	hideWindow(cmd)
	output, err := cmd.Output()
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New(apptext.T("读取 Pi 认证方式超时"))
		}
		return nil, errors.New(apptext.T("读取 Pi 内置认证方式失败"))
	}
	return parsePiAuthProviders(output)
}

func piRegistryRunner() (string, error) {
	if path, err := exec.LookPath("node"); err == nil {
		return path, nil
	}
	if path, err := exec.LookPath("bun"); err == nil {
		return path, nil
	}
	return "", errors.New(apptext.T("找不到 Node.js 或 Bun，无法读取 Pi 认证方式"))
}

func findPiAIProvidersModule(piPath string) (string, error) {
	findIn := func(root string) string {
		if root == "" {
			return ""
		}
		for _, candidate := range []string{
			filepath.Join(root, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js"),
			filepath.Join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js"),
			filepath.Join(root, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js"),
			filepath.Join(root, "@earendil-works", "pi-ai", "dist", "providers", "all.js"),
		} {
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate
			}
		}
		return ""
	}
	if module := findIn(os.Getenv("PI_PACKAGE_DIR")); module != "" {
		return module, nil
	}
	paths := make([]string, 0, 4)
	seenPaths := map[string]bool{}
	addPath := func(path string) {
		if path == "" || seenPaths[path] {
			return
		}
		seenPaths[path] = true
		paths = append(paths, path)
		if resolved, err := filepath.EvalSymlinks(path); err == nil && !seenPaths[resolved] {
			seenPaths[resolved] = true
			paths = append(paths, resolved)
		}
	}
	addPath(piPath)
	if path, err := exec.LookPath(piPath); err == nil {
		addPath(path)
	}
	if path, err := exec.LookPath("pi"); err == nil {
		addPath(path)
	}
	if path, err := exec.LookPath("node"); err == nil {
		addPath(path)
	}
	for _, executable := range paths {
		abs, err := filepath.Abs(executable)
		if err != nil {
			continue
		}
		for dir, depth := filepath.Dir(abs), 0; dir != filepath.Dir(dir) && depth < 12; dir, depth = filepath.Dir(dir), depth+1 {
			if module := findIn(dir); module != "" {
				return module, nil
			}
		}
	}
	home, _ := os.UserHomeDir()
	roots := []string{
		filepath.Join(home, ".pi", "agent", "npm", "node_modules"),
		filepath.Join(home, ".bun", "install", "global", "node_modules"),
		filepath.Join(os.Getenv("APPDATA"), "npm", "node_modules"),
		filepath.Join(os.Getenv("PI_CODING_AGENT_DIR"), "npm", "node_modules"),
	}
	for _, root := range roots {
		if module := findIn(root); module != "" {
			return module, nil
		}
	}
	// Version-manager shims need not point at their installation on disk.
	if npm, err := exec.LookPath("npm"); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := piCommand(ctx, npm, "root", "-g")
		cmd.Dir = loginDir()
		if output, err := cmd.Output(); err == nil {
			if module := findIn(strings.TrimSpace(string(output))); module != "" {
				return module, nil
			}
		}
	}
	return "", errors.New(apptext.T("找不到 Pi 的 provider 注册表"))
}

func parsePiAuthProviders(data []byte) ([]piAuthProvider, error) {
	var providers []piAuthProvider
	if err := json.Unmarshal(data, &providers); err != nil {
		return nil, errors.New(apptext.T("Pi 认证方式数据格式无效"))
	}
	filtered := providers[:0]
	for _, provider := range providers {
		provider.ID = strings.TrimSpace(provider.ID)
		provider.Name = strings.TrimSpace(provider.Name)
		if provider.ID == "" || (provider.APIKey == nil && provider.OAuth == nil) {
			continue
		}
		if provider.Name == "" {
			provider.Name = provider.ID
		}
		filtered = append(filtered, provider)
	}
	sort.Slice(filtered, func(i, j int) bool {
		if !strings.EqualFold(filtered[i].Name, filtered[j].Name) {
			return strings.ToLower(filtered[i].Name) < strings.ToLower(filtered[j].Name)
		}
		return filtered[i].ID < filtered[j].ID
	})
	return filtered, nil
}

func authProviderLabel(provider piAuthProvider) string {
	if provider.Name == provider.ID {
		return provider.Name
	}
	return provider.Name + " · " + provider.ID
}

func matchingAuthProvider(providers []piAuthProvider, id string) (piAuthProvider, bool) {
	for _, provider := range providers {
		if provider.ID == id {
			return provider, true
		}
	}
	return piAuthProvider{}, false
}
