# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/MARUGAMIII/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/MARUGAMIII/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and `mend` reads them all: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and it changes every file or none at all.

## Run it

```sh
node main.ts [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

## Formats

- **Unified diff** — `diff --git`, `---`/`+++` headers, `@@` hunks. Line numbers are only
  a hint: each hunk takes the occurrence of its old lines nearest to the number it was
  given, so a diff whose numbers drifted still lands. Creations, deletions and renames
  (`new file mode`, `deleted file mode`, `rename from`/`rename to`) are honoured, as is
  `\ No newline at end of file`.
- **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, old lines, `=======`, new
  lines, `>>>>>>> REPLACE`. A block whose old lines occur more than once is ambiguous and
  fails; an empty old block creates the file.
- **V4A** — `*** Begin Patch` … `*** End Patch`, with `*** Add File:`, `*** Delete File:`
  and `*** Update File:` sections. Update chunks take an `@@` anchor, move a cursor
  forward as they apply, and may end at `*** End of File` or move the file with
  `*** Move to:`.
- **JSON** — one JSON array of edit objects, or JSON Lines with one edit object per line:
  `create` (writes `file_text` byte for byte), `str_replace` (exact, exactly once) and
  `insert` (after a line number).

With `--format=auto` (the default) the format is detected from the patch text; `--format`
with a name reads the patch in that format whatever it holds.

## Matching

An edit's old lines are found at the first of three tiers at which they occur at least
once: exact, then ignoring trailing spaces and tabs, then ignoring leading and trailing
spaces and tabs. `--strict` tries the exact tier only. At the loosest tier, new lines are
re-indented to the file's indentation; context lines are always written as the file's own
matched lines, never the patch's.

## Behaviour

- The working directory is the root of the tree; every path in a patch is relative to it.
  A path is rejected as `unsafe` when it is empty, absolute, holds a backslash, or holds
  an empty, `.` or `..` segment.
- Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for a move)
  in byte order, then `ok: <n> files`. A patch that changes nothing prints `ok: 0 files`.
- Exit 1 prints one `error: <code> <path>` line per failed edit, in the patch's order,
  then `failed: <k> of <n> edits` — and no file is written at all. The codes are
  `no-match`, `ambiguous`, `missing`, `exists` and `unsafe`.
- Exit 2 prints exactly one line and writes nothing: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>` for a patch that cannot be read in its format.
- `--check` does everything but write: the same output and exit code, no file created,
  changed or deleted.
- CRLF files keep CRLF line breaks; a file without a final line break keeps none, unless
  a hunk that runs to its end says otherwise. Files an edit creates use LF breaks.
- Edits apply in the patch's order to the tree as earlier edits left it, so a later edit
  sees a file an earlier one created, changed, moved or deleted.

## Files

- `main.ts` — the whole tool. Node 22 and its standard library alone; no dependencies,
  no install step.
- `runner.ts` — the kit's trial runner, kept as it is. When `MAKEFUN_ENV_URL` is set,
  `main.ts` hands the trial over to it.
- `check.ts` — runs `main.ts` on the kit's public practice set:

      node check.ts <practice.json>

- `SPEC.md` — the specification this tool implements.

## Licence

MIT — see `LICENSE`.
