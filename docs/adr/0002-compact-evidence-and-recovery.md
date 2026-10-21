# ADR 0002: Compact Evidence And Recovery

Status: Accepted

Decision: Default to 57 minutes and a 20% context floor. New accepted input
invalidates old schedules immediately; actual cache evidence re-arms them.
Persist a one-use invocation intent and budget against the stable native session.

Rationale:

- Cache expiry follows real requests, so input time and response completion cannot substitute for it.
- Persistent business revisions and uncertain intents prevent consecutive or crash-replayed compact requests.

Rejected: Cold catch-up, automatic replay of unknown execution, zero-reservation
fallback, and resetting maintenance counts on resume, reload or conversation clear.

Context: [Protocol and verification](../auto-compact.md), [review](../auto-compact-review.md).
