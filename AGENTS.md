# Omha Agent Instructions

## Naming

The project is **Omha** (`omha`). Use it consistently across every surface:

| Surface               | Value                                              |
| --------------------- | -------------------------------------------------- |
| CLI binary            | `omha` (`bin/omha.mjs`)                            |
| npm package           | `@huatalk/omha`                                    |
| GitHub repository     | `monadrome/omha`                                   |
| Plugin / marketplace  | `omha` / `omha@omha`                               |
| Environment variables | `OMHA_HOME`, `OMHA_NPM_PREFIX`, `OMHA_PROMPT_FILE` |
| Project configuration | `.omha/providers.json`                             |
| State directory       | `$XDG_STATE_HOME/omha`, `$HOME/.local/state/omha`  |
| Worker final marker   | `OMHA_FINAL:`                                      |
| Terminal ownership    | `@omha-owner` (tmux), `omha-owner` (cmux)          |
| Skill namespace       | `omha:*`                                           |

- **Keep exactly one active implementation.** Do not add aliases, renamed-symbol
  shims, legacy configuration fallbacks, or migration paths for earlier names.
- The worker completion marker is defined once as `FINAL_MARKER` in
  `lib/core.mjs`. Always derive offsets from `FINAL_MARKER.length`; never
  hardcode the prefix length.

## Git Delivery

- This project must automatically commit and push completed changes.
- Run the checks appropriate to the changes, commit the task's files, and push
  the current working branch to its upstream. If no upstream exists, use
  `git push --set-upstream origin <current-branch>`.
- This is standing user authorization for commit and push; do not ask for
  confirmation again. Explicit instructions in the current task take precedence.
- Preserve unrelated changes and use ordinary pushes without force.
- Version bumps, release tags, package publishing and merges require their own
  task authorization. Read `docs/releasing.md` when performing a release.
