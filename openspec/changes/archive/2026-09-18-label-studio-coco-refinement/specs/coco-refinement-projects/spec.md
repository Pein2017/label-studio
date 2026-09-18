## ADDED Requirements

### Requirement: Exact selected source
The system SHALL bootstrap refinement projects only from
`public_data/coco/rescale_32_1024_bbox_len12000/train.norm.jsonl` and
`public_data/coco/rescale_32_1024_bbox_len12000/val.norm.jsonl`, and SHALL reject
source path, source hash, row identity, or schema drift.

#### Scenario: Bootstrap from accepted train source
- **WHEN** the operator bootstraps the train refinement project from the exact recorded source and hashes
- **THEN** the system creates one task for every source row and records the source contract in the project manifest

#### Scenario: Bootstrap from an adjacent COCO view
- **WHEN** the operator supplies a bare, coord-token, shorter-length, or otherwise different COCO JSONL
- **THEN** the system rejects it without creating or mutating a refinement project

### Requirement: Immutable sources and shared images
The system SHALL never mutate the selected source JSONL or source images and
SHALL reference images from
`public_data/coco/rescale_32_1024_bbox/images/` without copying image bytes into
project state. Working rows SHALL rebase their relative `images[0]` locator
through a validated managed link while preserving image identity, `file_name`,
dimensions, and source metadata.

#### Scenario: Project initialization
- **WHEN** either split is initialized
- **THEN** project tasks and working rows resolve to the same allowlisted existing image bytes and the recorded source hashes remain unchanged

#### Scenario: Working JSONL moves away from the source directory
- **WHEN** the derived split is initialized under the runtime root
- **THEN** its rebased locator resolves through the managed link instead of reusing the now-invalid source-relative string

#### Scenario: Escaping the image root
- **WHEN** a task or request resolves outside the exact image root
- **THEN** the system rejects the path and exposes no file

### Requirement: Independent split projects
The system SHALL maintain one Label Studio instance with separate train and
validation projects, project-bound local-file storage records, working files,
journals, locks, generations, and task namespaces, with stable task identity
based on split and `image_id`.

#### Scenario: Same numeric image identity is addressed
- **WHEN** a task is read or committed
- **THEN** its split is part of the identity and no row in the other project can be changed

#### Scenario: Cross-split move requested
- **WHEN** a user attempts to move or commit a task into the other split
- **THEN** the system rejects the operation

### Requirement: Idempotent project bootstrap
The system SHALL record source, source/working image locators, storage identity,
adapter, category-registry, label-config, vendor, authoritative-annotation, and
task-manifest fingerprints and SHALL make bootstrap idempotent for an exact
matching project.

#### Scenario: Matching bootstrap is repeated
- **WHEN** bootstrap is run again with the same complete manifest
- **THEN** the system reuses the project without duplicating tasks or resetting Draft or committed state

#### Scenario: Existing project fingerprint differs
- **WHEN** bootstrap finds an image/storage, annotation, category, config, source, adapter, or vendor fingerprint mismatch
- **THEN** it fails closed and reports the mismatched field

### Requirement: One authoritative editable annotation per task
Bootstrap SHALL seed every source object into exactly one ordinary editable
annotation per task with stable hidden region identity and SHALL disable
alternate annotation creation/deletion, native submit/skip, and prediction-based
source state for these projects.

#### Scenario: Source task is opened
- **WHEN** a bootstrapped task is loaded
- **THEN** the selected authoritative annotation contains exactly the source objects with editable percentage rectangles and preserved hidden positive IDs

#### Scenario: Another annotation is requested
- **WHEN** the reviewer attempts to create, select, delete, submit, or skip an alternate annotation entity
- **THEN** the project blocks that path while leaving bbox region CRUD available

### Requirement: Dedicated derived runtime state
The system SHALL store mutable project state under a dedicated ignored output
root with one Label Studio state subtree, separate split data subtrees, validated
managed image links, a hash-attested immutable task/source-row index, a durable
batch queue/journal, and an ordinary `working.norm.jsonl` per split without
symlinking it over the source.

#### Scenario: Fresh split is initialized
- **WHEN** bootstrap succeeds for a split
- **THEN** its working JSONL has the same row identities and accepted row schema as the source while remaining a distinct mutable file

### Requirement: Draft and batch Commit have distinct authority
The system SHALL treat Label Studio saves as mutable Draft state only and SHALL
treat a terminal-success same-split batch Commit as the only operation that
replaces captured samples' `objects` in `working.norm.jsonl`. The reviewer MAY
accumulate durable Drafts across several tasks. One explicit Commit SHALL force
save of the active task, capture each eligible authoritative Draft's full
canonical payload/revision/hash into an immutable batch, durably enqueue it,
and return a queue receipt without waiting for whole-file replacement.

#### Scenario: Draft is saved
- **WHEN** the reviewer edits a task and invokes ordinary Draft save
- **THEN** Label Studio retains the edit but the working JSONL generation and row remain unchanged

#### Scenario: Reviewer navigates across edited tasks
- **WHEN** the active task's Draft save succeeds
- **THEN** navigation continues without waiting for any working-JSONL Commit and the project pending-Draft count includes that semantic change

#### Scenario: Batch enqueue succeeds
- **WHEN** the active Draft is durably saved and every eligible same-split Draft snapshot is captured and the queue record is fsynced
- **THEN** the browser receives `Queued` with one batch ID while `working.norm.jsonl` remains at its prior terminal generation and annotation/navigation stay available

#### Scenario: Background batch succeeds
- **WHEN** the immutable queued snapshots pass validation and the worker publishes one terminal-success generation
- **THEN** all captured rows become current together at the atomic working-file publication point and the repaired terminal projection reports that same outcome

#### Scenario: Captured task is edited after enqueue
- **WHEN** a later Label Studio Draft revision differs from the queued semantic hash
- **THEN** the worker still uses the immutable queued payload, terminal handling preserves the newer Draft and its undo history, and the task remains Draft ahead of the committed batch

#### Scenario: Draft save fails before Commit
- **WHEN** the authoritative Draft snapshot cannot be durably saved
- **THEN** the parent transaction does not begin, the task remains dirty, and navigation stays on the task

#### Scenario: Enqueue fails before durable queue receipt
- **WHEN** Draft capture, validation, or queue fsync fails
- **THEN** no active batch is reported, every Draft remains intact, and the previous working generation remains authoritative

#### Scenario: Enqueue or terminal response is lost
- **WHEN** the client cannot prove whether a batch was durably queued or terminally published
- **THEN** it queries the idempotent batch ID and never claims dataset success from enqueue acceptance alone

### Requirement: Validated working norm rows
Every committed row SHALL preserve immutable semantic row/image fields and its
validated rebased image locator, SHALL contain a non-empty object list, and each
object SHALL have strict norm1000 integer `xyxy`, canonical
`desc`/`category_name`, official sparse `category_id`, and a unique
`coco_ann_id`. The system SHALL describe this as the editing artifact, not as a
file directly accepted by the current coord-token loader.

#### Scenario: Valid edited row is committed
- **WHEN** all objects satisfy the current row and object contracts
- **THEN** the system writes a valid working norm row without changing immutable image identity or dimensions

#### Scenario: All objects are deleted
- **WHEN** the active Draft has an empty object list and the reviewer invokes Commit
- **THEN** the system rejects Commit, retains the empty Draft, and explains that the current training contract requires at least one object

#### Scenario: Invalid geometry or class is submitted
- **WHEN** any captured object is degenerate, outside the `0..999` lattice after clipping, unknown to COCO-80, or inconsistent in name and ID
- **THEN** the system rejects the entire batch without partially changing any working row

### Requirement: Explicit current-coord materialization
The system SHALL provide an operator-invoked atomic materializer that converts
every committed norm integer into the exact current `<|coord_N|>` string while
preserving row/object identity, classes, ordering, and working image locators,
and SHALL validate the result through the actual Swift loader. The supported
materializer SHALL bind the exact split-matched `WorkingDatasetStore` and hold
its reconciled committed-generation guard for the entire read and replacement;
an arbitrary lock callable or private recovery lock SHALL NOT establish a
committed generation.

#### Scenario: Valid working split is materialized
- **WHEN** the operator requests a coord export from a valid committed generation
- **THEN** a complete `working.coord.jsonl` is atomically written and accepted by the current loader without changing `working.norm.jsonl`

#### Scenario: Working split is empty or invalid
- **WHEN** any row violates the approved non-empty, geometry, class, ID, or image contract
- **THEN** materialization fails without replacing a prior valid coord output or promoting a training config

#### Scenario: Dataset publication is unresolved
- **WHEN** a legacy or batch transaction has published bytes or a manifest but its authoritative terminal projections are not reconciled
- **THEN** the committed-generation guard rejects materialization before source resolution or coord-output replacement, and export may proceed only after recovery

### Requirement: Stable hidden object identity
The system SHALL preserve the `coco_ann_id` of an existing object across
geometry/class edits and SHALL allocate a stable, unique, split-local negative
integer ID for each newly batch-committed human or inference object without
exposing ID editing in the UI. Allocation SHALL be deterministic across the
batch's source-row order, SHALL be durably tied to batch/member identity before
candidate creation through an explicit reservation record, and SHALL never
overwrite newer Draft semantics when
the returned mapping is merged by stable region key. The authoritative
journal/index and Draft metadata SHALL map stable region keys to IDs
idempotently across response loss and reload. A reservation SHALL remain bound
to the same `(split, stable_region_key)` after failure or recovery, SHALL be
reused by a corrected later batch for that key, and SHALL never be reassigned to
another key; reserving an ID alone SHALL NOT make the region committed.

#### Scenario: Existing box is moved and relabeled
- **WHEN** a source object is edited and committed
- **THEN** its original positive `coco_ann_id` remains attached to the updated object

#### Scenario: New box is batch committed
- **WHEN** a region with no committed identity is first included in a terminal-success batch
- **THEN** the system assigns an unused negative ID and retains it across later edits

#### Scenario: Deleted identity is followed by another addition
- **WHEN** a committed object is deleted and a later object is added
- **THEN** the deleted ID is not reused

#### Scenario: Commit response is lost after allocating a new ID
- **WHEN** the task reloads and recommits the same stable region key
- **THEN** reconciliation restores the originally allocated negative ID and never allocates a second one

#### Scenario: Batch fails after reserving a new ID
- **WHEN** an ID reservation is durable but candidate publication fails and a corrected batch later contains the same stable region key
- **THEN** the corrected batch reuses that reservation, while a different region receives a different ID

### Requirement: Deterministic object materialization
The system SHALL materialize committed objects with `desc` equal to canonical
`category_name`, official category mapping, accepted fields only, and the
existing deterministic top-left geometric ordering.

#### Scenario: UI order differs from geometry order
- **WHEN** the reviewer commits boxes selected or created in arbitrary order
- **THEN** the row is written in stable top-left order while prior committed rank resolves equal-top-left ties and creation ordinal resolves new ties

### Requirement: Durable asynchronous same-split batch queue
The system SHALL permit at most one active dataset batch per split while
allowing train and validation workers to progress independently. A batch SHALL
contain a deterministic source-row-ordered set of unique task snapshots from
exactly one split plus `batch_id`, complete payload hash, capture identities,
server-owned zero-based source-row indexes, per-row base hashes, and base
generation. Every index SHALL be verified against the bootstrapped task
manifest's `(split, image_id, source_line)` identity and included in the payload
hash. The immutable payload SHALL be
durable before enqueue returns, and later Draft changes SHALL not alter it.

#### Scenario: Several Drafts are committed once
- **WHEN** the reviewer invokes Commit with several eligible durable Drafts
- **THEN** one immutable same-split batch is queued and no member can be independently acknowledged or applied

#### Scenario: Another Commit is requested while a batch is active
- **WHEN** the split already has a queued, running, or reconciling batch
- **THEN** annotation and Draft saves remain available but another dataset batch is not enqueued and the existing active-batch identity is returned

#### Scenario: Same batch is retried
- **WHEN** `batch_id` and the complete batch payload hash match an existing queue or terminal receipt
- **THEN** the system returns that existing receipt without duplicating work, generation, or negative-ID allocation

#### Scenario: Batch ID is reused with another payload
- **WHEN** the same `batch_id` carries different members, order, snapshots, metadata, or hashes
- **THEN** the system rejects it as an immutable identity conflict

### Requirement: Atomic batch replacement
The system SHALL serialize each split's background worker and SHALL publish all
members of one validated batch in exactly one complete working-JSONL generation
or publish none. Durable queue acceptance is not Commit success. The atomic
replacement of the complete `working.norm.jsonl`, followed by directory fsync
while the shared transaction/recovery barrier is held, SHALL be the single
dataset publication authority. The manifest and terminal log records SHALL be
verified projections, and supported readers/status/admission SHALL either use
that barrier or fail closed until recovery reconciles them.

#### Scenario: One captured row is invalid or stale
- **WHEN** any member fails canonical validation or its captured base-row hash differs from current working authority
- **THEN** the entire batch terminates failed before replacement and no captured row is applied

#### Scenario: Unrelated project generation advanced before capture
- **WHEN** another task changed the project generation but every captured row base hash still matches at durable enqueue
- **THEN** the batch may be captured from current authority; execution freshness is per-row and does not reject an unrelated Draft only because its observed global generation is older

#### Scenario: Process stops after durable enqueue
- **WHEN** the queue receipt exists but no transaction candidate is authoritative
- **THEN** startup reconstructs the same active batch and resumes it before admitting another batch for that split

#### Scenario: Process stops before atomic replacement
- **WHEN** a batch transaction record exists but the previous working file is still authoritative
- **THEN** startup rolls back or resumes exactly one deterministic batch generation without partially applying members

#### Scenario: Process stops after replacement
- **WHEN** the candidate working file matches the prepared candidate attestation but a manifest or terminal projection was not flushed
- **THEN** startup recovery recognizes the one published generation, repairs its projections, and does not apply the batch twice

#### Scenario: Process stops after manifest replacement
- **WHEN** working file and manifest match the prepared candidate but the terminal journal append is absent
- **THEN** recovery appends exactly one terminal record and preserves the candidate generation

#### Scenario: Supported reader reaches the publication boundary
- **WHEN** the worker has replaced the candidate but has not completed directory fsync and projection repair
- **THEN** the reader or status endpoint cannot pass the shared barrier and therefore never reports an independently observable intermediate generation

#### Scenario: A later batch edits another row
- **WHEN** batch one commits row A and batch two later commits row B
- **THEN** batch two streams the exact attested generation from batch one and preserves row A byte-for-byte

#### Scenario: An untouched input row drifts before a later batch
- **WHEN** the hash or line count observed while streaming the current working input differs from the published attestation
- **THEN** the candidate is rejected before replacement even when every captured member row itself is fresh

### Requirement: Append-only batch queue and commit journal
The system SHALL retain append-only durable queue and transaction records
containing batch identity/payload hash/state, deterministic member order, every
captured canonical Draft hash/revision and task identity, base/candidate
generation, per-row before/after hashes and object payloads, identity
mappings/tombstones, timestamps, and referenced inference receipts sufficient
for audit and recovery. Queue, running, reconciling, terminal-success, and
terminal-failure states SHALL be distinguishable.

`queue.jsonl` SHALL own immutable enqueue identity and dispatch only.
`journal.jsonl`, durable allocation records, and the hash-attested published
working file SHALL own transaction recovery and terminal truth. Queue terminal
state and the manifest SHALL be projections repaired from those authorities;
any disagreement SHALL enter `Reconciling` and block both new batch admission
and normal status claims until repaired.

#### Scenario: Human-only batch is inspected
- **WHEN** an operator reads the records for a completed batch
- **THEN** they identify every exact captured and before/after row state and contain no invented model provenance

#### Scenario: Inference-assisted commit is inspected
- **WHEN** committed objects include ROI results
- **THEN** the journal links the resolved profile and transform receipt that produced them

### Requirement: Immediate ordinary JSONL output
`working.norm.jsonl` SHALL remain a complete ordinary JSONL representing the
last published generation throughout enqueue and background candidate
construction. It SHALL change at the single atomic replacement point only after
a whole candidate is durable. Normal reads SHALL NOT require replay of queue or
journal records, but supported consumers SHALL honor the transaction/recovery
barrier and the published hash/line-count attestation. Queued Drafts MAY lag this
file and SHALL be shown as pending rather than committed.

#### Scenario: Editing-data consumer opens working output during a batch
- **WHEN** a batch is queued or constructing a candidate before publication
- **THEN** the consumer can stream the complete prior terminal generation without consulting Label Studio or observing a partial candidate

#### Scenario: Editing-data consumer reaches reconciliation
- **WHEN** publication may have occurred but its durable projections are not yet reconciled
- **THEN** the consumer waits or fails closed at the shared recovery barrier and then streams exactly the reconciled prior or new complete generation

#### Scenario: Terminal batch succeeds
- **WHEN** the publication authority is durable and its terminal projection has been reconciled
- **THEN** the consumer can stream one complete new generation containing every batch member

### Requirement: Foreground enqueue and background batch performance gates
The implementation SHALL measure durable enqueue latency separately from
background full-train batch completion. Enqueue SHALL perform only bounded
snapshot validation and durable queue publication and SHALL not wait for
complete JSONL rewrite, manifest publication, or terminal receipt. A blocked
worker probe SHALL prove the frontend can continue Draft save, edit, and
navigation after enqueue. Background measurement SHALL record member count,
whole-batch wall time, amortized time per changed row, RSS, file passes, and
recovery behavior without weakening complete ordinary JSONL authority.

#### Scenario: Prior synchronous benchmark exceeded the hard gate
- **WHEN** the recorded one-row full-train synchronous rewrite took 12.145 seconds
- **THEN** that result remains redesign evidence, while launch now gates on nonblocking durable enqueue plus measured background batch operability rather than synchronous completion

#### Scenario: Enqueue waits for background publication
- **WHEN** a test pauses the worker before candidate creation
- **THEN** enqueue still returns its durable queue receipt and the implementation fails the gate if editing or navigation waits for worker completion

### Requirement: Source-safe recovery and rollback
Recovery and rollback SHALL operate only inside the dedicated runtime subtree
and SHALL never rewrite source JSONL or source images.

#### Scenario: Runtime project is abandoned
- **WHEN** the operator removes the dedicated project runtime subtree
- **THEN** all source artifacts remain intact and reusable for a clean bootstrap
