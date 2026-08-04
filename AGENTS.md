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
