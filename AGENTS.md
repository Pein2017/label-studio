# Label Studio Repository Guide

## Scope

This guide applies to this repository and its descendants. Keep it general:
task-specific decisions, dataset manifests, and experiment notes belong in
the relevant project documentation or task brief.

This repository is a maintained fork of Label Studio with its own Git history.
Treat upstream changes as inputs to review, not as a reason to overwrite local
work.

## Working principles

- Inspect the current code, configuration, Git status, and runtime before
  editing.
- Make the smallest coherent change that satisfies the request. Reuse existing
  Label Studio patterns and installed dependencies before adding abstractions.
- Preserve unrelated local changes. Do not use `git reset --hard`, broad
  cleanup, or force-pushes unless the user explicitly requests them.
- Keep user data, annotations, credentials, and local runtime state private.
- Do not commit secrets, local databases, caches, build output, screenshots, or
  generated exports unless they are explicitly part of the requested artifact.

## Label Studio changes

- Prefer an adapter, integration, or documented configuration change when it
  solves the problem; change core Label Studio code only when the behavior
  genuinely belongs in the platform.
- Keep frontend, backend, API, and persistence changes compatible with the
  existing application contracts.
- Keep local paths and credentials in environment/configuration rather than in
  source code.
- Document user-visible behavior and operational prerequisites close to the
  affected feature.

## Annotation and data safety

- Treat source images and raw annotations as immutable inputs unless the task
  explicitly authorizes an update.
- Preserve image dimensions, coordinate conventions, stable region/object IDs,
  and source provenance across import, editing, and export.
- Make coordinate conversions explicit and reversible; validate bounds and
  round-trip behavior before promoting edited data.
- Keep predictions or reference overlays distinguishable from editable
  annotations. Never silently turn a review result into training truth.
- Prefer a manifest or report for imports/exports so task counts, hashes,
  versions, and reviewer decisions can be reproduced.

## Validation

- Run the narrowest relevant checks after each behavioral change: targeted unit
  tests for backend/frontend logic, lint or type checks for changed files, and
  a focused browser or API smoke test for integration behavior.
- For annotation or export changes, validate schema, image resolution,
  coordinates, IDs, provenance, and representative samples.
- For runtime or build changes, verify the real entry point and the artifact
  actually served or consumed by the application.
- Report the commands run and any pre-existing failures separately from new
  failures.

## Git workflow

- `main` is the canonical branch. Do not create long-lived branches unless the
  user asks for them.
- Review `git status`, remotes, and the exact diff before staging.
- Commit related changes in clear, focused commits; keep local-only files
  untracked or ignored.
- Push only after the requested scope and validation are clear. Preserve the
  upstream fork relationship and use the official upstream remote for fetching
  rather than copying history into a second repository.

## Communication

- State assumptions when a request is ambiguous and ask before making a
  material data, visibility, ownership, or compatibility decision.
- Separate observed facts, inferred behavior, and unverified hypotheses.
- Stop when the requested behavior is implemented and proportionate checks
  pass; record follow-up ideas instead of expanding scope automatically.
