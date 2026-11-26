//go:build !js && !android && !ios

package workbench

// Review navigation is local to a project and a repository. Cached views
// retain UI choices and unsent drafts; GitHub remains the source of items.

type reviewView struct {
	state                       reviewState
	kind, filter, query, search string
	drafts                      map[string]string
	limit                       int
}

func (r *review) projectKey() string {
	return r.target.key() + "|" + r.path
}

func (r *review) viewKey() string {
	_, path := r.repo()
	return r.projectKey() + "\x00" + path
}

func (r *review) rememberDraft() {
	if key := r.state.GetUntracked().Open; key != "" {
		r.drafts[key] = r.commentText.GetUntracked()
	}
}

func (r *review) rememberView() {
	if r.path == "" {
		return
	}
	r.rememberDraft()
	st := r.state.GetUntracked()
	st.Loading, st.DetailBusy, st.PatchBusy = false, false, false
	r.views[r.viewKey()] = reviewView{
		state: st, kind: r.kind.GetUntracked(), filter: r.filter.GetUntracked(),
		query: r.query.GetUntracked(), search: r.search.GetUntracked(), drafts: r.drafts, limit: r.limit,
	}
	r.selectedRepos[r.projectKey()] = r.repoPath
}

func (r *review) restoreView() {
	v, ok := r.views[r.viewKey()]
	if !ok {
		v = reviewView{kind: reviewPR, filter: filterOpen, limit: 40, drafts: make(map[string]string)}
	}
	r.limit, r.drafts = v.limit, v.drafts
	r.kind.Set(v.kind)
	r.filter.Set(v.filter)
	r.query.Set(v.query)
	r.search.Set(v.search)
	r.commentText.Set(r.drafts[v.state.Open])
	r.mergeOpen.Set(false)
	r.reviewOpen.Set(false)
	r.patchOpen.Set(false)
	r.state.Set(v.state)
}

// publishList replaces only the list fields. A list response must not
// overwrite a concurrent detail read, write status, draft or patch.
func (r *review) publishList(st reviewState) {
	r.state.Update(func(old reviewState) reviewState {
		old.Checked, old.Loading, old.Limit = true, false, st.Limit
		old.Error, old.Missing, old.NeedsLogin = st.Error, st.Missing, st.NeedsLogin
		if st.Error == "" || st.Missing || st.NeedsLogin {
			old.Items = st.Items
		}
		return old
	})
}

func (r *review) finishWrite(view, key, label, action, body string, err error) {
	active := view == r.viewKey()
	v := r.views[view]
	st, drafts := v.state, v.drafts
	if active {
		st, drafts = r.state.GetUntracked(), r.drafts
	}
	st.Writing, st.WriteAction = false, ""
	if st.Open == key {
		if err != nil {
			st.DetailError = reviewErrorText(err)
		} else {
			st.WriteOK, st.DetailError = label, ""
		}
	}
	if err == nil && (action == reviewActComment || action == reviewActReview) {
		if drafts[key] == body {
			delete(drafts, key)
		}
		if active && st.Open == key && r.commentText.GetUntracked() == body {
			r.commentText.Set("")
		}
	}
	if !active {
		v.state = st
		r.views[view] = v
		return
	}
	r.state.Set(st)
	if err == nil {
		r.reload()
		if st.Open == key {
			r.reopenItem()
		}
	}
}
