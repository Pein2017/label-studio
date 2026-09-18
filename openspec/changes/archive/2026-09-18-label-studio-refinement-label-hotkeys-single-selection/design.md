## Decision

Use one small pure helper in the existing refinement interaction utility for
usage sorting and the top-nine label-to-digit map.  The annotation hotkey
setup applies that map only when a label control targets the opted-in
refinement image; the Labels observer requests a rebind when the usage-count
signature changes.  Runtime `hotkey` fields remain view state and no result
serializer is changed.

At the existing ImageView hit-test boundary, keep the current smallest-bbox
candidate selector.  For a no-modifier click, clear the selection before
routing the candidate through the native region click handler.  For
Command/Ctrl, route the candidate through the native additive handler.  The
refinement rectangle view must not apply the generic recent-modifier fallback
when ImageView has marked the event for candidate routing; non-refinement
projects keep their existing path.

## Non-goals

- No new interaction toolbar, mode state, relation/group UI, or project API.
- No change to result/GT serialization, coordinates, labels, or annotation IDs.
- No full upstream merge or broad hotkey redesign.

## Verification

- Pure helper and Labels rendering tests cover ordering, ties, top-nine cutoff,
  and ordinary-project isolation.
- ImageView/rectangle tests cover nested single selection, additive modifier
  selection, and stale-modifier rejection.
- Run focused Jest suites, rebuild the production Label Studio bundle, and
  perform a browser/API smoke against the existing Project 3 service.
