package main

// Providers and their credentials, for the settings page: which providers
// pi knows, how many models each offers, and whether pi can authenticate
// with them right now.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// providerInfo is one provider pi can talk to.
type providerInfo struct {
	ID      string
	API     string
	BaseURL string
	Models  int
	// Auth is "ready", "not_ready", "invalid", or "" while unknown.
	Auth     string
	AuthType string
	Reason   string
}

// modelsFile is pi's own model configuration: providers with their models.
type modelsFile struct {
	Providers map[string]struct {
		API     string `json:"api"`
		BaseURL string `json:"baseUrl"`
		Models  []struct {
			ID string `json:"id"`
		} `json:"models"`
	} `json:"providers"`
}

// piConfigDir is pi's own configuration folder.
func piConfigDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".pi", "agent")
}

// readProviders lists the providers in pi's models.json.
func readProviders() []providerInfo {
	dir := piConfigDir()
	if dir == "" {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(dir, "models.json"))
	if err != nil {
		return nil
	}
	var f modelsFile
	if json.Unmarshal(raw, &f) != nil {
		return nil
	}
	out := make([]providerInfo, 0, len(f.Providers))
	for id, p := range f.Providers {
		out = append(out, providerInfo{ID: id, API: p.API, BaseURL: p.BaseURL, Models: len(p.Models)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// probeProviderAuth asks pi whether a provider's credentials resolve.
func probeProviderAuth(piPath, provider string) (status, authType, reason string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	args := []string{"auth", "check", "--provider", provider, "--json"}
	var cmd *exec.Cmd
	if isBatch(piPath) {
		cmd = exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", batchLine(piPath, args))
	} else {
		cmd = exec.CommandContext(ctx, piPath, args...)
	}
	hideWindow(cmd)
	out, _ := cmd.Output()
	var res struct {
		Status   string `json:"status"`
		AuthType string `json:"authType"`
		Reason   string `json:"reason"`
	}
	if json.Unmarshal(out, &res) == nil && res.Status != "" {
		return res.Status, res.AuthType, res.Reason
	}
	return "", "", firstLine(strings.TrimSpace(string(out)), 120)
}

// probeProviders fills in the auth state of each provider, one at a time.
func probeProviders(piPath string, list []providerInfo) []providerInfo {
	out := make([]providerInfo, len(list))
	copy(out, list)
	for i := range out {
		status, kind, reason := probeProviderAuth(piPath, out[i].ID)
		out[i].Auth, out[i].AuthType, out[i].Reason = status, kind, reason
	}
	return out
}

// authLabel names an auth state for the UI.
func authLabel(p providerInfo) string {
	switch p.Auth {
	case "ready":
		return "已就绪"
	case "not_ready":
		return "未配置"
	case "invalid":
		return "已失效"
	}
	return "未知"
}

// loginCommand is what the user runs in a terminal to sign in.
func loginCommand(p providerInfo) string {
	return fmt.Sprintf("pi auth login %s", p.ID)
}
