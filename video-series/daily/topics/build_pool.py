#!/usr/bin/env python3
"""PiDeck AI 日更 · 选题池生成器。

从仓库的真实素材里挖候选选题，按内容配比（技巧/更新/日志）分流打分：
  - CHANGELOG.zh-CN.md  → 更新播报（update）
  - announcements-md/*.md → 更新播报（update）
  - docs/maintenance-domains.md 的「小节」 → 技巧教程（tip） / 开发日志（devlog）
  - git log 近 N 天的提交 → 开发日志（devlog）
  - gh issue（可选） → 技巧教程（tip）

用法：
  python build_pool.py --days 14
  python build_pool.py --days 30 --out daily/publish/pool.md --json daily/publish/pool.json
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

DAILY = Path(__file__).resolve().parent.parent
REPO = DAILY.parent.parent
CHANGELOG = REPO / "CHANGELOG.zh-CN.md"
ANNOUNCE_DIR = REPO / "announcements-md"
DOMAINS = REPO / "docs" / "maintenance-domains.md"


@dataclass
class Candidate:
    kind: str
    title: str
    source: str
    detail: str = ""
    score: float = 0.0
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def run(cmd: list[str], cwd: Path | None = None) -> str:
    r = subprocess.run(cmd, cwd=str(cwd or REPO), capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        return ""
    return r.stdout


def from_changelog(limit: int = 12) -> list[Candidate]:
    """CHANGELOG 的 `- **标题** — 说明` 行，天然就是「一条视频讲一件事」的素材。"""
    out: list[Candidate] = []
    if not CHANGELOG.exists():
        return out
    version = ""
    section = ""
    for line in CHANGELOG.read_text(encoding="utf-8").splitlines():
        v = re.match(r"^##\s+v?([\d.]+)", line)
        if v:
            version = v.group(1)
            continue
        s = re.match(r"^###\s+(.+)$", line)
        if s:
            section = s.group(1).strip()
            continue
        b = re.match(r"^-\s+\*\*(.+?)\*\*\s*[—–-]?\s*(.*)$", line)
        if not b:
            continue
        title = b.group(1).strip()
        detail = b.group(2).strip()
        # 选「新功能 / 修复 / 优化」类小节，跳过纯文档与杂项
        if not re.search(r"新功能|功能|改进|优化|修复|体验|性能", section):
            continue
        out.append(
            Candidate(
                kind="update",
                title=title,
                source=f"CHANGELOG v{version} / {section}",
                detail=detail[:180],
                score=60 + (5 if version else 0),
                tags=[version] if version else [],
            )
        )
        if len(out) >= limit:
            break
    return out


def from_announcements(limit: int = 6) -> list[Candidate]:
    out: list[Candidate] = []
    if not ANNOUNCE_DIR.exists():
        return out
    files = sorted(ANNOUNCE_DIR.glob("*.md"), reverse=True)[:limit]
    for f in files:
        text = f.read_text(encoding="utf-8", errors="replace")
        title = ""
        m = re.search(r"^title:\s*(.+)$", text, re.M)
        if m:
            title = m.group(1).strip().strip("\"'")
        if not title:
            m = re.search(r"^#\s+(.+)$", text, re.M)
            title = m.group(1).strip() if m else f.stem
        body = re.sub(r"^---.*?---", "", text, flags=re.S).strip()
        first = next((ln.strip() for ln in body.splitlines() if ln.strip() and not ln.startswith("#")), "")
        out.append(
            Candidate(
                kind="update",
                title=title,
                source=f"announcements-md/{f.name}",
                detail=first[:180],
                score=55,
                tags=[f.stem[:10]],
            )
        )
    return out


def from_domains(limit: int = 20) -> list[Candidate]:
    """维护域文档的每个小节都是踩过的坑——技巧教程和开发日志的富矿。"""
    out: list[Candidate] = []
    if not DOMAINS.exists():
        return out
    text = DOMAINS.read_text(encoding="utf-8", errors="replace")
    blocks = re.split(r"\n(?=## )", text)
    for b in blocks:
        m = re.match(r"^##\s+(.+)$", b)
        if not m:
            continue
        title = m.group(1).strip()
        body = "\n".join(b.splitlines()[1:]).strip()
        # 「坑」的性质：坑/事故/回归 → devlog；其余 → tip
        devlog = bool(re.search(r"坑|事故|回归|闪退|丢|失败|卡住|误|不可用|不生效|被删|假绿|静默", title + body[:400]))
        # 抽出正文里最像「一句话结论」的句子
        concl = ""
        for ln in body.splitlines():
            ln = ln.strip()
            if ln.startswith("**") and "：" in ln:
                concl = ln.replace("**", "")[:180]
                break
        if not concl:
            concl = next((ln.strip() for ln in body.splitlines() if len(ln.strip()) > 20), "")[:180]
        out.append(
            Candidate(
                kind="devlog" if devlog else "tip",
                title=title,
                source="docs/maintenance-domains.md",
                detail=concl,
                score=50 + (10 if devlog else 0),
            )
        )
        if len(out) >= limit:
            break
    return out


def from_git(days: int, limit: int = 15) -> list[Candidate]:
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    log = run(["git", "log", f"--since={since}", "--pretty=format:%s", "--no-merges"])
    out: list[Candidate] = []
    for line in log.splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(r"^(feat|fix|perf|refactor|style|docs|test|build|chore)(?:\(([^)]+)\))?(!)?:\s*(.+)$", line)
        if not m:
            continue
        typ = m.group(1)
        scope = m.group(2) or ""
        msg = m.group(4).strip()
        if typ not in {"feat", "fix", "perf", "refactor"}:
            continue
        out.append(
            Candidate(
                kind="devlog",
                title=msg,
                source=f"git log ({typ}{('/' + scope) if scope else ''})",
                detail="",
                score=45,
                tags=[typ, scope] if scope else [typ],
            )
        )
        if len(out) >= limit:
            break
    return out


def from_issues(limit: int = 8) -> list[Candidate]:
    """gh issue 是真实用户痛点，技巧教程的选题质量最高。可选：gh 未登录则跳过。"""
    raw = run(["gh", "issue", "list", "--limit", str(limit), "--state", "open", "--json", "number,title,labels"])
    if not raw:
        return []
    out: list[Candidate] = []
    try:
        issues = json.loads(raw)
    except json.JSONDecodeError:
        return []
    for it in issues:
        labels = [l.get("name", "") for l in (it.get("labels") or [])]
        out.append(
            Candidate(
                kind="tip",
                title=it.get("title", ""),
                source=f"gh issue #{it.get('number')}",
                detail="、".join(labels),
                score=70,  # 用户真实痛点优先
                tags=labels,
            )
        )
    return out


def dedupe(cands: list[Candidate]) -> list[Candidate]:
    seen: set[str] = set()
    out: list[Candidate] = []
    for c in cands:
        key = re.sub(r"\s+", "", c.title)[:24]
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="PiDeck AI 日更 · 选题池")
    parser.add_argument("--days", type=int, default=14, help="git log 回溯天数")
    parser.add_argument("--out", default="", help="输出 markdown（默认 daily/publish/pool.md）")
    parser.add_argument("--json", dest="json_out", default="", help="输出 json（默认 daily/publish/pool.json）")
    parser.add_argument("--per-kind", type=int, default=8, help="每类最多几条")
    parser.add_argument("--no-issues", action="store_true", help="跳过 gh issue 抓取")
    args = parser.parse_args()

    cands: list[Candidate] = []
    if not args.no_issues:
        cands += from_issues()
    cands += from_changelog()
    cands += from_announcements()
    cands += from_domains()
    cands += from_git(args.days)
    cands = dedupe(cands)

    buckets: dict[str, list[Candidate]] = {"tip": [], "update": [], "devlog": []}
    for c in sorted(cands, key=lambda x: -x.score):
        if len(buckets[c.kind]) < args.per_kind:
            buckets[c.kind].append(c)

    md = [f"# PiDeck AI 日更 · 选题池（{datetime.now():%Y-%m-%d}）", ""]
    labels = {"tip": "技巧教程", "update": "更新播报", "devlog": "开发日志"}
    for kind, items in buckets.items():
        md.append(f"## {labels[kind]}（{len(items)}）")
        md.append("")
        for c in items:
            md.append(f"- **{c.title}**")
            md.append(f"  - 来源：{c.source}" + (f"｜{c.detail}" if c.detail else ""))
        md.append("")

    out_md = Path(args.out) if args.out else DAILY / "publish" / "pool.md"
    out_json = Path(args.json_out) if args.json_out else DAILY / "publish" / "pool.json"
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text("\n".join(md), encoding="utf-8")
    out_json.write_text(
        json.dumps({k: [c.to_dict() for c in v] for k, v in buckets.items()}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("\n".join(md))
    print(f"✅ {out_md}  /  {out_json}")


if __name__ == "__main__":
    main()
