## Wave 1 — Runtime label hotkeys

- [x] 1.1 Add the shared refinement usage-order/top-nine hotkey helper and use
  it for both label presentation and runtime binding.
- [x] 1.2 Rebind refinement label digits after current-image usage counts
  change; keep ordinary projects and serialization unchanged.
- [x] 1.3 Add focused helper/render tests for frequency order, ties, cutoff,
  and non-refinement behavior.

## Wave 2 — Single-candidate canvas selection

- [x] 2.1 Remove refinement's stale Command/Ctrl fallback and make the
  existing ImageView candidate route authoritative for no-modifier clicks.
- [x] 2.2 Preserve explicit Command/Ctrl additive selection and add focused
  nested-box regression tests.

## Wave 3 — Acceptance

- [x] 3.1 Run focused editor tests and `git diff --check`.
- [x] 3.2 Rebuild the served production bundle and run a browser/API smoke
  without modifying the user's source annotations.
- [x] 3.3 Validate this OpenSpec change and record the final task status.
