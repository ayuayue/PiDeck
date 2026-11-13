package main

// MCP servers, through pi's own CLI: pi mcp list/add/remove. The app only
// runs the commands and shows their answer; pi owns mcp.json and the
// connections.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// mcpServer is one server as pi mcp list reports it.
type mcpServer struct {
	Name      string   `json:"name"`
	Scope     string   `json:"scope"`
	Source    string   `json:"source"`
	Enabled   bool     `json:"enabled"`
	Exposure  string   `json:"exposure"`
	Transport string   `json:"transport"`
	State     string   `json:"state"`
	Tools     []string `json:"tools"`
	Error     string   `json:"error"`
}

// parseMCPServers reads pi mcp list --json's output.
func parseMCPServers(raw []byte) ([]mcpServer, error) {
	var parsed struct {
		Servers []mcpServer `json:"servers"`
	}
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, errors.New("pi 返回的不是 MCP 列表")
	}
	return parsed.Servers, nil
}

// mcpCommand builds one pi mcp call.
func mcpCommand(piPath string, args ...string) *exec.Cmd {
	if isBatch(piPath) {
		return batchCommand(piPath, args)
	}
	return exec.Command(piPath, args...)
}

// readMCPServers asks pi for its servers, in dir when one is given.
func readMCPServers(piPath, dir string) ([]mcpServer, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if isBatch(piPath) {
		cmd = batchCommand(piPath, []string{"mcp", "list", "--json"})
	} else {
		cmd = exec.CommandContext(ctx, piPath, "mcp", "list", "--json")
	}
	cmd.Dir = dir
	hideWindow(cmd)
	out, err := cmd.Output()
	if len(out) == 0 {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("pi 没有返回 MCP 列表")
	}
	// pi exits 1 when a server fails but still prints the list.
	servers, parseErr := parseMCPServers(out)
	if parseErr != nil {
		if err != nil {
			return nil, fmt.Errorf("%v：%s", err, firstLine(string(out), 200))
		}
		return nil, parseErr
	}
	return servers, nil
}

// mcpAddArgs builds pi mcp add's arguments.
func mcpAddArgs(name, command, rawURL, description string, local bool) ([]string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("名字不能为空")
	}
	args := []string{"mcp", "add", name}
	if local {
		args = append(args, "-l")
	}
	if d := strings.TrimSpace(description); d != "" {
		args = append(args, "--description", d)
	}
	if u := strings.TrimSpace(rawURL); u != "" {
		if !isHTTPURL(u) {
			return nil, errors.New("URL 只支持 http(s)")
		}
		return append(args, "--url", u), nil
	}
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return nil, errors.New("填 URL 或命令")
	}
	return append(append(args, "--"), fields...), nil
}

// mcpRemoveArgs builds pi mcp remove's arguments.
func mcpRemoveArgs(name string, local bool) []string {
	args := []string{"mcp", "remove", strings.TrimSpace(name)}
	if local {
		args = append(args, "-l")
	}
	return args
}

// runMCP runs one pi mcp command and reports its answer on failure.
func runMCP(piPath, dir string, args ...string) error {
	cmd := mcpCommand(piPath, args...)
	cmd.Dir = dir
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(out))
		if text != "" {
			return errors.New(firstLine(text, 240))
		}
		return err
	}
	return nil
}
