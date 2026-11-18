package client

// The mobile build's HTTP client for a desktop PiDeck Lite server.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
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

func (c *remoteClient) state() (remotewire.Snapshot, error) {
	var out remotewire.Snapshot
	err := c.do("/api/state", &out)
	return out, err
}

func (c *remoteClient) transcript(id string) (remotewire.Transcript, error) {
	var out remotewire.Transcript
	err := c.do("/api/session/"+url.PathEscape(id), &out)
	return out, err
}

// post sends a JSON body and decodes the reply.
func (c *remoteClient) post(path string, in, out any) error {
	payload, err := json.Marshal(in)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
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

// createSession starts a session in a project and returns its id. An
// agent, when given, is the way of working the session keeps.
func (c *remoteClient) createSession(project string) (string, string, error) {
	return c.createAgentSession(project, "")
}

// createAgentSession is createSession with a way of working.
func (c *remoteClient) createAgentSession(project, agent string) (string, string, error) {
	var out struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	body := map[string]string{"project": project}
	if agent != "" {
		body["agent"] = agent
	}
	if err := c.post("/api/sessions", body, &out); err != nil {
		return "", "", err
	}
	if out.ID == "" {
		return "", "", errors.New("电脑没有返回会话 ID")
	}
	return out.ID, out.Title, nil
}

// agents lists the ways of working a new session can start with.
func (c *remoteClient) agents() ([]remotewire.Agent, error) {
	var out remotewire.Agents
	err := c.do("/api/agents", &out)
	return out.Agents, err
}

// tasks lists the desktop's cron tasks.
func (c *remoteClient) tasks() ([]remotewire.Task, error) {
	var out remotewire.Tasks
	err := c.do("/api/tasks", &out)
	return out.Tasks, err
}

// setTaskEnabled switches a cron task on or off on the desktop.
func (c *remoteClient) setTaskEnabled(id string, enabled bool) error {
	return c.post("/api/tasks/"+url.PathEscape(id)+"/toggle", map[string]bool{"enabled": enabled}, nil)
}

// runTask starts a cron task now, beside its schedule.
func (c *remoteClient) runTask(id string) error {
	return c.post("/api/tasks/"+url.PathEscape(id)+"/run", map[string]any{}, nil)
}

// favorites lists the answers and sessions saved on the desktop.
func (c *remoteClient) favorites() ([]remotewire.Favorite, error) {
	var out remotewire.Favorites
	err := c.do("/api/favorites", &out)
	return out.Favorites, err
}

// addProject puts a folder on the desktop's rail; remove takes one off.
func (c *remoteClient) addProject(path string, remove bool) error {
	return c.post("/api/projects", map[string]any{"path": path, "remove": remove}, nil)
}

// search looks for a word in every session's messages.
func (c *remoteClient) search(query, project string) ([]remotewire.Hit, error) {
	path := "/api/search?q=" + url.QueryEscape(query)
	if project != "" {
		path += "&project=" + url.QueryEscape(project)
	}
	var out struct {
		Hits []remotewire.Hit `json:"hits"`
	}
	err := c.do(path, &out)
	return out.Hits, err
}

// options lists a session's models and thinking levels.
func (c *remoteClient) options(id string) (remotewire.Options, error) {
	var out remotewire.Options
	err := c.do("/api/session/"+url.PathEscape(id)+"/options", &out)
	return out, err
}

// setModel switches a session's model.
func (c *remoteClient) setModel(id, provider, modelID string) error {
	return c.post("/api/sessions/"+url.PathEscape(id)+"/model", map[string]string{"provider": provider, "id": modelID}, nil)
}

// setThinking switches a session's reasoning level.
func (c *remoteClient) setThinking(id, level string) error {
	return c.post("/api/sessions/"+url.PathEscape(id)+"/thinking", map[string]string{"level": level}, nil)
}

func (c *remoteClient) prompt(id, text string) error {
	return c.promptWithImages(id, text, nil)
}

// promptWithImages sends a message with pictures attached.
func (c *remoteClient) promptWithImages(id, text string, images []remotewire.Image) error {
	type wireImage struct {
		Mime string `json:"mime"`
		Data string `json:"data"`
	}
	body := map[string]any{"text": text}
	if len(images) > 0 {
		list := make([]wireImage, 0, len(images))
		for _, img := range images {
			list = append(list, wireImage{Mime: img.MimeType, Data: base64.StdEncoding.EncodeToString(img.Data)})
		}
		body["images"] = list
	}
	return c.post("/api/sessions/"+url.PathEscape(id)+"/prompt", body, nil)
}

// git reads a project's repository.
func (c *remoteClient) git(project string) (remotewire.Git, error) {
	var out remotewire.Git
	err := c.do("/api/git?project="+url.QueryEscape(project), &out)
	return out, err
}

// files lists a project's files.
func (c *remoteClient) files(project string) ([]remotewire.File, error) {
	var out struct {
		Files []remotewire.File `json:"files"`
	}
	err := c.do("/api/files?project="+url.QueryEscape(project), &out)
	return out.Files, err
}

// file reads one file's text.
func (c *remoteClient) file(project, path string) (string, error) {
	var out struct {
		Text string `json:"text"`
	}
	err := c.do("/api/file?project="+url.QueryEscape(project)+"&path="+url.QueryEscape(path), &out)
	return out.Text, err
}

// gitDiff reads one changed file's patch.
func (c *remoteClient) gitDiff(project, path string) (string, error) {
	var out struct {
		Patch string `json:"patch"`
	}
	err := c.do("/api/git/diff?project="+url.QueryEscape(project)+"&path="+url.QueryEscape(path), &out)
	return out.Patch, err
}

// gitStage stages or unstages one path.
func (c *remoteClient) gitStage(project, path string, stage bool) error {
	return c.post("/api/git/stage", map[string]any{"project": project, "path": path, "stage": stage}, nil)
}

// gitCheckout switches to a local branch.
func (c *remoteClient) gitCheckout(project, branch string) error {
	return c.post("/api/git/checkout", map[string]any{"project": project, "branch": branch}, nil)
}

// gitSync fetches, pulls or pushes.
func (c *remoteClient) gitSync(project, action string) error {
	return c.post("/api/git/sync", map[string]any{"project": project, "action": action}, nil)
}

// gitCommit commits what is staged.
func (c *remoteClient) gitCommit(project, message string) error {
	return c.post("/api/git/commit", map[string]any{"project": project, "message": message}, nil)
}

// answer replies to the question a session is waiting on.
func (c *remoteClient) answer(id string, body map[string]any) error {
	return c.post("/api/sessions/"+url.PathEscape(id)+"/answer", body, nil)
}

func (c *remoteClient) stop(id string) error {
	return c.post("/api/sessions/"+url.PathEscape(id)+"/stop", map[string]any{}, nil)
}

func (c *remoteClient) rename(id, title string) error {
	return c.post("/api/sessions/"+url.PathEscape(id)+"/rename", map[string]string{"title": title}, nil)
}

func (c *remoteClient) pin(id string, pinned bool) error {
	return c.post("/api/sessions/"+url.PathEscape(id)+"/pin", map[string]bool{"pinned": pinned}, nil)
}

func (c *remoteClient) deleteSession(id string) error {
	return c.post("/api/sessions/"+url.PathEscape(id)+"/delete", map[string]any{}, nil)
}

// remoteErrorText is a connection failure as one readable line.
func remoteErrorText(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, errRemoteAuth) {
		return "访问令牌无效，请在电脑端设置 → 远程里复制新的连接链接"
	}
	return viewkit.FirstLine(err.Error(), 200)
}
