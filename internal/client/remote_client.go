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
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/relaywire"
	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
)

// errRemoteAuth says the token was refused, so the phone must reconnect.
var errRemoteAuth = errors.New("访问令牌无效或已过期")

type remoteClient struct {
	base  string
	token string
	http  *http.Client
	// source is what the connect field and the recent list keep: the
	// address for a direct connection, the pairing link for a relay one.
	source string
}

// newRemoteClient normalizes an address and token. A pasted connection
// link's ?token= fills the token when the field is empty; a relay pairing
// link carries its own address, token and pinned certificate.
func newRemoteClient(raw, token string) (*remoteClient, string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, "", errors.New("请填写电脑的连接地址")
	}
	if relaywire.IsLink(raw) {
		link, err := relaywire.Parse(raw)
		if err != nil {
			return nil, "", errors.New("配对链接不完整，请在电脑端重新生成")
		}
		return newRelayClient(link, raw)
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
	return &remoteClient{base: base, source: base, token: token, http: &http.Client{Timeout: 12 * time.Second}}, token, nil
}

// close drops idle connections, including a relay tunnel, so switching
// servers does not leave one open.
func (c *remoteClient) close() {
	if c == nil || c.http == nil {
		return
	}
	c.http.CloseIdleConnections()
}

// do reads a path, once more when the first try never reached the desktop:
// a phone that changed networks or came back from the background fails the
// first read, and the next one dials the relay again.
func (c *remoteClient) do(path string, out any) error {
	err := c.get(path, out)
	if err != nil && transient(err) {
		time.Sleep(retryDelay)
		err = c.get(path, out)
	}
	return err
}

func (c *remoteClient) get(path string, out any) error {
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

// transcript reads a page of a session: the newest turns, or the ones
// ending at before when the client already holds the newer page.
func (c *remoteClient) transcript(id string, before int) (remotewire.Transcript, error) {
	var out remotewire.Transcript
	path := "/api/session/" + url.PathEscape(id)
	if before > 0 {
		path += "?before=" + strconv.Itoa(before)
	}
	err := c.do(path, &out)
	return out, err
}

// post sends a JSON body and decodes the reply.
func (c *remoteClient) post(path string, in, out any) error {
	return c.postWithin(path, in, out, 20*time.Second)
}

// postWithin is post with its own deadline: a model call or a generated
// picture takes longer than a settings change. A request whose tunnel could
// not be dialed at all is sent once more, since it never left the phone.
func (c *remoteClient) postWithin(path string, in, out any, limit time.Duration) error {
	payload, err := json.Marshal(in)
	if err != nil {
		return err
	}
	send := func() (*http.Response, context.CancelFunc, error) {
		ctx, cancel := context.WithTimeout(context.Background(), limit)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(payload))
		if err != nil {
			cancel()
			return nil, nil, err
		}
		req.Header.Set("Authorization", "Bearer "+c.token)
		req.Header.Set("Content-Type", "application/json")
		// The client's own deadline is the short one every request shares;
		// a model call or a drawn picture needs the one it asked for.
		hc := *c.http
		hc.Timeout = limit
		resp, err := hc.Do(req)
		if err != nil {
			cancel()
			return nil, nil, err
		}
		return resp, cancel, nil
	}
	resp, cancel, err := send()
	if err != nil && undialed(err) {
		time.Sleep(retryDelay)
		resp, cancel, err = send()
	}
	if err != nil {
		return fmt.Errorf("连接失败：%w", err)
	}
	defer cancel()
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

// voice sends a WAV recording to the desktop, which transcribes it; the
// reply is what it said, empty when it held no speech.
func (c *remoteClient) voice(wav []byte) (string, error) {
	var out remotewire.VoiceText
	err := c.postWithin("/api/voice", remotewire.VoiceRequest{Format: "wav", Data: base64.StdEncoding.EncodeToString(wav)},
		&out, 60*time.Second)
	return out.Text, err
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

// setMode switches what the session's next turn asks for: "" for a plain
// prompt, or "plan", "goal" or "imagegen".
func (c *remoteClient) setMode(id, mode string) (string, error) {
	var out struct {
		Mode string `json:"mode"`
	}
	err := c.post("/api/sessions/"+url.PathEscape(id)+"/mode", map[string]string{"mode": mode}, &out)
	return out.Mode, err
}

// setBackend switches a session that has not started between pi and an ACP
// preset.
func (c *remoteClient) setBackend(id, backend, preset string) error {
	return c.post("/api/sessions/"+url.PathEscape(id)+"/backend", map[string]string{"backend": backend, "preset": preset}, nil)
}

// draftTool asks the desktop's model to rewrite or continue the text.
func (c *remoteClient) draftTool(id, tool, text string) (string, error) {
	var out struct {
		Text string `json:"text"`
	}
	err := c.postWithin("/api/sessions/"+url.PathEscape(id)+"/tools", map[string]string{"tool": tool, "text": text}, &out, 90*time.Second)
	return out.Text, err
}

// drawImage asks the desktop's image provider for a picture of the words.
func (c *remoteClient) drawImage(id, prompt string) ([]remotewire.Picture, error) {
	var out remotewire.Pictures
	err := c.postWithin("/api/sessions/"+url.PathEscape(id)+"/image", map[string]string{"prompt": prompt}, &out, 150*time.Second)
	return out.Images, err
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
// review lists a project's pull requests or issues.
func (c *remoteClient) review(project, kind, state, query string) (remotewire.ReviewList, error) {
	var out remotewire.ReviewList
	path := "/api/review?project=" + url.QueryEscape(project) + "&kind=" + url.QueryEscape(kind) + "&state=" + url.QueryEscape(state)
	if query != "" {
		path += "&q=" + url.QueryEscape(query)
	}
	err := c.do(path, &out)
	return out, err
}

// reviewDetail reads one pull request or issue.
func (c *remoteClient) reviewDetail(project, kind string, number int) (remotewire.ReviewDetail, error) {
	var out remotewire.ReviewDetail
	path := "/api/review/detail?project=" + url.QueryEscape(project) + "&kind=" + url.QueryEscape(kind) + "&number=" + fmt.Sprint(number)
	err := c.do(path, &out)
	return out, err
}

// reviewDiff reads a pull request's unified patch.
func (c *remoteClient) reviewDiff(project string, number int) (string, error) {
	var out struct {
		Patch string `json:"patch"`
	}
	path := "/api/review/diff?project=" + url.QueryEscape(project) + "&kind=pr&number=" + fmt.Sprint(number)
	err := c.do(path, &out)
	return out.Patch, err
}

// reviewWrite posts a comment, merges, closes, reopens or submits a review.
func (c *remoteClient) reviewWrite(project, kind string, number int, action, body, method string) error {
	in := map[string]any{"project": project, "kind": kind, "number": number, "action": action, "body": body, "method": method}
	return c.post("/api/review/action", in, nil)
}

// reviewEvaluate asks the desktop to hand an item to a session and
// returns that session's id.
func (c *remoteClient) reviewEvaluate(project, kind string, number int) (string, error) {
	in := map[string]any{"project": project, "kind": kind, "number": number}
	var out remotewire.ReviewEvaluation
	if err := c.post("/api/review/evaluate", in, &out); err != nil {
		return "", err
	}
	if out.Error != "" {
		return "", errors.New(out.Error)
	}
	return out.Session, nil
}

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

// pollErrorText is what a read that failed on the way says. The phone is
// already connected, so a dropped tunnel is a moment, not an error: the
// next try dials again.
func pollErrorText(err error) string {
	if transient(err) {
		return apptext.T("网络不稳，正在重连…")
	}
	return remoteErrorText(err)
}

// retryDelay is how long a read waits before its second try, long enough
// for the transport to dial the relay again.
const retryDelay = 300 * time.Millisecond

// transient says the request failed on the way, not in the desktop's
// answer: the tunnel dropped, the network changed, or the phone woke up
// holding a socket the relay had already let go.
func transient(err error) bool {
	if err == nil || errors.Is(err, errRemoteAuth) {
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) ||
		errors.Is(err, syscall.ECONNABORTED)
}

// undialed says the request never left the phone, so sending it again
// cannot repeat a prompt: the tunnel could not be opened at all.
func undialed(err error) bool {
	return transient(err) && strings.Contains(err.Error(), "dial")
}
