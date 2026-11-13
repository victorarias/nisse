# @sigma/delta

JSON ops and delta tracking: `src/delta/` and `src/json.ts`, copied from chord
(`packages/chord/src/delta`, `src/json.ts`) in earendil-works/pi at commit
`7d073328e`, under the MIT license in `LICENSE`. `diff.ts` is left out; sigma does
not use `diffRevisions`.

The tests are chord's for these files, moved to `bun:test`. Chord's tests that
measure V8 heap and GC, and the ones built on `diffRevisions`, are left out.
Its source imports no package.
