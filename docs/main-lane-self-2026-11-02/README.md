# The main checkout's own lane (D372–D377), 2026-11-02

The working papers of the beta.3 fix for the owner's incident: a main-checkout
session restarted while a worktree session on the same store wrote a newer
chapter, and the restarted session oriented on the worktree's chapter as its
own thread. The charter text itself is in `features/` (commit e4a35f4); these
files record how it was reached.

- `main-self-rulings.md`: the owner's rulings R1–R14, with the owner's words
  verbatim. The settled input to everything below.
- `main-self-brief.md`: the first brief given to the drafter.
- `main-self-draft.md` → `main-self-draft-v4.md`: four drafts (Fable). v4 is
  the paste-ready text committed in e4a35f4, plus the binding notes (§6) and
  the build triage (§8).
- `main-self-review.md` → `main-self-review-v4.md`: the adversarial review of
  each draft (Opus, failure ladder).
- `build-common.md`: the rules every builder of the units followed.
- `u1-review.md`: the failure-ladder review of unit U1 (commit 8245420).

Paths inside these files that point at a session scratchpad refer to the
copies here.
- `d378-draft.md` → `d378-review.md` → `d378-draft-v2.md`: ruling R14 as D378,
  the pre-stamp door (Fable draft, Opus review, Opus-merged v2; committed
  b29820d).
- `u2-review.md`: the failure-ladder review of unit U2 (commit 197c3b9);
  its fixes are carried into U3.
