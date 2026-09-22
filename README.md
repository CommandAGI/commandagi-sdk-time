# @commandagi/time — the time ALGEBRA

What a time IS, and the rules for comparing and converting them. Zero dependencies, and it must keep
none: anything it imports becomes a transitive dependency of every published SDK.

## Why it is its own package, at the very bottom

Same reason as `@commandagi/node-kinds`, and it is a real cycle rather than taste. `core/clock.ts` and
`core/interaction.ts` build on this algebra, so it cannot move UP into `@commandagi/document`. But
`document`'s temporal port vocabulary (`time/ports.ts` — the numbered-ports-are-never-temporal
invariant every domain is checked against) builds on it too, so it cannot stay in `core` without
`document` importing billing, capacity and the escrow ABIs to know what a timestamp is.

A leaf below BOTH is the only placement that satisfies both consumers:

```
@commandagi/time   @commandagi/node-kinds     ← zero dependencies
        ↑     ↖        ↑        ↗
     @commandagi/core   @commandagi/document
                              ↑
                         app-* (the SDKs)
```

`document` owns the temporal PORTS (reclock / align / hold / resample on the op-graph); this owns the
algebra underneath them. See `docs/platform/TIME.md`.
