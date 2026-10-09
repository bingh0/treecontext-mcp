Feature: Session-keyed namespace attribution — the echo teaches the store who serves whom

  The pid bridge cannot exec on every platform, so hooks cannot always
  learn their session's serving namespace from process ancestry. The
  drain publishes a session-keyed namespace annotation from exact echo
  evidence — a status echo's own output names the serving namespace, a
  healed insert names the healed row's tree — and hooks resolve by the
  session id their payload already carries. A beacon guess never
  publishes; a missing annotation degrades to today's routing.

  @D90
  Scenario: a status echo teaches the store which namespace a session's server serves
    Given a session whose orientation status call left an echo in staging
    When the drain processes the echo
    Then the store carries a session-keyed namespace annotation naming the serving namespace
    And a later hook fire from that session stamps that namespace with no ancestry lookup

  @D90
  Scenario: a healed insert corroborates the session's namespace
    Given a session with no status echo whose curated insert left an echo in staging
    When the drain processes the echo
    Then the session's namespace annotation names the healed row's namespace

  @D90
  Scenario: a beacon guess never publishes a namespace annotation
    Given a server that resolved its session id only by beacon unanimity
    When its session produces no echoes
    Then no session-keyed namespace annotation exists for that session
    And hook fires resolve through the pid rung or not at all

  @D90
  Scenario: capture rows staged before the first echo keep today's routing
    Given a session that has produced hook events but no treecontext echoes
    When the drain processes those events
    Then the rows drain into the serving namespace as before
    And no namespace is invented

  # The RATIFIED design (docs/session-identity.md §7.8), re-affirmed by
  # owner ruling 2026-08-20 after the C#2 dispute: the session rung is
  # causal and a session id is never recycled, while the pid file is
  # STRUCTURALLY SHARED — every server one claude pid spawns writes the
  # same pid-<claudePid>.ns.json, so pid-first would answer with
  # whichever server started last, even against the session's own proof
  # (the multi-lane shape this feature exists for). C#2's counter-case —
  # a mid-session relaunch under a different --namespace leaves the
  # session file naming the previous run until the next echo drains — is
  # accepted as a disclosed, self-healing residual.
  @D95
  Scenario: the session rung outranks the pid rung when both resolve
    Given a session-keyed annotation and a live ppid-keyed annotation that disagree
    When a hook from that session resolves its namespace
    Then the session-keyed namespace wins

  # Whichever rung leads, a pid annotation must be proven by its
  # server's live namespace-lease heartbeat, not by pid-existence
  # (owner ruling 2026-08-16). A SIGKILLed server's annotation survives,
  # and once the OS recycles its pid, `process.kill(pid, 0)` answers yes
  # for a stranger. No session annotation exists here: the pid rung is
  # isolated, so this scenario cannot pass through the rung above it.
  @D94
  Scenario: an annotation whose server stopped heartbeating is not honored
    Given a ppid-keyed annotation whose server no longer holds the namespace
    When a hook from that session resolves its namespace
    Then no namespace resolves

  @D95
  Scenario: neither rung resolves rather than borrowing another session's answer
    Given a session-keyed annotation belonging to a different session
    When a hook from this session resolves its namespace
    Then no namespace resolves
