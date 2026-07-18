import { useCallback, useEffect, useState } from "react";
import {
  GitBranch, GitCommit, GitCompare, GitGraph, GitPullRequest,
  ChevronDown, ChevronRight, RefreshCw, Loader2,
  Clock, FileDiff, Plus, Minus, Check, X,
} from "lucide-react";
import type { CommitEntry, BranchDiffResult, GitResource, GitResourceGroups } from "../../../../shared/types";
import { GitStatus } from "../../../../shared/types";

function shortHash(h: string) { return h.slice(0, 7); }

function relativeTime(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  if (sec < 2592000) return `${Math.floor(sec / 86400)}d`;
  return `${Math.floor(sec / 2592000)}mo`;
}

function refTagClass(name: string): string {
  if (name.startsWith("HEAD")) return "git-ref-head";
  if (name.startsWith("origin/")) return "git-ref-remote";
  if (name.startsWith("tag:")) return "git-ref-tag";
  return "git-ref-branch";
}

function parseRefNames(refNames: string[]): string[] {
  return refNames.flatMap((r) => r.split(",").map((s) => s.trim()).filter(Boolean));
}

function statusClass(r: GitResource): string {
  if (r.status <= GitStatus.INDEX_COPIED) return "git-status-staged";
  if (r.status >= GitStatus.ADDED_BY_US) return "git-status-conflict";
  return "git-status-unstaged";
}

type SubTab = "changes" | "history" | "compare";

// ══════════════════════════════════════════════════════════════════════

export function GitPanel(props: {
  projectId: string;
  commitLog: (projectId: string, options?: { maxEntries?: number; ref?: string; allBranches?: boolean }) => Promise<CommitEntry[]>;
  commitDetail: (projectId: string, ref: string) => Promise<CommitEntry | null>;
  branchCompare: (projectId: string, base: string, target: string) => Promise<BranchDiffResult>;
  getStatus: (projectId: string) => Promise<GitResourceGroups>;
  stageFiles: (projectId: string, paths: string[]) => Promise<void>;
  unstageFiles: (projectId: string, paths: string[]) => Promise<void>;
  commit: (projectId: string, message: string) => Promise<void>;
  branches: string[];
  currentBranch: string | null;
}) {
  const [subTab, setSubTab] = useState<SubTab>("changes");

  return (
    <div className="git-panel">
      <div className="git-subtab-bar">
        <button className={`git-subtab${subTab === "changes" ? " active" : ""}`} onClick={() => setSubTab("changes")}>
          <GitPullRequest size={13} /><span>Changes</span>
        </button>
        <button className={`git-subtab${subTab === "history" ? " active" : ""}`} onClick={() => setSubTab("history")}>
          <GitCommit size={13} /><span>History</span>
        </button>
        <button className={`git-subtab${subTab === "compare" ? " active" : ""}`} onClick={() => setSubTab("compare")}>
          <GitCompare size={13} /><span>Compare</span>
        </button>
      </div>
      {subTab === "changes" ? <ChangesView projectId={props.projectId} getStatus={props.getStatus} stageFiles={props.stageFiles} unstageFiles={props.unstageFiles} commit={props.commit} /> :
       subTab === "history" ? <HistoryView projectId={props.projectId} commitLog={props.commitLog} commitDetail={props.commitDetail} branches={props.branches} currentBranch={props.currentBranch} /> :
       <CompareView projectId={props.projectId} branches={props.branches} branchCompare={props.branchCompare} />}
    </div>
  );
}

// ═══════════════════════ Changes View (VS Code SCM) ══════════════════════

function ChangesView(props: {
  projectId: string;
  getStatus: (projectId: string) => Promise<GitResourceGroups>;
  stageFiles: (projectId: string, paths: string[]) => Promise<void>;
  unstageFiles: (projectId: string, paths: string[]) => Promise<void>;
  commit: (projectId: string, message: string) => Promise<void>;
}) {
  const [groups, setGroups] = useState<GitResourceGroups>({ merge: [], index: [], workingTree: [], untracked: [] });
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setGroups(await props.getStatus(props.projectId)); }
    catch { setGroups({ merge: [], index: [], workingTree: [], untracked: [] }); }
    finally { setLoading(false); }
  }, [props.projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const stage = async (paths: string[]) => { try { await props.stageFiles(props.projectId, paths); } catch {} await refresh(); };
  const unstage = async (paths: string[]) => { try { await props.unstageFiles(props.projectId, paths); } catch {} await refresh(); };
  const doCommit = async () => {
    if (!commitMsg.trim() || committing) return;
    setCommitting(true);
    try { await props.commit(props.projectId, commitMsg.trim()); setCommitMsg(""); await refresh(); }
    catch {}
    finally { setCommitting(false); }
  };

  const totalChanges = groups.index.length + groups.workingTree.length + groups.untracked.length;

  return (
    <>
      {/* Commit input */}
      <div className="git-commit-input-area">
        <textarea className="git-commit-input" placeholder="Message (Ctrl+Enter to commit)"
          value={commitMsg} onChange={(e) => setCommitMsg(e.target.value)} rows={3}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && commitMsg.trim() && !committing) {
              e.preventDefault(); doCommit();
            }
          }}
        />
        <div className="git-commit-input-actions">
          <span className="git-commit-branch"><GitBranch size={12} /></span>
          <button className="git-toolbar-btn primary" disabled={!commitMsg.trim() || committing} onClick={doCommit}>
            {committing ? <Loader2 size={13} className="spinner" /> : <Check size={13} />}
            <span>{committing ? "Committing..." : "Commit"}</span>
          </button>
          <button className="git-toolbar-btn" onClick={refresh} title="Refresh"><RefreshCw size={13} /></button>
        </div>
      </div>

      {loading && totalChanges === 0 && <div className="git-panel-placeholder"><Loader2 size={18} className="spinner" />Loading...</div>}
      {!loading && totalChanges === 0 && <div className="git-panel-placeholder"><Check size={22} /><span>No changes</span><small>Working tree clean</small></div>}

      {/* Staged Changes */}
      {groups.index.length > 0 && (
        <div className="git-resource-group">
          <div className="git-resource-group-header"><ChevronDown size={12} /><span>Staged Changes</span><span className="git-group-count">{groups.index.length}</span><button className="git-group-action" onClick={() => unstage(groups.index.map(r => r.path))} title="Unstage All"><Minus size={12} /></button></div>
          {groups.index.map(r => <ResourceRow key={r.path} resource={r} actionIcon={<Minus size={14} />} actionLabel="Unstage" onAction={() => unstage([r.path])} />)}
        </div>
      )}
      {/* Working Tree */}
      {groups.workingTree.length > 0 && (
        <div className="git-resource-group">
          <div className="git-resource-group-header"><ChevronDown size={12} /><span>Changes</span><span className="git-group-count">{groups.workingTree.length}</span><button className="git-group-action" onClick={() => stage(groups.workingTree.map(r => r.path))} title="Stage All"><Plus size={12} /></button></div>
          {groups.workingTree.map(r => <ResourceRow key={r.path} resource={r} actionIcon={<Plus size={14} />} actionLabel="Stage" onAction={() => stage([r.path])} />)}
        </div>
      )}
      {/* Merge Conflicts */}
      {groups.merge.length > 0 && (
        <div className="git-resource-group">
          <div className="git-resource-group-header conflict"><ChevronDown size={12} /><span>Merge Conflicts</span><span className="git-group-count">{groups.merge.length}</span></div>
          {groups.merge.map(r => <ResourceRow key={r.path} resource={r} actionIcon={null} actionLabel="" onAction={() => {}} />)}
        </div>
      )}
      {/* Untracked */}
      {groups.untracked.length > 0 && (
        <div className="git-resource-group">
          <div className="git-resource-group-header"><ChevronDown size={12} /><span>Untracked Files</span><span className="git-group-count">{groups.untracked.length}</span><button className="git-group-action" onClick={() => stage(groups.untracked.map(r => r.path))} title="Stage All"><Plus size={12} /></button></div>
          {groups.untracked.map(r => <ResourceRow key={r.path} resource={r} actionIcon={<Plus size={14} />} actionLabel="Stage" onAction={() => stage([r.path])} />)}
        </div>
      )}
    </>
  );
}

function ResourceRow(props: { resource: GitResource; actionIcon: React.ReactNode; actionLabel: string; onAction: () => void }) {
  const r = props.resource, fileName = r.path.split(/[/\\]/).pop() ?? r.path;
  return (
    <div className={`git-resource-row ${statusClass(r)}`}>
      <span className={`git-resource-letter letter-${r.letter.toLowerCase()}`}>{r.letter}</span>
      <span className="git-resource-name">{fileName}</span>
      <span className="git-resource-path">{r.path}</span>
      {props.actionIcon && <button className="git-resource-action" title={`${props.actionLabel} ${fileName}`} onClick={props.onAction}>{props.actionIcon}</button>}
    </div>
  );
}

// ═══════════════════════ History View ════════════════════════════════════

function HistoryView(props: { projectId: string; commitLog: (projectId: string, options?: { maxEntries?: number; ref?: string; allBranches?: boolean }) => Promise<CommitEntry[]>; commitDetail: (projectId: string, ref: string) => Promise<CommitEntry | null>; branches: string[]; currentBranch: string | null }) {
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [allBranches, setAllBranches] = useState(true); const [selectedRef, setSelectedRef] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setCommits(await props.commitLog(props.projectId, { maxEntries: 50, ref: selectedRef || undefined, allBranches })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); }
  }, [props.projectId, selectedRef, allBranches]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="git-panel-toolbar">
        <div className="git-panel-toolbar-left">
          <button className={`git-toolbar-btn${allBranches ? " active" : ""}`} onClick={() => setAllBranches(true)}><GitGraph size={14} /><span>All</span></button>
          <button className={`git-toolbar-btn${!allBranches ? " active" : ""}`} onClick={() => setAllBranches(false)}><GitBranch size={14} /><span>{props.currentBranch ?? "HEAD"}</span></button>
        </div>
        <div className="git-panel-toolbar-right">
          <select className="git-ref-select" value={selectedRef} onChange={(e) => setSelectedRef(e.target.value)}><option value="">All refs</option>{props.branches.map(b => <option key={b} value={b}>{b}</option>)}</select>
          <button className="git-toolbar-btn git-icon-only" onClick={load} title="Refresh"><RefreshCw size={14} /></button>
        </div>
      </div>
      <div className="git-commit-list">
        {loading && commits.length === 0 && <div className="git-panel-placeholder"><Loader2 size={18} className="spinner" />Loading...</div>}
        {error && <div className="git-panel-placeholder error">{error}</div>}
        {!loading && !error && commits.length === 0 && <div className="git-panel-placeholder"><GitCommit size={22} /><span>No commits yet</span></div>}
        {commits.map(c => <CommitRow key={c.hash} commit={c} expanded={expandedCommit === c.hash} onToggle={() => setExpandedCommit(p => p === c.hash ? null : c.hash)} projectId={props.projectId} commitDetail={props.commitDetail} />)}
      </div>
    </>
  );
}

function CommitRow(props: { commit: CommitEntry; expanded: boolean; onToggle: () => void; projectId: string; commitDetail: (projectId: string, ref: string) => Promise<CommitEntry | null> }) {
  const c = props.commit, refNames = parseRefNames(c.refNames);
  return (
    <div className={`git-commit-row${props.expanded ? " expanded" : ""}`}>
      <div className="git-commit-main" onClick={props.onToggle}>
        {c.graph.length > 0 ? <pre className="git-commit-graph">{c.graph.join("\n")}</pre> : <div className="git-commit-graph-placeholder"><span className="git-commit-dot" /></div>}
        <div className="git-commit-body">
          <div className="git-commit-title"><span className="git-commit-hash">{shortHash(c.hash)}</span><span className="git-commit-subject">{c.message}</span></div>
          <div className="git-commit-meta"><span className="git-meta-author">{c.authorName}</span><span className="git-meta-time"><Clock size={10} />{relativeTime(c.authorDate)}</span>{c.shortStat && <span className="git-meta-stat"><Plus size={10} />{c.shortStat.insertions}<Minus size={10} />{c.shortStat.deletions}</span>}</div>
          {refNames.length > 0 && <div className="git-commit-refs">{refNames.map(r => <span key={r} className={`git-ref-tag ${refTagClass(r)}`}>{r}</span>)}</div>}
        </div>
        <div className="git-commit-chevron">{props.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</div>
      </div>
      {props.expanded && <CommitDetailBody hash={c.hash} projectId={props.projectId} commitDetail={props.commitDetail} />}
    </div>
  );
}

function CommitDetailBody(props: { hash: string; projectId: string; commitDetail: (projectId: string, ref: string) => Promise<CommitEntry | null> }) {
  const [d, setD] = useState<CommitEntry | null>(null); const [l, setL] = useState(true);
  useEffect(() => { let c = false; setL(true); props.commitDetail(props.projectId, props.hash).then(d => { if (!c) { setD(d); setL(false); } }); return () => { c = true; }; }, [props.hash, props.projectId]);
  if (l) return <div className="git-commit-detail"><Loader2 size={13} className="spinner" /> Loading...</div>;
  if (!d) return <div className="git-commit-detail error">Failed to load</div>;
  return (
    <div className="git-commit-detail"><div className="git-detail-message">{d.message}</div>
      <div className="git-detail-meta"><span>{d.authorName} &lt;{d.authorEmail}&gt;</span><span>{new Date(d.authorDate).toLocaleString()}</span></div>
      {d.shortStat && <div className="git-detail-stats"><span className="stat-item"><FileDiff size={11} /> {d.shortStat.files} files</span><span className="stat-item add">+{d.shortStat.insertions}</span><span className="stat-item del">-{d.shortStat.deletions}</span></div>}
    </div>
  );
}

// ═══════════════════════ Compare View ════════════════════════════════════

function CompareView(props: { projectId: string; branches: string[]; branchCompare: (projectId: string, base: string, target: string) => Promise<BranchDiffResult> }) {
  const [base, setBase] = useState(""); const [target, setTarget] = useState(props.branches[0] ?? "");
  const [result, setResult] = useState<BranchDiffResult | null>(null); const [loading, setLoading] = useState(false);
  useEffect(() => { if (props.branches.length >= 2 && !base) { setTarget(props.branches[0]!); setBase(props.branches[1]!); } }, [props.branches]);
  const doCompare = useCallback(async () => { if (!base || !target) return; setLoading(true); try { setResult(await props.branchCompare(props.projectId, base, target)); } catch { setResult(null); } finally { setLoading(false); } }, [base, target, props.projectId]);
  return (
    <>
      <div className="git-compare-header">
        <div className="git-compare-selectors">
          <select className="git-ref-select" value={base} onChange={e => setBase(e.target.value)}><option value="">Base</option>{props.branches.map(b => <option key={b} value={b}>{b}</option>)}</select>
          <span className="git-compare-arrow"><GitCompare size={13} /></span>
          <select className="git-ref-select" value={target} onChange={e => setTarget(e.target.value)}><option value="">Compare</option>{props.branches.map(b => <option key={b} value={b}>{b}</option>)}</select>
        </div>
        <button className="git-toolbar-btn primary" onClick={doCompare} disabled={!base || !target || loading}>{loading ? <Loader2 size={13} className="spinner" /> : <GitCompare size={13} />}<span>Compare</span></button>
      </div>
      {result && <div className="git-compare-result">
        <div className="git-compare-summary"><span className="ahead"><Plus size={11} /> {result.ahead} ahead</span><span className="behind"><Minus size={11} /> {result.behind} behind</span><span className="files-count"><FileDiff size={11} /> {result.files.length} files</span></div>
        {result.files.length === 0 ? <div className="git-panel-placeholder"><GitCommit size={20} /><span>No differences</span></div> :
          <div className="git-compare-files">{result.files.map(f => (
            <div key={f.path} className="git-compare-file">
              <span className={`git-file-badge badge-${f.status}`}><span className="badge-letter">{f.status === "added" ? "A" : f.status === "deleted" ? "D" : f.status === "renamed" ? "R" : "M"}</span></span>
              <span className="git-file-name">{f.path.split(/[/\\]/).pop()}</span><span className="git-file-path-hint">{f.path}</span>
            </div>))}</div>
        }</div>}
      {!result && !loading && base && target && <div className="git-panel-placeholder"><GitCompare size={22} /><span>Click Compare</span></div>}
    </>
  );
}
