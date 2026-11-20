//go:build !js && !android && !ios

package workbench

import (
	"context"
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type memoryLookup struct {
	Query string `json:"query" jsonschema:"Words to search for"`
}

type memorySave struct {
	ID    string `json:"id,omitempty" jsonschema:"Existing project memory ID to update"`
	Title string `json:"title" jsonschema:"Short title for the note"`
	Body  string `json:"body" jsonschema:"A durable project fact, preference, or decision as Markdown"`
}

type memoryRead struct {
	ID string `json:"id" jsonschema:"Memory ID returned by memory_search"`
}

type memoryMatch struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Snippet string `json:"snippet"`
}

type memoryMatches struct {
	Matches []memoryMatch `json:"matches"`
}

func (a *app) memoryServer(s *session) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "pideck-lite-memory", Version: "1"}, nil)
	project := s.Target.key() + "|" + s.WS
	store := a.memory.store
	visible := func(e memoryEntry) bool { return e.Project == "" || e.Project == project }
	mcp.AddTool(server, &mcp.Tool{Name: "memory_search", Description: "Search notes in this trusted project and notes the user saved globally."},
		func(_ context.Context, _ *mcp.CallToolRequest, in memoryLookup) (*mcp.CallToolResult, memoryMatches, error) {
			query := strings.ToLower(strings.TrimSpace(in.Query))
			out := memoryMatches{Matches: []memoryMatch{}}
			for _, e := range store.snapshot() {
				if !visible(e) {
					continue
				}
				at := strings.Index(strings.ToLower(e.Body), query)
				if at < 0 && !strings.Contains(strings.ToLower(e.Title), query) {
					continue
				}
				out.Matches = append(out.Matches, memoryMatch{ID: e.ID, Title: e.Title, Snippet: searchSnippet(e.Body, max(at, 0), 180)})
				if len(out.Matches) == 15 {
					break
				}
			}
			return nil, out, nil
		})
	mcp.AddTool(server, &mcp.Tool{Name: "memory_read", Description: "Read one accessible note by ID."},
		func(_ context.Context, _ *mcp.CallToolRequest, in memoryRead) (*mcp.CallToolResult, memoryEntry, error) {
			for _, e := range store.snapshot() {
				if e.ID == in.ID && visible(e) {
					return nil, e, nil
				}
			}
			return nil, memoryEntry{}, errors.New("memory not found")
		})
	mcp.AddTool(server, &mcp.Tool{Name: "memory_write", Description: "Save a durable project fact or update a project note. Keep credentials and private conversation contents out of notes."},
		func(_ context.Context, _ *mcp.CallToolRequest, in memorySave) (*mcp.CallToolResult, memoryEntry, error) {
			e := memoryEntry{ID: in.ID, Project: project, Title: in.Title, Body: in.Body}
			if e.ID != "" {
				list := store.snapshot()
				i := slices.IndexFunc(list, func(item memoryEntry) bool { return item.ID == in.ID && item.Project == project })
				if i < 0 {
					return nil, memoryEntry{}, errors.New("project memory not found")
				}
				e.Updated = list[i].Updated
			}
			e, err := store.put(e)
			if err == nil {
				a.cx.Post(a.refreshMemory)
			}
			return nil, e, err
		})
	mcp.AddTool(server, &mcp.Tool{Name: "session_search", Description: "Search title and transcript snippets of PiDeck Lite sessions in this trusted project."},
		func(ctx context.Context, _ *mcp.CallToolRequest, in memoryLookup) (*mcp.CallToolResult, memoryMatches, error) {
			matches, err := a.memorySessionSearch(ctx, s, in.Query)
			return nil, matches, err
		})
	return server
}

func (a *app) memorySessionSearch(ctx context.Context, s *session, query string) (memoryMatches, error) {
	out := memoryMatches{Matches: []memoryMatch{}}
	query = strings.TrimSpace(query)
	if query == "" || len(query) > 256 {
		return out, errors.New("a search query of up to 256 bytes is required")
	}
	type source struct{ id, title, file string }
	var sources []source
	if !a.withUI(func() {
		if ws := a.workspaceFor(s.Target, s.WS); ws != nil && a.projectTrusted(ws) {
			for _, item := range ws.Sessions.GetUntracked() {
				if item.External || item.deleting {
					continue
				}
				file := item.File
				if item.backend == "acp" {
					file = filepath.Join(a.acpArchiveDir(), archiveName(item.ID))
				}
				sources = append(sources, source{item.ID, item.title.GetUntracked(), file})
				if len(sources) == 250 {
					break
				}
			}
		}
	}) {
		return out, errors.New("workspace is busy")
	}
	var docs []searchDoc
	for _, src := range sources {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		text := a.remote.searchText(src.file)
		docs = append(docs, searchDoc{ID: src.id, Title: src.title, Text: text})
	}
	for _, h := range matchSearch(ctx, docs, query, 15) {
		out.Matches = append(out.Matches, memoryMatch{ID: h.ID, Title: h.Title, Snippet: h.Snippet})
	}
	return out, ctx.Err()
}

// A listener belongs to one pi process. It is never mounted on the LAN
// service. The token and current project trust both gate each request.
func (a *app) startMemoryTools(s *session) (url, token string, stop func(), err error) {
	return a.startPrivateTools(s, a.memoryServer(s), func() bool { return a.cfg.MemoryTools })
}

func (a *app) startPrivateTools(s *session, server *mcp.Server, enabled func() bool) (url, token string, stop func(), err error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", "", nil, err
	}
	address := listener.Addr().String()
	secret := newSessionID() + newSessionID()
	mcpHandler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	httpServer := &http.Server{ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 100 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Host != address || r.URL.Path != "/mcp" || r.Header.Get("Origin") != "" ||
				subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+secret)) != 1 {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			allowed := false
			if !a.withUI(func() {
				ws := a.workspaceFor(s.Target, s.WS)
				allowed = a.byID[s.ID] == s && !s.deleting && enabled() && ws != nil && a.projectTrusted(ws)
			}) || !allowed {
				http.Error(w, "project tools are not enabled", http.StatusForbidden)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
			mcpHandler.ServeHTTP(w, r)
		})}
	go func() { _ = httpServer.Serve(listener) }()
	return "http://" + address + "/mcp", secret, func() { _ = httpServer.Close() }, nil
}
