# Completed cmux session auto-close

- [complete] Inspect terminal ownership, native session binding and self-close guards.
- [complete] Add an explicit completion hook command and detached owned closer.
- [complete] Cover success, ownership, failed gates, duplicate calls and uncertainty offline.
- [complete] Update CLI/plugin documentation and bilingual changelogs; run checks.
- [complete] Commit task files and push main without version changes or publishing.

The hook closes only the verified calling surface. Completion must be explicitly
reported; a supplied Omha run must pass its configured gates. Persist claims
before detaching, revalidate ownership/session before closing, and never replay
an uncertain close. Preserve the existing dirty root planning files.

Verification issues: first event assertion observed a saved closed record before
the worker appended its final event; wait for that event. Concurrent auto-compact
work added a duplicate spawn import, since corrected by its author; isolate tests.

Final checks: auto-close 12/12; existing compact 19/19 after restoring shared
entry points; format/static validation and both plugin strict validations pass.
Isolated installed package passes with 86 files and eight discovered skills.
An earlier isolated full check passed 168/168. Later full retries hit system
pauses and Arena/Fork timeouts; four of six targeted retries passed, two retained
Git/process timeout failures. Do not claim those final full-suite retries passed.
Only auto-close index hunks are staged; compact work stays unstaged.

Delivered feature commit abfd6e4 directly to origin/main with an ordinary push.
The first SSH connection hung; a bounded keepalive retry succeeded. No version
bump, release tag, package publication or existing user terminal close occurred.
