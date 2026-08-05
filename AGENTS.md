# AGENTS.md

## Language rules

- All code, comments, identifiers, commit messages, and documentation in this repository
  must be written in English (ASCII). Never write Chinese or other non-ASCII text in
  source files.
- Reason: non-ASCII characters combined with Windows PowerShell file writes (which may
  default to UTF-16 or ANSI) silently corrupt UTF-8 files and break the browser-facing
  frontend. ASCII-only content is immune to this class of bug.

## Encoding rules (Windows)

- When editing or rewriting files, use dedicated file tools (Write/Edit) or Node.js with
  explicit `utf8` encoding. Never write files via PowerShell `Set-Content`/`>` redirection,
  which can change encoding (UTF-16/ANSI) depending on the pipeline.
- Never use `git show ... > file` or `git cat-file ... > file` redirection on Windows; it
  can write UTF-16. Use `git show ref:path | node` piping or check out via `git checkout`.

## Verification

- After modifying frontend files (public/), verify UTF-8 validity before committing:
  `node -e "const b=require('fs').readFileSync('public/app.js');new TextDecoder('utf-8',{fatal:true}).decode(b)"`.
- Run `npm test` before committing; keep all tests passing.

## Engineering principles

- Do not preserve backward compatibility *internally*: remove obsolete internal paths
  instead of adding compatibility layers, fallbacks, or migrations. (The Codex/Responses
  wire protocol and the public HTTP API are contracts, not obsolete paths — keep them.)
- Choose the simplest implementation that fully meets the current requirements. Avoid
  speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and
  add each new capability on top of a product that already works. Never trade a working
  product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or
  improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation
  or adding packages. Do not assume a library lacks a capability without checking its
  documentation and types.
- Make architectural decisions for the long term, but recognize that in a moving
  ecosystem a working interim is often the correct step; replace it deliberately when the
  time is right and record the trade-off.
