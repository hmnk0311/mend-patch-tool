# mend-patch-tool

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hmnk0311/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hmnk0311/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in all
four formats they write them in: unified diffs (with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. It
implements the kit's SPEC.md sentence by sentence: format auto-detection,
three-tier line matching (exact, trailing-whitespace-insensitive, and
indent-insensitive with re-indentation of the replacement), nearest-hunk
placement for unified diffs, cursor-and-anchor chunk application for V4A,
CRLF preservation, `\ No newline at end of file` handling, safe-path checks,
per-edit failure reporting with all-or-nothing writes, and a change report
(`A`/`D`/`M`/`R` lines) in byte order. On the kit's 100 public practice
checks it scores 100/100.

## Run it

```sh
node main.ts [--format=unified|search-replace|v4a|json|auto] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file in the working directory (the tree's root); with no
argument, or `-`, the patch is read from standard input. Exit code 0 prints
the changed paths and `ok: <n> files`; exit 1 prints one
`error: <code> <path>` line per failed edit and writes nothing; exit 2
prints a single usage / no-patch / format / parse error line.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
