package client

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

type transcriptPicture struct {
	Ref   string
	Open  bool
	Image remotewire.Image
}

type transcriptImageKey struct {
	client       *remoteClient
	session, ref string
}

// Only UI callbacks touch the cache. Remounted virtual rows share a bounded
// request so transcript polling cannot repeatedly cancel a slow image download.
type transcriptImageCache struct {
	ctx     context.Context
	items   map[transcriptImageKey]remotewire.Image
	order   []transcriptImageKey
	bytes   int
	slots   chan struct{}
	pending map[transcriptImageKey]*transcriptImageRequest
}

type transcriptImageRequest struct {
	done  chan struct{}
	image remotewire.Image
	err   error
}

func (a *mobileApp) requestTranscriptImage(key transcriptImageKey) *transcriptImageRequest {
	c := &a.transcriptImages
	if r := c.pending[key]; r != nil {
		return r
	}
	if c.pending == nil {
		c.pending = make(map[transcriptImageKey]*transcriptImageRequest)
	}
	r := &transcriptImageRequest{done: make(chan struct{})}
	if len(c.pending) >= 24 {
		r.err = errors.New("image download queue is full")
		close(r.done)
		return r
	}
	c.pending[key] = r
	if c.slots == nil {
		c.slots = make(chan struct{}, 3)
	}
	slots := c.slots
	ctx, cancel := context.WithTimeout(c.ctx, 12*time.Second)
	go func() {
		defer cancel()
		select {
		case slots <- struct{}{}:
			r.image, r.err = key.client.transcriptImage(ctx, key.session, key.ref)
			<-slots
		case <-ctx.Done():
			r.err = ctx.Err()
		}
		close(r.done)
		a.cx.Post(func() {
			delete(c.pending, key)
			if r.err == nil && a.client == key.client {
				c.put(key, r.image)
			}
		})
	}()
	return r
}

func (c *transcriptImageCache) put(key transcriptImageKey, image remotewire.Image) {
	if c.items == nil {
		c.items = make(map[transcriptImageKey]remotewire.Image)
	}
	if old, ok := c.items[key]; ok {
		c.bytes -= len(old.Data)
		c.order = slices.DeleteFunc(c.order, func(k transcriptImageKey) bool { return k == key })
	}
	c.items[key] = image
	c.order = append(c.order, key)
	c.bytes += len(image.Data)
	for len(c.order) > 24 || c.bytes > 12<<20 {
		old := c.order[0]
		c.order = c.order[1:]
		c.bytes -= len(c.items[old].Data)
		delete(c.items, old)
	}
}

func (c *remoteClient) transcriptImage(parent context.Context, sessionID, ref string) (remotewire.Image, error) {
	ctx, cancel := context.WithTimeout(parent, 12*time.Second)
	defer cancel()
	query := url.Values{"session": {sessionID}, "ref": {ref}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/transcript-image?"+query.Encode(), nil)
	if err != nil {
		return remotewire.Image{}, err
	}
	req.Header.Set("Authorization", "Bearer "+c.currentToken())
	resp, err := c.http.Do(req)
	if err != nil {
		return remotewire.Image{}, err
	}
	defer resp.Body.Close()
	c.rotate(resp)
	if resp.StatusCode == http.StatusUnauthorized {
		return remotewire.Image{}, errRemoteAuth
	}
	if resp.StatusCode != http.StatusOK {
		return remotewire.Image{}, errors.New(apptext.T("无法读取会话图片"))
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, remotewire.MaxTranscriptImageBytes+1))
	if err != nil || len(data) == 0 || len(data) > remotewire.MaxTranscriptImageBytes {
		return remotewire.Image{}, errors.New(apptext.T("无法读取会话图片"))
	}
	mime := http.DetectContentType(data)
	switch mime {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return remotewire.Image{Data: data, MimeType: mime}, nil
	default:
		return remotewire.Image{}, errors.New(apptext.T("无法读取会话图片"))
	}
}

func (a *mobileApp) resetTranscriptPicture() {
	a.transcriptPictureSeq++
	a.transcriptPicture.Set(transcriptPicture{})
}

func (a *mobileApp) showTranscriptPicture(ref string) {
	client, id := a.client, a.active.GetUntracked()
	if client == nil || id == "" || ref == "" {
		return
	}
	if p := a.transcriptPicture.GetUntracked(); p.Ref == ref && len(p.Image.Data) > 0 {
		p.Open = true
		a.transcriptPicture.Set(p)
		return
	}
	a.transcriptPictureSeq++
	seq := a.transcriptPictureSeq
	key := transcriptImageKey{client, id, ref}
	if img, ok := a.transcriptImages.items[key]; ok {
		a.transcriptPicture.Set(transcriptPicture{Ref: ref, Open: true, Image: img})
		return
	}
	a.transcriptPicture.Set(transcriptPicture{Ref: ref, Open: true})
	go func() {
		img, err := client.transcriptImage(a.transcriptImages.ctx, id, ref)
		a.cx.Post(func() {
			if a.transcriptPictureSeq != seq || a.client != client || a.active.GetUntracked() != id {
				return
			}
			if err != nil {
				a.resetTranscriptPicture()
				if errors.Is(err, errRemoteAuth) {
					a.disconnectWith(remoteErrorText(err))
				} else {
					a.flash(apptext.T("无法读取会话图片"))
				}
				return
			}
			a.transcriptImages.put(key, img)
			a.transcriptPicture.Set(transcriptPicture{Ref: ref, Open: true, Image: img})
		})
	}()
}

func (a *mobileApp) transcriptImageRow(m remotewire.Message) core.Node {
	if m.Image == "" {
		return chat.AttachmentPreview{Label: apptext.T("图片")}
	}
	return core.Func(func(cx *core.Scope) core.Node {
		client, id := a.client, a.active.GetUntracked()
		key := transcriptImageKey{client, id, m.Image}
		cached := a.transcriptImages.items[key]
		image := core.NewSignalFunc(cx, cached, nil)
		if client != nil && id != "" && len(cached.Data) == 0 {
			r, ctx := a.requestTranscriptImage(key), cx.Context()
			go func() {
				select {
				case <-r.done:
				case <-ctx.Done():
					return
				}
				cx.Post(func() {
					if r.err == nil && a.client == client && a.active.GetUntracked() == id {
						image.Set(r.image)
					}
				})
			}()
		}
		return core.Dynamic(func(*core.Scope) core.Node {
			if img := image.Get(); len(img.Data) > 0 {
				return core.View{Role: core.RoleButton, TestID: "mobile-transcript-thumbnail", Label: apptext.T("查看图片"),
					OnPress: func(core.PressEvent) {
						a.transcriptPictureSeq++
						a.transcriptPicture.Set(transcriptPicture{Ref: m.Image, Open: true, Image: img})
					}, Children: []core.Node{chat.AttachmentPreview{Label: apptext.T("图片"), Image: core.ImageSource{Data: img.Data}}}}
			}
			return ui.Button{Text: apptext.T("查看图片"), Icon: lucide.Image, Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
				TestID: "mobile-transcript-image", OnPress: func() { a.showTranscriptPicture(m.Image) }}
		})
	})
}
