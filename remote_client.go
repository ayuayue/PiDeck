package main

// The mobile build's HTTP client for a desktop PiDeck Lite server.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// errRemoteAuth says the token was refused, so the phone must reconnect.
var errRemoteAuth = errors.New("访问令牌无效或已过期")

type remoteClient struct {
	base  string
	token string
	http  *http.Client
}

// newRemoteClient normalizes an address and token. A pasted connection
// link's ?token= fills the token when the field is empty.
func newRemoteClient(raw, token string) (*remoteClient, string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, "", errors.New("请填写电脑的连接地址")
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil, "", errors.New("连接地址格式不对")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, "", errors.New("连接地址只支持 http 或 https")
	}
	if q := u.Query().Get("token"); q != "" {
		token = q
	}
	base := u.Scheme + "://" + u.Host
	return &remoteClient{base: base, token: token, http: &http.Client{Timeout: 12 * time.Second}}, token, nil
}

func (c *remoteClient) do(path string, out any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("连接失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return errRemoteAuth
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var problem struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &problem) == nil && problem.Error != "" {
			return errors.New(problem.Error)
		}
		return fmt.Errorf("电脑返回 %d", resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("电脑返回的数据不对：%w", err)
	}
	return nil
}

// remotePing is what /api/ping tells the phone.
type remotePing struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Host    string `json:"host"`
	OS      string `json:"os"`
}

func (c *remoteClient) ping() (remotePing, error) {
	var out remotePing
	err := c.do("/api/ping", &out)
	return out, err
}

func (c *remoteClient) state() (remoteWireSnapshot, error) {
	var out remoteWireSnapshot
	err := c.do("/api/state", &out)
	return out, err
}

func (c *remoteClient) transcript(id string) (remoteWireTranscript, error) {
	var out remoteWireTranscript
	err := c.do("/api/session/"+url.PathEscape(id), &out)
	return out, err
}

// remoteErrorText is a connection failure as one readable line.
func remoteErrorText(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, errRemoteAuth) {
		return "访问令牌无效，请在电脑端设置 → 远程里复制新的连接链接"
	}
	return firstLine(err.Error(), 200)
}
