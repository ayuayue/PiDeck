//go:build !js && !android && !ios

package main

// Network proxies. The app's own HTTP requests and the agent processes it
// starts have separate settings: a proxy that serves pi often does not
// serve the app's provider probe, and the other way round.

import (
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http/httpproxy"
)

// proxySettings is one side's proxy: its URL and no-proxy list, with the
// matching environment for a process.
type proxySettings struct {
	mu     sync.RWMutex
	config *httpproxy.Config
}

// set replaces the proxy; an empty URL means a direct connection.
func (p *proxySettings) set(proxy, bypass string) {
	proxy = strings.TrimSpace(proxy)
	var cfg *httpproxy.Config
	if proxy != "" {
		cfg = &httpproxy.Config{HTTPProxy: proxy, HTTPSProxy: proxy, NoProxy: strings.TrimSpace(bypass)}
	}
	p.mu.Lock()
	p.config = cfg
	p.mu.Unlock()
}

// proxyFunc is the transport's proxy for one request, or nil for direct.
func (p *proxySettings) proxyFunc(req *http.Request) (*url.URL, error) {
	p.mu.RLock()
	cfg := p.config
	p.mu.RUnlock()
	if cfg == nil {
		return nil, nil
	}
	return cfg.ProxyFunc()(req.URL)
}

// env is the environment that points a process at the proxy.
func (p *proxySettings) env() []string {
	p.mu.RLock()
	cfg := p.config
	p.mu.RUnlock()
	if cfg == nil {
		return nil
	}
	env := []string{
		"HTTP_PROXY=" + cfg.HTTPProxy, "HTTPS_PROXY=" + cfg.HTTPSProxy, "ALL_PROXY=" + cfg.HTTPProxy,
		"http_proxy=" + cfg.HTTPProxy, "https_proxy=" + cfg.HTTPSProxy, "all_proxy=" + cfg.HTTPProxy,
	}
	if cfg.NoProxy != "" {
		env = append(env, "NO_PROXY="+cfg.NoProxy, "no_proxy="+cfg.NoProxy)
	}
	return env
}

var (
	// appProxy routes the app's own HTTP calls: provider probes and
	// balance checks, webhooks, git's network commands.
	appProxy proxySettings
	// agentProxy points the pi and ACP processes at a proxy.
	agentProxy proxySettings
)

// appHTTPClient is the app's client for its own small HTTP calls, and
// appHTTPLongClient for the ones that legitimately take a while, such as
// an image generation.
var (
	appHTTPClient     = &http.Client{Timeout: 12 * time.Second, Transport: &http.Transport{Proxy: appProxy.proxyFunc}}
	appHTTPLongClient = &http.Client{Timeout: 180 * time.Second, Transport: &http.Transport{Proxy: appProxy.proxyFunc}}
)

// applyProxy pushes the config's proxy settings into effect.
func (a *app) applyProxy() {
	appProxy.set(a.cfg.ProxyApp, a.cfg.ProxyBypass)
	agentProxy.set(a.cfg.ProxyAgent, a.cfg.ProxyBypass)
}
