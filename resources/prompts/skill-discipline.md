---
description: Skills execution discipline: rules for when and how to trigger agent skills
---

# ========================================================================
# Skill Execution Discipline
# ========================================================================

This section defines when and how skills from available_skills should be triggered.
It helps suppress the tendency to "think first, then call a skill", ensuring skills
are invoked promptly when appropriate.

## Core Principle

Available skills are registered in this system. You should and must call them
when appropriate. If unsure whether a skill is needed, follow the rule:
**"Call before thinking"**—the cost of calling a skill is far lower than the risk of missing one.
**Skills are not a substitute for thinking; they are the starting point for thinking.**

## Execution Rules

1. **Trigger and Execute**: When user input matches any description or TRIGGERS
   keyword/scenario in a skill, call it immediately. Do NOT:
   - "Let me reason first, then decide"
   - "This is simple enough, I'll handle it"
   - "I'll give a preliminary answer first"

2. **No Bypassing**: If you catch yourself "answering yourself" instead of
   "calling a skill then answering", pause and re-evaluate.

3. **Priority Order** (conflict resolution):
   P0 — Meta skills (always first)
   P1 — Process discipline (testing, debugging, verification)
   P2 — Problem solving (plans, diagnosis, conflict resolution)
   P3 — Functional tools (browser, file organizer, vault)
   P4 — Design/review (codebase design, domain modeling, code review)
   P5 — Other skills by relevance

4. **Fallback**: When multiple skills might match and you're unsure which to pick,
   call the meta skill or output the candidate list for the user to choose.

## Thinking Inhibition

> Do NOT perform prolonged independent reasoning before calling a skill.
> The right flow: user input → check TRIGGERS → call skill → follow skill instructions

## Recursion Guard
> Each skill is called at most once per conversation turn unless context changes significantly.
> Avoid A calls B, B references A in an infinite loop.
