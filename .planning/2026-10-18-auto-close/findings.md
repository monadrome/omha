# Findings

- Native cmux adoption already binds cwd, OS user, full workspace/surface UUIDs,
  surface-specific owner token and Claude/Codex session identity.
- Existing native close refuses active self-retirement, because killing the
  caller can prevent durable outcome recording. Reuse a detached closer after
  explicit completion instead of weakening the cancellation/takeover guard.
- cmux close-surface supports --force for intentionally ending a live process.
  Retain the existing verification and target only the completed surface.
- The CLI itself can be the completion hook. Do not install unconditional Stop
  hooks: an ordinary turn ending does not establish that a goal is complete.
