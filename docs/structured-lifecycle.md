# Structured lifecycle

Omha exposes a small lifecycle kernel for work that crosses provider execution,
acceptance, review and cleanup boundaries. `ExecutionScope` carries one
monotonic deadline and a first-wins cancellation reason. Child scopes inherit
the tighter parent deadline and observe parent cancellation. Closing a scope
rejects new children while leaving already-created work alive; cancellation is
explicit.

`TaskHandle` records the host-visible lifecycle independently from the provider
or terminal implementation. A handle moves through `prepared`, `admitted`,
`queued`, `running`, `cancel_requested`, `exited` or `skipped`, then settles
once with an immutable outcome. A completion is not published before the body
has exited or has been proven to have been skipped. The first cancellation
reason remains attached to that completion.

The kernel is deliberately separate from provider correctness. A settled
`success` outcome says that the execution adapter completed; host acceptance
and independent review remain separate gates. Later integrations use the same
scope and handle for provider, acceptance, review and bounded cleanup so a
child cannot silently receive a fresh deadline or outlive its owner.
