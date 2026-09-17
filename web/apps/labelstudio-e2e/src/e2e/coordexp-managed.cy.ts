import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

type DraftRecord = {
  annotationId: number;
  draftId: number;
  hash: string;
  persistedSemanticsKnown: boolean;
  result: Array<Record<string, unknown>>;
  resultHash: string;
  revision: string;
  taskId: number;
};

type Batch = {
  batchId: string;
  baseGeneration: number;
  captured: Map<number, string>;
  capturedResults: Map<number, Array<Record<string, unknown>>>;
  committedHashes: Map<number, string>;
  committedResults: Map<number, Array<Record<string, unknown>>>;
  memberCount: number;
  payloadHash: string;
  state: "queued" | "running" | "succeeded";
};

type DraftRouteRequest = {
  alias?: string;
  body: Record<string, unknown>;
  continue: (callback: (response: { body: unknown; statusCode: number }) => void) => void;
  reply: (response: { body: unknown; statusCode: number }) => void;
  url: string;
};

type CanvasResolution = { width: number; height: number };

type InferenceMode =
  | "produced"
  | "produced_pair"
  | "partial"
  | "empty"
  | "all_rejected"
  | "all_spans_dropped"
  | "unsupported_format"
  | "transport_failure"
  | "runtime_failure"
  | "timeout_failure"
  | "profile_failure"
  | "target_mismatch";

type InferenceReply = {
  body: Record<string, unknown>;
  delay?: number;
  statusCode: number;
};

type LifecycleOutcome = {
  action: string;
  disposition: string;
  taskId: number;
};

type ValidatedTerminalResult = {
  bbox: number[];
  cocoAnnId: number | null;
  priorOrder: number;
  regionKey: string;
  result: Record<string, unknown>;
};

const PROJECT_ID = 1;
const TASK_IDS = [1, 2] as const;
const ANNOTATION_IDS = [1, 2] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VISUAL_METADATA =
  /visual_policy_v1|stable_region_key|coordexp_visual_presentation|visual_policy_presentation|numeric_badge|advisory_conflict|duplicate_iou|neighborhood_expansion|"color"/;
const DEFAULT_RESOLUTION: CanvasResolution = { width: 1024, height: 1024 };
const RECTANGULAR_RESOLUTION: CanvasResolution = { width: 1280, height: 768 };
const SEEDED_SOURCE = {
  1: { bbox: [650, 650, 800, 820], objectId: 1001 },
  2: { bbox: [700, 100, 850, 260], objectId: 1002 },
} as const;
// A bounded fake-backend window for assertions that must happen before inference settles.
const SLOW_INFERENCE_DELAY_MS = 5000;
const LIFECYCLE_SEAM_HEADER = "coordexp-browser-e2e-lifecycle-v1";
const LIFECYCLE_SEAM_PATH = "/__coordexp-browser-e2e__/task-lifecycle/";

const exactKeys = (value: unknown, keys: string[], label: string) => {
  expect(value, label).to.be.an("object").and.not.be.an("array");
  expect(Object.keys(value as object).sort(), label).to.deep.equal([...keys].sort());
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

const sha256Json = (value: unknown) =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(canonicalize(value)))));

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const quantizeBbox = (value: Record<string, unknown>) => {
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  return [
    Math.max(0, Math.min(999, Math.floor((x * 999) / 100 + 1e-9))),
    Math.max(0, Math.min(999, Math.floor((y * 999) / 100 + 1e-9))),
    Math.max(0, Math.min(999, Math.ceil(((x + width) * 999) / 100 - 1e-9))),
    Math.max(0, Math.min(999, Math.ceil(((y + height) * 999) / 100 - 1e-9))),
  ];
};

const resultCocoAnnId = (result: Record<string, unknown>, label: string) => {
  const meta = (result.meta ?? {}) as Record<string, unknown>;
  const primary = meta.coco_ann_id;
  const compatibility = meta.coordexp_coco_ann_id;

  if (primary !== undefined && compatibility !== undefined) {
    expect(compatibility, `${label} COCO identity aliases agree`).to.equal(primary);
  }
  const objectId = primary ?? compatibility ?? null;

  if (objectId !== null) {
    expect(Number.isInteger(objectId), `${label} COCO identity is an integer`).to.equal(true);
    expect(objectId, `${label} COCO identity is nonzero`).not.to.equal(0);
  }
  return objectId as number | null;
};

const validatedResultIdentityAndBbox = (result: Record<string, unknown>, label: string) => {
  expect(result.id, `${label} Label Studio result id`).to.be.a("string").and.not.be.empty;
  expect(result.image_rotation, `${label} image rotation`).to.equal(0);
  const value = result.value as Record<string, unknown>;

  expect(value, `${label} value`).to.be.an("object").and.not.equal(null);
  expect(value.rotation, `${label} bbox rotation`).to.equal(0);
  for (const coordinate of ["x", "y", "width", "height"] as const) {
    expect(Number.isFinite(value[coordinate]), `${label} ${coordinate} is finite`).to.equal(true);
  }
  expect(value.width, `${label} width is positive`).to.be.greaterThan(0);
  expect(value.height, `${label} height is positive`).to.be.greaterThan(0);
  const bbox = quantizeBbox(value);

  expect(bbox[2], `${label} quantized width is non-degenerate`).to.be.greaterThan(bbox[0]);
  expect(bbox[3], `${label} quantized height is non-degenerate`).to.be.greaterThan(bbox[1]);
  const meta = (result.meta ?? {}) as Record<string, unknown>;
  const regionKey = meta.coordexp_region_key ?? result.id;

  expect(regionKey, `${label} stable region key`).to.be.a("string").and.not.be.empty;
  return {
    bbox,
    cocoAnnId: resultCocoAnnId(result, label),
    regionKey: regionKey as string,
  };
};

const draftResults = (body: unknown) => {
  expect(body, "Draft request body").to.be.an("object").and.not.equal(null);
  const result = (body as Record<string, unknown>).result;
  expect(result, "Draft result array").to.be.an("array");
  return result as Array<Record<string, unknown>>;
};

const semanticProjection = (results: Array<Record<string, unknown>>) =>
  results
    .map((result, index) => {
      const value = result.value as Record<string, unknown>;
      const labels = value.rectanglelabels as string[];
      const validated = validatedResultIdentityAndBbox(result, `semantic result ${index}`);
      expect(labels, "one canonical COCO class per bbox").to.have.length(1);
      const categoryName = labels[0];
      const categoryId = { person: 1, bicycle: 2 }[categoryName as "person" | "bicycle"];
      expect(categoryId, `known canonical COCO class ${categoryName}`).not.to.equal(undefined);
      return {
        region_key: validated.regionKey,
        bbox_2d: validated.bbox,
        category_name: categoryName,
        category_id: categoryId,
        coco_ann_id: validated.cocoAnnId,
      };
    })
    .sort((left, right) => String(left.region_key).localeCompare(String(right.region_key)));

const semanticHash = (results: Array<Record<string, unknown>>) => sha256Json(semanticProjection(results));
const EMPTY_SEMANTIC_HASH = semanticHash([]);

const PROFILE = {
  selector: "safe",
  display_label: "safe",
  default_canvas: { width: 1024, height: 1024 },
  processor_factor: 32,
  bounds: { min_axis_pixels: 32, max_axis_pixels: 2048, max_total_pixels: 2097152 },
  generation_deadline_seconds: 20,
};
const PROFILE_FINGERPRINT = sha256Json(PROFILE);

class FakeRefinementBackend {
  drafts = new Map<number, DraftRecord>();
  draftBodies: unknown[] = [];
  draftHashes = new Map<number, string[]>();
  inferBodies: Array<Record<string, unknown>> = [];
  abandonBodies: Array<Record<string, unknown>> = [];
  lifecycleRequests: Array<Record<string, unknown>> = [];
  lifecycleDispositions: string[] = [];
  lifecycleOutcomes: LifecycleOutcome[] = [];
  generation = 0;
  version = 1;
  active: Batch | null = null;
  terminal: Batch | null = null;
  inferCount = 0;
  inferMode: InferenceMode = "produced";
  inferDelay = 0;
  expectedResolution: CanvasResolution = DEFAULT_RESOLUTION;
  lastProducedBboxes: number[][] = [];
  baselineHashes = new Map<number, string>();
  private committedIds = new Map<string, number>();
  private nextCommittedId = -1;
  private newInferenceDraftFailureBaseline: Set<string> | null = null;

  setInferenceMode(
    mode: InferenceMode,
    { delay = 0, resolution = DEFAULT_RESOLUTION }: { delay?: number; resolution?: CanvasResolution } = {},
  ) {
    this.inferMode = mode;
    this.inferDelay = delay;
    this.expectedResolution = resolution;
    this.lastProducedBboxes = [];
  }

  private inferenceReceiptIds(body: unknown) {
    return new Set(
      draftResults(body)
        .map((result) => (result.meta as Record<string, unknown> | undefined)?.coordexp_inference_receipt_id)
        .filter((receiptId): receiptId is string => typeof receiptId === "string"),
    );
  }

  armNewInferenceDraftSaveFailure() {
    if (this.newInferenceDraftFailureBaseline) {
      throw new Error("New-inference Draft failure is already armed.");
    }
    const knownReceiptIds = new Set<string>();

    for (const body of this.draftBodies) {
      for (const receiptId of this.inferenceReceiptIds(body)) knownReceiptIds.add(receiptId);
    }
    this.newInferenceDraftFailureBaseline = knownReceiptIds;
  }

  isNewInferenceDraftSaveFailureArmed() {
    return this.newInferenceDraftFailureBaseline !== null;
  }

  shouldFailDraftSave(body: unknown) {
    const baseline = this.newInferenceDraftFailureBaseline;

    if (!baseline) return false;
    const hasNewReceipt = [...this.inferenceReceiptIds(body)].some((receiptId) => !baseline.has(receiptId));

    if (hasNewReceipt) this.newInferenceDraftFailureBaseline = null;
    return hasNewReceipt;
  }

  recordDraft(taskId: number, annotationId: number, response: Record<string, unknown>, body: unknown) {
    const serialized = JSON.stringify(body);
    expect(serialized, "Draft payload must exclude volatile visual presentation").not.to.match(VISUAL_METADATA);
    expect(response.id).to.be.a("number").and.greaterThan(0);
    expect(response.updated_at).to.be.a("string").and.not.be.empty;
    const results = draftResults(body);
    const hash = semanticHash(results);
    const resultHash = sha256Json(results);
    const sourceResults = results.filter((result) => String(result.id).startsWith("train:coco:"));
    expect(hash, "canonical Draft semantic hash").to.match(SHA256);
    expect(resultHash, "canonical Draft result hash").to.match(SHA256);
    if (!this.baselineHashes.has(taskId)) {
      expect(sourceResults, "fixture Draft retains one canonical source bbox").to.have.length(1);
      this.baselineHashes.set(taskId, semanticHash(sourceResults));
    }
    this.draftBodies.push(body);
    this.draftHashes.set(taskId, [...(this.draftHashes.get(taskId) ?? []), hash]);
    this.drafts.set(taskId, {
      annotationId,
      draftId: response.id as number,
      hash,
      persistedSemanticsKnown: true,
      result: cloneJson(results),
      resultHash,
      revision: response.updated_at as string,
      taskId,
    });
    this.version += 1;
  }

  private activeBatchBlock(batch: Batch | null) {
    if (!batch) return null;
    return {
      batch_id: batch.batchId,
      state: batch.state,
      member_count: batch.memberCount,
      base_generation: batch.baseGeneration,
      payload_hash: batch.payloadHash,
    };
  }

  private terminalBatchBlock(batch: Batch | null) {
    if (!batch) return null;
    return {
      batch_id: batch.batchId,
      state: batch.state,
      member_count: batch.memberCount,
      base_generation: batch.baseGeneration,
      generation: this.generation,
      payload_hash: batch.payloadHash,
      error: null,
      member_task_keys: [...batch.captured.keys()].map((taskId) => `train:${taskId}`).sort(),
    };
  }

  projectState() {
    const members = [...this.drafts.values()].map((draft) => {
      const captured = this.active?.captured.get(draft.taskId) ?? null;
      const terminal = this.terminal?.captured.get(draft.taskId) ?? null;
      const committed =
        this.terminal?.committedHashes.get(draft.taskId) ??
        this.baselineHashes.get(draft.taskId) ??
        EMPTY_SEMANTIC_HASH;
      return {
        task_id: draft.taskId,
        task_key: `train:${draft.taskId}`,
        draft_id: draft.draftId,
        draft_updated_at: draft.revision,
        draft_semantic_hash: draft.hash,
        committed_semantic_hash: committed,
        pending: draft.hash !== committed,
        draft_ahead_of_committed: draft.hash !== committed,
        active_batch_member: captured !== null,
        active_batch_semantic_hash: captured,
        draft_ahead_of_active_batch: captured !== null && captured !== draft.hash,
        last_terminal_batch_member: terminal !== null,
        last_terminal_batch_semantic_hash: terminal,
        draft_matches_last_terminal_batch: terminal !== null && terminal === draft.hash,
      };
    });
    return {
      version: this.version,
      generation: this.generation,
      pending_draft_count: members.filter((member) => member.pending).length,
      members,
      active_batch_id: this.active?.batchId ?? null,
      batch_state: this.active?.state ?? null,
      active_batch: this.activeBatchBlock(this.active),
      last_terminal_batch: this.terminalBatchBlock(this.terminal),
    };
  }

  private validateTerminalMembers(members: Map<number, Array<Record<string, unknown>>>, phase: "commit" | "terminal") {
    expect(members.size, `${phase} captured member count`).to.be.greaterThan(0);
    const resultIds = new Set<string>();
    const regionKeys = new Set<string>();
    const cocoAnnIds = new Set<number>();
    const validated = new Map<number, ValidatedTerminalResult[]>();

    for (const [taskId, results] of [...members.entries()].sort(([left], [right]) => left - right)) {
      expect(taskId, `${phase} member task identity`).to.be.oneOf(TASK_IDS);
      expect(results, `${phase} Task ${taskId} captured results`).to.be.an("array").and.not.be.empty;
      const taskSource = SEEDED_SOURCE[taskId as 1 | 2];
      const taskResults = results.map((result, priorOrder) => {
        const label = `${phase} Task ${taskId} result ${priorOrder}`;
        const identity = validatedResultIdentityAndBbox(result, label);

        expect(resultIds.has(result.id as string), `${label} result id is batch-unique`).to.equal(false);
        expect(regionKeys.has(identity.regionKey), `${label} region key is batch-unique`).to.equal(false);
        resultIds.add(result.id as string);
        regionKeys.add(identity.regionKey);
        if (identity.cocoAnnId !== null) {
          expect(cocoAnnIds.has(identity.cocoAnnId), `${label} COCO identity is batch-unique`).to.equal(false);
          cocoAnnIds.add(identity.cocoAnnId);
        }
        if (identity.cocoAnnId !== null && identity.cocoAnnId > 0) {
          expect(identity.regionKey, `${label} positive identity belongs to the canonical source`).to.equal(
            `train:coco:${taskSource.objectId}`,
          );
          expect(result.id, `${label} canonical source result id`).to.equal(identity.regionKey);
          expect(identity.cocoAnnId, `${label} canonical source COCO identity`).to.equal(taskSource.objectId);
        }
        if (identity.cocoAnnId !== null && identity.cocoAnnId < 0) {
          expect(
            this.committedIds.get(identity.regionKey),
            `${label} negative identity was allocated previously for the same stable key`,
          ).to.equal(identity.cocoAnnId);
        }
        return {
          ...identity,
          priorOrder,
          result,
        };
      });

      validated.set(
        taskId,
        taskResults.sort(
          (left, right) =>
            left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0] || left.priorOrder - right.priorOrder,
        ),
      );
    }
    return validated;
  }

  commit(batchId: string) {
    expect(batchId).to.match(UUID);
    expect(this.active, "only one active fake worker is allowed").to.equal(null);
    const pendingDrafts = [...this.drafts.values()]
      .filter(
        (draft) =>
          draft.hash !== (this.terminal?.committedHashes.get(draft.taskId) ?? this.baselineHashes.get(draft.taskId)),
      )
      .sort((left, right) => left.taskId - right.taskId);
    for (const draft of pendingDrafts) {
      expect(
        draft.persistedSemanticsKnown,
        `Commit Task ${draft.taskId} requires a captured response for the current persisted Draft`,
      ).to.equal(true);
    }
    const captured = new Map(pendingDrafts.map((draft) => [draft.taskId, draft.hash]));
    expect(captured.size, "Commit must capture at least one pending Draft").to.be.greaterThan(0);
    const capturedResults = new Map(pendingDrafts.map((draft) => [draft.taskId, cloneJson(draft.result)]));

    this.validateTerminalMembers(capturedResults, "commit");
    const payloadHash = sha256Json(
      [...captured.entries()]
        .map(([taskId, hash]) => ({ task_key: `train:${taskId}`, semantic_hash: hash }))
        .sort((left, right) => left.task_key.localeCompare(right.task_key)),
    );
    this.active = {
      batchId,
      baseGeneration: this.generation,
      captured,
      capturedResults,
      committedHashes: new Map(),
      committedResults: new Map(),
      memberCount: captured.size,
      payloadHash,
      state: "queued",
    };
    this.version += 1;
    return this.receipt(this.active);
  }

  finishActiveSuccess() {
    expect(this.active, "active fake worker").not.to.equal(null);
    const active = this.active as Batch;
    const committedResults = new Map<number, Array<Record<string, unknown>>>();
    const committedHashes = new Map<number, string>();
    const members = this.validateTerminalMembers(active.capturedResults, "terminal");
    const allocatedIds = new Set<number>();

    for (const [taskId, results] of members) {
      const committed = results.map((result, outputOrder) =>
        this.materializeCommittedResult(result, outputOrder, allocatedIds),
      );

      committedResults.set(taskId, committed);
      committedHashes.set(taskId, semanticHash(committed));
    }
    this.generation += 1;
    this.terminal = { ...active, committedHashes, committedResults, state: "succeeded" };
    this.active = null;
    this.version += 1;
  }

  private materializeCommittedResult(
    validated: ValidatedTerminalResult,
    outputOrder: number,
    allocatedIds: Set<number>,
  ) {
    const { bbox, cocoAnnId: priorObjectId, regionKey, result } = validated;
    const value = result.value as Record<string, unknown>;
    const priorMeta = (result.meta ?? {}) as Record<string, unknown>;
    let objectId: number;

    if (priorObjectId !== null && priorObjectId > 0) {
      objectId = priorObjectId;
    } else {
      const assigned = this.committedIds.get(regionKey);

      if (assigned === undefined) {
        while (allocatedIds.has(this.nextCommittedId)) this.nextCommittedId -= 1;
        objectId = this.nextCommittedId;
        this.nextCommittedId -= 1;
        this.committedIds.set(regionKey, objectId);
      } else objectId = assigned;
    }
    expect(Number.isInteger(objectId), `terminal COCO identity ${regionKey}`).to.equal(true);
    expect(objectId, `terminal COCO identity ${regionKey}`).not.to.equal(0);
    expect(allocatedIds.has(objectId), `terminal COCO identity ${regionKey} is unique`).to.equal(false);
    allocatedIds.add(objectId);
    const meta: Record<string, unknown> = {
      coordexp_region_key: regionKey,
      last_committed_bbox: bbox,
      coco_ann_id: objectId,
      coordexp_creation_ordinal: outputOrder,
    };
    for (const key of [
      "coordexp_training_metadata",
      "coordexp_inference_receipt_id",
      "coordexp_inference_request_id",
      "coordexp_inference_result_id",
      "coordexp_inference_source_draft_revision",
    ]) {
      if (key in priorMeta) meta[key] = cloneJson(priorMeta[key]);
    }

    return {
      id: regionKey,
      type: "rectanglelabels",
      from_name: "bbox",
      to_name: "image",
      original_width: result.original_width,
      original_height: result.original_height,
      image_rotation: 0,
      value: {
        x: (bbox[0] * 100) / 999,
        y: (bbox[1] * 100) / 999,
        width: ((bbox[2] - bbox[0]) * 100) / 999,
        height: ((bbox[3] - bbox[1]) * 100) / 999,
        rotation: 0,
        rectanglelabels: cloneJson(value.rectanglelabels),
      },
      meta,
    };
  }

  markActiveRunning() {
    expect(this.active, "queued fake worker").not.to.equal(null);
    (this.active as Batch).state = "running";
    this.version += 1;
  }

  receipt(batch: Batch) {
    return {
      base_generation: batch.baseGeneration,
      batch_id: batch.batchId,
      error: null,
      generation: batch.state === "succeeded" ? this.generation : null,
      member_count: batch.memberCount,
      payload_hash: batch.payloadHash,
      split: "train",
      status: batch.state,
    };
  }

  lifecycleSeamBody(productionRequest: Record<string, unknown>) {
    exactKeys(productionRequest, ["action", "task_id", "expected_draft"], "task-lifecycle request");
    expect(productionRequest.action, "task-lifecycle action").to.be.oneOf(["inspect", "reconcile", "discard"]);
    const taskId = Number(productionRequest.task_id);
    const expected = productionRequest.expected_draft as Record<string, unknown>;

    expect(taskId, "task-lifecycle task identity").to.be.oneOf(TASK_IDS);
    exactKeys(expected, ["draft_id", "draft_updated_at", "draft_semantic_hash"], "task-lifecycle exact Draft token");
    expect(expected.draft_id).to.be.a("number").and.greaterThan(0);
    expect(expected.draft_updated_at).to.be.a("string").and.not.be.empty;
    expect(expected.draft_semantic_hash).to.match(SHA256);
    const draft = this.drafts.get(taskId);
    const terminalHash = this.terminal?.captured.get(taskId);
    const committedResult = this.terminal?.committedResults.get(taskId);
    const committedHash = this.terminal?.committedHashes.get(taskId);

    expect(draft, "task-lifecycle resolves one current fake Draft").not.to.equal(undefined);
    expect(committedResult, "task-lifecycle resolves terminal committed results").not.to.equal(undefined);
    expect(committedHash, "task-lifecycle resolves terminal committed hash").to.match(SHA256);
    expect(expected.draft_id, "browser Draft id matches fake authority").to.equal(draft?.draftId);
    const requestTokenMatchesCurrent =
      expected.draft_updated_at === draft?.revision && expected.draft_semantic_hash === draft?.hash;
    const allowRebase =
      productionRequest.action === "reconcile" &&
      requestTokenMatchesCurrent &&
      terminalHash === expected.draft_semantic_hash;

    this.lifecycleRequests.push(cloneJson(productionRequest));

    return {
      annotation_id: draft?.annotationId,
      allow_rebase: allowRebase,
      committed_generation: this.generation,
      committed_result: cloneJson(committedResult),
      committed_semantic_hash: committedHash,
      production_request: cloneJson(productionRequest),
    };
  }

  applyLifecycleResponse(taskId: number, response: Record<string, unknown>) {
    exactKeys(
      response,
      ["action", "disposition", "task_id", "annotation_id", "draft", "expected_draft_matches", "committed"],
      "task-lifecycle response",
    );
    expect(response.task_id).to.equal(taskId);
    expect(response.expected_draft_matches, "task-lifecycle match flag").to.be.a("boolean");
    const draftResponse = response.draft as Record<string, unknown>;
    const committed = response.committed as Record<string, unknown>;
    const current = this.drafts.get(taskId);

    exactKeys(
      draftResponse,
      ["draft_id", "draft_updated_at", "draft_semantic_hash"],
      "task-lifecycle response Draft token",
    );
    exactKeys(committed, ["generation", "semantic_hash", "result"], "task-lifecycle committed projection");
    expect(committed.generation).to.equal(this.generation);
    expect(committed.semantic_hash).to.equal(this.terminal?.committedHashes.get(taskId));
    expect(committed.result).to.deep.equal(this.terminal?.committedResults.get(taskId));
    expect(current, "task-lifecycle response updates a known Draft").not.to.equal(undefined);
    this.lifecycleDispositions.push(String(response.disposition));
    const request = [...this.lifecycleRequests].reverse().find((candidate) => Number(candidate.task_id) === taskId);

    this.lifecycleOutcomes.push({
      action: String(request?.action),
      disposition: String(response.disposition),
      taskId,
    });

    if (response.disposition === "rebased" || response.disposition === "reset") {
      expect(response.expected_draft_matches, "exact lifecycle mutation requires a matching token").to.equal(true);
      const results = cloneJson(committed.result) as Array<Record<string, unknown>>;

      this.drafts.set(taskId, {
        ...(current as DraftRecord),
        hash: String(draftResponse.draft_semantic_hash),
        persistedSemanticsKnown: true,
        result: results,
        resultHash: sha256Json(results),
        revision: String(draftResponse.draft_updated_at),
      });
      this.version += 1;
      return;
    }
    expect(response.disposition, "newer Draft receives metadata only").to.equal("metadata_only");
    expect(draftResponse.draft_id).to.equal(current?.draftId);
    const expected = request?.expected_draft as Record<string, unknown>;
    const responseHash = String(draftResponse.draft_semantic_hash);
    const responseRevision = String(draftResponse.draft_updated_at);
    const requestHash = String(expected.draft_semantic_hash);
    const requestRevision = String(expected.draft_updated_at);
    const currentMatchesRequest = current?.hash === requestHash && current?.revision === requestRevision;
    const currentMatchesResponse = current?.hash === responseHash && current?.revision === responseRevision;

    if (response.expected_draft_matches) {
      expect(responseHash, "matching inspect response preserves request semantics").to.equal(requestHash);
      expect(responseRevision, "matching inspect response preserves request revision").to.equal(requestRevision);
    } else {
      expect(
        responseHash !== requestHash || responseRevision !== requestRevision,
        "stale inspect returns a newer persisted Draft token",
      ).to.equal(true);
    }
    if (currentMatchesRequest) {
      this.drafts.set(taskId, {
        ...(current as DraftRecord),
        hash: responseHash,
        persistedSemanticsKnown: current?.hash === responseHash && current.persistedSemanticsKnown,
        revision: responseRevision,
      });
    } else if (!currentMatchesResponse) {
      expect(
        Date.parse(current?.revision ?? "") >= Date.parse(responseRevision),
        "a concurrent observed Draft save may only advance beyond the lifecycle response",
      ).to.equal(true);
    }
  }

  inference(body: Record<string, unknown>): InferenceReply {
    exactKeys(body, ["request_id", "task_id", "roi", "resolution", "profile_selector"], "ROI infer request");
    expect(body.request_id).to.match(UUID);
    expect(body.task_id).to.be.oneOf(TASK_IDS);
    expect(body.profile_selector).to.equal("safe");
    expect(body.resolution).to.deep.equal(this.expectedResolution);
    exactKeys(body.roi, ["x", "y", "width", "height"], "percent ROI");
    const roi = body.roi as Record<string, unknown>;
    const x = Number(roi.x);
    const y = Number(roi.y);
    const width = Number(roi.width);
    const height = Number(roi.height);

    for (const [name, value] of Object.entries({ x, y, width, height })) {
      expect(Number.isFinite(value), `ROI ${name} is finite`).to.equal(true);
    }
    expect(x, "ROI x is in bounds").to.be.at.least(0);
    expect(y, "ROI y is in bounds").to.be.at.least(0);
    expect(width, "ROI width is non-degenerate").to.be.greaterThan(0);
    expect(height, "ROI height is non-degenerate").to.be.greaterThan(0);
    expect(x + width, "ROI right edge is in bounds").to.be.at.most(100);
    expect(y + height, "ROI bottom edge is in bounds").to.be.at.most(100);
    this.inferBodies.push(body);
    this.inferCount += 1;
    const requestId = body.request_id as string;
    const taskId = body.task_id as number;
    const draft = this.drafts.get(taskId);
    expect(draft, "inference requires a durable frozen Draft").not.to.equal(undefined);
    const receipt = {
      receipt_id: `roi-receipt:${requestId}`,
      request_id: requestId,
    };

    if (this.inferMode === "transport_failure") {
      return {
        statusCode: 503,
        delay: this.inferDelay,
        body: { error: { code: "transport_failure", message: "Synthetic transport failure." } },
      };
    }
    if (this.inferMode === "empty" || this.inferMode === "all_rejected") {
      const rejected = this.inferMode === "all_rejected" ? 2 : 0;
      return {
        statusCode: 200,
        delay: this.inferDelay,
        body: {
          ...receipt,
          request_state: this.inferMode,
          terminal_status: this.inferMode,
          clear_roi: true,
          insertion_payload: null,
          failure: null,
          counts: { parsed: rejected, produced: 0, rejected },
        },
      };
    }
    if (this.inferMode === "all_spans_dropped" || this.inferMode === "unsupported_format") {
      return {
        statusCode: 200,
        delay: this.inferDelay,
        body: {
          ...receipt,
          request_state: "response_failure",
          terminal_status: "response_failure",
          clear_roi: false,
          insertion_payload: null,
          failure: null,
          counts: { parsed: 0, produced: 0, rejected: 0 },
        },
      };
    }
    if (["runtime_failure", "timeout_failure", "profile_failure"].includes(this.inferMode)) {
      return {
        statusCode: 200,
        delay: this.inferDelay,
        body: {
          ...receipt,
          request_state: this.inferMode,
          terminal_status: this.inferMode,
          clear_roi: false,
          insertion_payload: null,
          failure: { stage: this.inferMode.replace("_failure", ""), code: `synthetic_${this.inferMode}` },
        },
      };
    }

    const resultCount = this.inferMode === "produced_pair" ? 2 : 1;
    const rejected = this.inferMode === "partial" ? 1 : 0;
    const offset = 200 + this.inferCount * 3;
    const bboxes = Array.from({ length: resultCount }, (_, index) => {
      const shifted = offset + index * 20;
      return [shifted, shifted, shifted + 160, shifted + 160];
    });
    this.lastProducedBboxes = bboxes;
    const regions = bboxes.map((bbox, index) => {
      const resultId = `${requestId}:result-${index}`;
      const regionKey = `roi:${requestId}:${index + 1}`;
      const value = {
        x: (bbox[0] * 100) / 999,
        y: (bbox[1] * 100) / 999,
        width: ((bbox[2] - bbox[0]) * 100) / 999,
        height: ((bbox[3] - bbox[1]) * 100) / 999,
        rotation: 0,
        rectanglelabels: ["person"],
      };
      const meta = {
        coordexp_region_key: regionKey,
        coordexp_inference_receipt_id: `roi-receipt:${requestId}`,
        coordexp_inference_request_id: requestId,
        coordexp_inference_result_id: resultId,
        coordexp_inference_source_draft_revision: draft?.revision,
      };

      return {
        result_id: resultId,
        category_name: "person",
        category_id: 1,
        bbox_2d: bbox,
        request_id: requestId,
        parser_object_span_id: `span:${this.inferCount}:${index}`,
        source_draft_revision: draft?.revision,
        region_key: regionKey,
        label_studio_result: {
          id: regionKey,
          type: "rectanglelabels",
          from_name: "bbox",
          to_name: "image",
          original_width: 1024,
          original_height: 1024,
          image_rotation: 0,
          value,
          meta,
        },
      };
    });
    const resolution = body.resolution as CanvasResolution;

    return {
      statusCode: 200,
      delay: this.inferDelay,
      body: {
        ...receipt,
        request_state: "produced",
        terminal_status: null,
        clear_roi: false,
        insertion_payload: {
          target: {
            request_id: requestId,
            project_id: String(PROJECT_ID),
            task_id: this.inferMode === "target_mismatch" ? "train:detached" : `train:${taskId}`,
            task_epoch: `task-epoch:${taskId}`,
            image_id: String(taskId),
            annotation_id: String(draft?.annotationId),
            annotation_revision: `annotation:${draft?.annotationId}`,
            current_user_id: "1",
            draft_id: String(draft?.draftId),
            draft_revision: draft?.revision,
            profile_fingerprint: PROFILE_FINGERPRINT,
            project_generation: this.generation,
            transform_fingerprint: sha256Json({
              version: "identity-v1",
              source_size: [1024, 1024],
              target_size: [resolution.width, resolution.height],
            }),
            preexisting_draft_dirty: false,
          },
          mode: "append_one_undo_action",
          regions,
        },
        failure: null,
        counts: { parsed: resultCount + rejected, produced: resultCount, rejected },
      },
    };
  }
}

// This bridge is intentionally read-only in browser E2E; every editor mutation below is a DOM, pointer, or key action.
const wrapper = (win: Cypress.AUTWindow) => (win as Cypress.AUTWindow & { dataManager: any }).dataManager.lsf;

const drawingArea = () => cy.get(".konvajs-content:visible").first();

const dragStageRelative = (
  x: number,
  y: number,
  width: number,
  height: number,
  options: Partial<Cypress.TriggerOptions & Cypress.ObjectLike & MouseEvent> = {},
) => {
  drawingArea().then(($area) => {
    const bounds = $area[0].getBoundingClientRect();
    const startX = x * bounds.width;
    const startY = y * bounds.height;
    const endX = startX + width * bounds.width;
    const endY = startY + height * bounds.height;

    cy.wrap($area)
      .scrollIntoView()
      .trigger("mousedown", startX, startY, { eventConstructor: "MouseEvent", buttons: 1, ...options })
      .trigger("mousemove", endX, endY, { eventConstructor: "MouseEvent", buttons: 1, ...options })
      .trigger("mouseup", endX, endY, { eventConstructor: "MouseEvent", buttons: 1, ...options });
  });
};

const clickStageRelative = (x: number, y: number) => {
  drawingArea().then(($area) => {
    const bounds = $area[0].getBoundingClientRect();

    cy.wrap($area)
      .scrollIntoView()
      .click(x * bounds.width, y * bounds.height);
  });
};

const selectMoveTool = () => {
  cy.get('.lsf-toolbar [aria-label="move-tool"]')
    .should("be.visible")
    .then(($tool) => {
      if (!$tool.hasClass("lsf-tool_active")) cy.wrap($tool).click();
    })
    .should("have.class", "lsf-tool_active");
};

const selectCocoLabel = (label: string) => {
  cy.contains(".lsf-label", label).click();
  cy.get(".lsf-label_selected").should("contain.text", label);
};

const ensureCocoLabelSelected = (label: string) => {
  cy.contains(".lsf-label", label).then(($label) => {
    if (!$label.hasClass("lsf-label_selected")) cy.wrap($label).click();
  });
  cy.get(".lsf-label_selected").should("contain.text", label);
};

const unselectRegions = () => cy.get("body").type("{esc}");
const deleteSelectedRegion = () => cy.get("body").type("{backspace}");
const selectedOutlinerRegions = () =>
  cy.get(
    ".lsf-outliner .lsf-tree__node:not(.lsf-tree__node_type_footer) .lsf-tree-node-content-wrapper.lsf-tree-node-selected",
  );

const waitForManagedTaskReady = (taskId: number) => {
  cy.location("search").should("contain", `task=${taskId}`);
  cy.get('[aria-label="AI Region inference"]').should("be.visible");
  cy.get('[aria-label="Inference profile"]').should("be.visible").and("have.value", "safe");
  cy.get('[aria-label="Canvas width"]').should("be.visible").and("have.value", "1024");
  cy.get('[aria-label="Canvas height"]').should("be.visible").and("have.value", "1024");
  cy.get("img[alt=image]")
    .should("be.visible")
    .should(($image) => {
      const image = $image[0] as HTMLImageElement;
      expect(image.complete, "image request completed").to.equal(true);
      expect(image.naturalWidth, "image decoded").to.be.greaterThan(0);
    });
  drawingArea().should("be.visible").find("canvas").first().should("be.visible");
  cy.window().should((win) => {
    const dataManager = (win as Cypress.AUTWindow & { dataManager: any }).dataManager;
    const lsf = wrapper(win);
    const editorStore = lsf.lsf;
    const annotation = lsf.currentAnnotation;

    expect(Number(lsf.task.id), "Data Manager task is current").to.equal(taskId);
    expect(Number(editorStore.task.id), "editor task is current").to.equal(taskId);
    expect(dataManager.store.loadingData, "Data Manager task loading completed").to.equal(false);
    expect(dataManager.store.taskStore.itemIsLoading(taskId), "target task request completed").to.equal(false);
    expect(editorStore.isLoading, "editor loading completed").to.equal(false);
    expect(annotation, "selected annotation initialized").not.to.equal(null);
    const image = annotation.names.get("image");
    expect(annotation.isReadOnly(), "selected annotation is editable").to.equal(false);
    expect(annotation.history.isFrozen, "selected annotation history ready for mutation").to.equal(false);
    expect(image.imageIsLoaded, "natural image loaded").to.equal(true);
    expect(image.stageRef, "Konva stage mounted").not.to.equal(null);
    expect(image.stageRef.find("Image"), "Konva image painted").to.have.length.greaterThan(0);
  });
  cy.window().then(
    (win) =>
      new Cypress.Promise<void>((resolve) => {
        win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve()));
      }),
  );
};

const assertSeededSourceBbox = (taskId: 1 | 2) => {
  const source = SEEDED_SOURCE[taskId];
  const regionKey = `train:coco:${source.objectId}`;
  const [x1, y1, x2, y2] = source.bbox;

  selectRegionAt((x1 + x2) / (2 * 999), (y1 + y2) / (2 * 999));
  cy.window().should((win) => {
    const annotation = wrapper(win).currentAnnotation;
    const region = annotation.regions.find((candidate: any) => candidate.cleanId === regionKey);
    const serialized = (annotation.serialized as Array<Record<string, any>>).find((result) => result.id === regionKey);

    expect(region, "fixture source bbox is loaded as a real region").not.to.equal(undefined);
    expect(annotation.selectedRegions, "fixture source bbox is pointer-selectable").to.have.length(1);
    expect(annotation.selectedRegions[0].cleanId, "selected source bbox identity").to.equal(regionKey);
    expect(region.supportsTransform, "fixture source bbox supports move/resize").to.equal(true);
    expect(region.shapeRef?.getStage(), "fixture source bbox is visibly painted").not.to.equal(null);
    expect(region.shapeRef?.isVisible(), "fixture source bbox overlay is visible").to.equal(true);
    expect(region.canRotate, "managed source bbox exposes no rotation transform").to.equal(false);
    expect(serialized?.image_rotation, "source image rotation stays zero").to.equal(0);
    expect(serialized?.value?.rotation, "source bbox rotation stays zero").to.equal(0);
    expect(serialized?.meta, "source bbox retains canonical hidden identity").to.include({
      coordexp_region_key: regionKey,
      coco_ann_id: source.objectId,
    });
    expect(serialized?.meta?.last_committed_bbox, "source bbox retains committed lattice geometry").to.deep.equal(
      source.bbox,
    );
    const transformer = annotation.names
      .get("image")
      .stageRef.find("Transformer")
      .find((candidate: any) =>
        (candidate.nodes?.() ?? []).some(
          (node: any) => node === region.shapeRef || node === region.shapeRef?.getParent?.(),
        ),
      );

    expect(transformer, "selected source bbox owns a resize transformer").not.to.equal(undefined);
    expect(transformer.rotateEnabled(), "source bbox transformer disables rotation").to.equal(false);
  });
  unselectRegions();
};

let reloadSequence = 0;

const reloadManagedTask = (taskId: number) => {
  reloadSequence += 1;
  const taskAlias = `managedReloadTask${reloadSequence}`;
  const labelsAlias = `managedReloadLabels${reloadSequence}`;
  const stateAlias = `managedReloadState${reloadSequence}`;

  cy.intercept({ method: "GET", pathname: `/api/tasks/${taskId}`, query: { project: "1" }, times: 1 }).as(taskAlias);
  cy.intercept({ method: "GET", url: /\/api\/label_links\?project=1(?:&|$)/, times: 1 }).as(labelsAlias);
  cy.intercept({
    method: "GET",
    pathname: "/api/projects/1/coordexp-refinement/project-state/",
    times: 1,
  }).as(stateAlias);
  cy.reload();
  cy.wait(`@${taskAlias}`).its("response.statusCode").should("equal", 200);
  cy.wait(`@${labelsAlias}`).its("response.statusCode").should("equal", 200);
  cy.wait(`@${stateAlias}`).its("response.statusCode").should("equal", 200);
  waitForManagedTaskReady(taskId);
};

const waitForTerminalPresentationRetirement = (taskId: number, taskKey: string) => {
  cy.get('[aria-label="CoordExp refinement status"] .coordexp-managed-panel__state').should("have.text", "Committed");
  cy.get('[aria-label="CoordExp refinement status"]').should("not.contain.text", "Unsaved local edit");
  cy.window().should((win) => {
    const status = wrapper(win).getManagedStatusState();
    const members = status.authority?.members?.filter(
      (member: any) => Number(member.task_id) === taskId && member.task_key === taskKey,
    );

    expect(status.taskSemanticState, "reloaded task semantic state").to.equal("Committed");
    expect(status.authority?.last_terminal_batch?.state, "reloaded terminal batch").to.equal("succeeded");
    expect(members, "one exact reloaded terminal member").to.have.length(1);
    expect(members[0], "reloaded task matches its terminal snapshot").to.include({
      last_terminal_batch_member: true,
      draft_matches_last_terminal_batch: false,
      draft_ahead_of_committed: false,
      pending: false,
    });
    expect(status.local, "reloaded local presentation-retirement fence").to.include({
      dirty: false,
      saveInFlight: false,
      roiRunning: false,
      pendingTaskCount: 0,
    });
  });
};

const assertTerminalSerializedContract = (taskId: 1 | 2) => {
  cy.window().should((win) => {
    const serialized = wrapper(win).currentAnnotation.serialized as Array<Record<string, any>>;
    const source = SEEDED_SOURCE[taskId];
    const sourceKey = `train:coco:${source.objectId}`;
    const sourceResult = serialized.find((result) => result.id === sourceKey);

    expect(sourceResult, "terminal serialization retains the canonical source result").not.to.equal(undefined);
    expect(sourceResult?.meta?.coco_ann_id, "canonical positive source identity remains exact").to.equal(
      source.objectId,
    );
    const negativeIds = serialized
      .filter((result) => result.id !== sourceKey)
      .map((result) => result.meta?.coco_ann_id);

    expect(new Set(negativeIds).size, "all newly allocated COCO identities are unique").to.equal(negativeIds.length);
    for (const [index, objectId] of negativeIds.entries()) {
      expect(Number.isInteger(objectId), `new COCO identity ${index} is an integer`).to.equal(true);
      expect(objectId, `new COCO identity ${index} is negative`).to.be.lessThan(0);
    }
    for (const result of serialized) {
      expect(result.image_rotation, `terminal image rotation ${result.id}`).to.equal(0);
      expect(result.value?.rotation, `terminal bbox rotation ${result.id}`).to.equal(0);
    }
    const actualOrder = serialized.map((result) => result.id);
    const expectedOrder = serialized
      .map((result, priorOrder) => ({
        bbox: quantizeBbox(result.value),
        id: result.id,
        priorOrder,
      }))
      .sort(
        (left, right) =>
          left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0] || left.priorOrder - right.priorOrder,
      )
      .map((result) => result.id);

    expect(actualOrder, "terminal serialization is stable top-left y/x order").to.deep.equal(expectedOrder);
  });
};

const clickRowAndWaitForManagedTask = (rowIndex: number, taskId: number, requestAlias: string) => {
  cy.intercept({ method: "GET", pathname: `/api/tasks/${taskId}`, query: { project: "1" }, times: 1 }).as(requestAlias);
  cy.get('[data-testid="table-row-wrapper"]').eq(rowIndex).click();
  cy.wait(`@${requestAlias}`).its("response.statusCode").should("equal", 200);
  waitForManagedTaskReady(taskId);
};

const drawUserBox = (label: string, x: number, y: number, width: number, height: number) => {
  let beforeIds = new Set<string>();

  cy.window().then((win) => {
    beforeIds = new Set(wrapper(win).currentAnnotation.regions.map((region: any) => region.cleanId));
  });
  unselectRegions();
  ensureCocoLabelSelected(label);
  dragStageRelative(x, y, width, height);
  return cy
    .window()
    .should((win) => {
      const added = wrapper(win).currentAnnotation.regions.filter((region: any) => !beforeIds.has(region.cleanId));

      expect(added, "one bbox created through label selection and pointer drag").to.have.length(1);
      expect(added[0].labeling?.mainValue, "selected COCO class applied").to.deep.equal([label]);
    })
    .then((win) => {
      const added = wrapper(win).currentAnnotation.regions.filter((region: any) => !beforeIds.has(region.cleanId));

      return added[0].cleanId as string;
    });
};

const selectRegionAt = (x: number, y: number) => {
  selectMoveTool();
  clickStageRelative(x, y);
  selectedOutlinerRegions().should("have.length", 1);
};

const moveSelectedRegion = (x: number, y: number, deltaX: number, deltaY: number) => {
  dragStageRelative(x, y, deltaX, deltaY, { force: true });
};

const resizeSelectedRegion = (deltaX: number, deltaY: number) => {
  let handle:
    | {
        anchorRect: { x: number; y: number; width: number; height: number };
        stageHeight: number;
        stageWidth: number;
        stageX: number;
        stageY: number;
      }
    | undefined;

  cy.window().then(
    (win) =>
      new Cypress.Promise<void>((resolve) => {
        win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve()));
      }),
  );
  cy.window().should((win) => {
    const annotation = wrapper(win).currentAnnotation;
    const selected = annotation.selectedRegions;

    expect(selected, "one region is selected before transformer resize").to.have.length(1);
    const selectedShape = selected[0].shapeRef;
    const selectedParent = selectedShape?.getParent?.();
    const stage = annotation.names.get("image").stageRef;
    const transformers = stage
      .find("Transformer")
      .filter((transformer: any) =>
        (transformer.nodes?.() ?? []).some(
          (node: any) => node === selectedShape || (selectedParent && node === selectedParent),
        ),
      );

    expect(transformers, "one Transformer owns the selected shape or its parent").to.have.length(1);
    const anchor = transformers[0].findOne(".bottom-right");

    expect(anchor, "selected Transformer exposes the standard bottom-right anchor").not.to.equal(undefined);
    expect(anchor.name(), "resize handle is a standard Konva anchor").to.contain("_anchor");
    expect(anchor.draggable(), "resize anchor is draggable").to.equal(true);
    expect(anchor.isVisible(), "resize anchor is visible").to.equal(true);
    const anchorRect = anchor.getClientRect({ relativeTo: stage });

    expect(anchorRect.width, "resize anchor has rendered width").to.be.greaterThan(0);
    expect(anchorRect.height, "resize anchor has rendered height").to.be.greaterThan(0);
    expect(stage.width(), "Konva stage width is measurable").to.be.greaterThan(0);
    expect(stage.height(), "Konva stage height is measurable").to.be.greaterThan(0);
    handle = {
      anchorRect,
      stageHeight: stage.height(),
      stageWidth: stage.width(),
      stageX: anchorRect.x + anchorRect.width / 2,
      stageY: anchorRect.y + anchorRect.height / 2,
    };
  });
  drawingArea().then(($area) => {
    expect(handle, "transformer handle geometry was captured").not.to.equal(undefined);
    const geometry = handle as NonNullable<typeof handle>;
    const bounds = $area[0].getBoundingClientRect();
    const scaleX = bounds.width / geometry.stageWidth;
    const scaleY = bounds.height / geometry.stageHeight;
    const startX = geometry.stageX * scaleX;
    const startY = geometry.stageY * scaleY;
    const mappedAnchor = {
      left: geometry.anchorRect.x * scaleX,
      right: (geometry.anchorRect.x + geometry.anchorRect.width) * scaleX,
      top: geometry.anchorRect.y * scaleY,
      bottom: (geometry.anchorRect.y + geometry.anchorRect.height) * scaleY,
    };

    expect(startX, "pointer starts inside mapped anchor x-range").to.be.within(mappedAnchor.left, mappedAnchor.right);
    expect(startY, "pointer starts inside mapped anchor y-range").to.be.within(mappedAnchor.top, mappedAnchor.bottom);
    cy.wrap($area)
      .scrollIntoView()
      .trigger("mousedown", startX, startY, { eventConstructor: "MouseEvent", buttons: 1 })
      .trigger("mousemove", startX + deltaX * bounds.width, startY + deltaY * bounds.height, {
        eventConstructor: "MouseEvent",
        buttons: 1,
      })
      .trigger("mouseup", startX + deltaX * bounds.width, startY + deltaY * bounds.height, {
        eventConstructor: "MouseEvent",
        buttons: 1,
      });
  });
};

const assertManagedRegionDirty = (regionId: string) => {
  cy.window().should((win) => {
    const lsf = wrapper(win);
    const annotation = lsf.currentAnnotation;

    expect(
      annotation.regions.some((region: any) => region.cleanId === regionId),
      `live region ${regionId}`,
    ).to.equal(true);
    expect(lsf._isManagedAnnotationDirty(annotation), `managed Draft is dirty after ${regionId}`).to.equal(true);
  });
};

const assertRoiGeometry = (expected: { height: number; width: number; x: number; y: number }, tolerance = 0.25) => {
  cy.get(".coordexp-ai-region__roi")
    .should("be.visible")
    .invoke("text")
    .should("match", /\d+\.\d% × \d+\.\d%/);
  cy.window().should((win) => {
    const roi = wrapper(win).currentAnnotation.names.get("image").aiRegion;

    expect(roi.x, "pointer-drawn ROI x").to.be.closeTo(expected.x, tolerance);
    expect(roi.y, "pointer-drawn ROI y").to.be.closeTo(expected.y, tolerance);
    expect(roi.width, "pointer-drawn ROI width").to.be.closeTo(expected.width, tolerance);
    expect(roi.height, "pointer-drawn ROI height").to.be.closeTo(expected.height, tolerance);
  });
};

const setExactRoi = () => {
  cy.contains("button", "Draw ROI").click();
  dragStageRelative(0.2, 0.2, 0.01, 0.01, { force: true });
  assertRoiGeometry({ x: 20, y: 20, width: 1, height: 1 });
};

const inferenceRegions = (win: Cypress.AUTWindow) =>
  wrapper(win).currentAnnotation.regions.filter((region: any) => region.inferencePresentation?.color);

const unselectAll = () => {
  unselectRegions();
  selectedOutlinerRegions().should("not.exist");
};

const serializedInferenceResults = (win: Cypress.AUTWindow) =>
  (wrapper(win).currentAnnotation.serialized as Array<Record<string, any>>).filter(
    (result) => typeof result.meta?.coordexp_inference_receipt_id === "string",
  );

const assertRoiState = (present: boolean) => {
  cy.window().should((win) => {
    const roi = wrapper(win).currentAnnotation.names.get("image").aiRegion;

    if (present) expect(roi, "temporary ROI retained").not.to.equal(null);
    else expect(roi, "temporary ROI cleared").to.equal(null);
  });
};

const setCanvasResolution = ({ width, height }: CanvasResolution) => {
  cy.get('[aria-label="Canvas width"]').clear().type(String(width)).should("have.value", String(width));
  cy.get('[aria-label="Canvas height"]').clear().type(String(height)).should("have.value", String(height));
};

const aiRegionStatus = () => cy.get('[aria-label="AI Region inference"] [role="status"]');

const assertRenderedPresentations = (count: number, expectedBadge: number | null = null) => {
  cy.window().should((win) => {
    const inferred = inferenceRegions(win);
    expect(inferred, "inference regions with volatile presentation").to.have.length(count);
    for (const region of inferred) {
      const presentation = region.inferencePresentation;
      const shape = region.shapeRef;
      expect(shape, `rendered bbox ${region.presentationRegionKey}`).not.to.equal(null);
      expect(shape.getStage(), `mounted bbox ${region.presentationRegionKey}`).not.to.equal(null);
      expect(shape.stroke().toLowerCase(), `rendered stroke ${region.presentationRegionKey}`).to.equal(
        presentation.color.toLowerCase(),
      );
      expect(shape.opacity(), `rendered opacity ${region.presentationRegionKey}`).to.equal(1);
      expect(shape.isVisible(), `rendered visibility ${region.presentationRegionKey}`).to.equal(true);
    }
    if (expectedBadge !== null) {
      const badgeRegion = inferred.find((region: any) => region.inferencePresentation.numericBadge === expectedBadge);
      expect(badgeRegion, `palette-exhaustion model badge ${expectedBadge}`).not.to.equal(undefined);
      const badgeTexts = badgeRegion.shapeRef
        .getLayer()
        .find("Text")
        .filter((node: any) => node.text() === String(expectedBadge));
      expect(badgeTexts, `rendered palette-exhaustion badge ${expectedBadge}`).to.have.length.greaterThan(0);
    }
  });
};

const inferOne = () => {
  setExactRoi();
  cy.contains("button", "Infer").click();
  cy.wait("@roiInfer").its("response.statusCode").should("equal", 200);
  cy.contains("Inserted 1.").should("be.visible");
};

const assertProjectStateContract = (state: Record<string, unknown>) => {
  exactKeys(
    state,
    [
      "version",
      "generation",
      "pending_draft_count",
      "members",
      "active_batch_id",
      "batch_state",
      "active_batch",
      "last_terminal_batch",
    ],
    "project-state response",
  );
  for (const member of state.members as Array<Record<string, unknown>>) {
    exactKeys(
      member,
      [
        "task_id",
        "task_key",
        "draft_id",
        "draft_updated_at",
        "draft_semantic_hash",
        "committed_semantic_hash",
        "pending",
        "draft_ahead_of_committed",
        "active_batch_member",
        "active_batch_semantic_hash",
        "draft_ahead_of_active_batch",
        "last_terminal_batch_member",
        "last_terminal_batch_semantic_hash",
        "draft_matches_last_terminal_batch",
      ],
      "project-state member",
    );
    expect(member.draft_semantic_hash, "Draft member semantic hash").to.match(SHA256);
    expect(member.committed_semantic_hash, "committed member semantic hash").to.match(SHA256);
    for (const optionalHash of [member.active_batch_semantic_hash, member.last_terminal_batch_semantic_hash]) {
      if (optionalHash !== null) expect(optionalHash, "optional member semantic hash").to.match(SHA256);
    }
  }
  const active = state.active_batch as Record<string, unknown> | null;
  if (active) {
    exactKeys(active, ["batch_id", "state", "member_count", "base_generation", "payload_hash"], "active batch");
    expect(active.payload_hash, "active batch payload hash").to.match(SHA256);
  } else {
    expect(state.active_batch_id).to.equal(null);
    expect(state.batch_state, "terminal state must not leak into active-only batch_state").to.equal(null);
  }
  const terminal = state.last_terminal_batch as Record<string, unknown> | null;
  if (terminal) {
    exactKeys(
      terminal,
      [
        "batch_id",
        "state",
        "member_count",
        "base_generation",
        "generation",
        "payload_hash",
        "error",
        "member_task_keys",
      ],
      "terminal batch",
    );
    expect(terminal.payload_hash, "terminal batch payload hash").to.match(SHA256);
    expect(terminal.member_task_keys).to.deep.equal([...(terminal.member_task_keys as string[])].sort());
  }
};

const setupFakeBackend = (backend: FakeRefinementBackend) => {
  cy.intercept(
    { method: "GET", pathname: "/heidi-tips" },
    {
      statusCode: 200,
      body: { authPage: [] },
    },
  ).as("loginTips");
  cy.intercept("GET", /\/api\/label_links\?project=1(?:&|$)/).as("editorLabelLinks");
  const observeDraft = (req: DraftRouteRequest) => {
    const match = new URL(req.url).pathname.match(
      /^\/api\/(?:tasks\/(\d+)(?:\/annotations\/(\d+))?\/drafts|drafts\/(\d+))$/,
    );
    expect(match, `known Draft endpoint ${req.url}`).not.to.equal(null);
    expect(JSON.stringify(req.body)).not.to.match(VISUAL_METADATA);
    if (backend.shouldFailDraftSave(req.body)) {
      req.alias = "newInferenceDraftFailure";
      req.reply({
        statusCode: 503,
        body: { detail: "Synthetic inference Draft save failure." },
      });
      return;
    }
    if (backend.isNewInferenceDraftSaveFailureArmed()) req.alias = "inferenceDraftPreflight";
    req.continue((res) => {
      expect(res.statusCode).to.be.within(200, 299);
      const response = res.body as Record<string, unknown>;
      const taskId = match?.[1] ? Number(match[1]) : Number(response.task);
      const annotationId = match?.[2] ? Number(match[2]) : Number(response.annotation);

      expect(taskId).to.be.oneOf(TASK_IDS);
      expect(annotationId).to.be.oneOf(ANNOTATION_IDS);
      backend.recordDraft(taskId, annotationId, response, req.body);
    });
  };
  cy.intercept("POST", /\/api\/tasks\/\d+\/(?:annotations\/\d+\/)?drafts(?:\?.*)?$/, observeDraft).as("createDraft");
  cy.intercept("PATCH", /\/api\/drafts\/\d+(?:\?.*)?$/, observeDraft).as("updateDraft");
  cy.intercept("/api/projects/1/coordexp-refinement/**", (req) => {
    const url = new URL(req.url);
    const suffix = url.pathname.replace("/api/projects/1/coordexp-refinement", "");
    if (req.method === "GET" && suffix === "/session/") {
      req.reply({ statusCode: 200, body: { csrf_token: "browser-e2e-csrf-token" } });
      return;
    }
    if (req.method === "GET" && suffix === "/project-state/") {
      const state = backend.projectState();
      assertProjectStateContract(state);
      req.reply({ statusCode: 200, body: state });
      return;
    }
    if (req.method === "GET" && suffix === "/roi/profiles/") {
      req.reply({
        statusCode: 200,
        body: {
          profiles: [PROFILE],
        },
      });
      return;
    }
    if (req.method === "POST" && suffix === "/commit/") {
      req.alias = "commitDrafts";
      exactKeys(req.body, ["batch_id"], "Commit body");
      expect(req.headers["x-csrftoken"]).to.equal("browser-e2e-csrf-token");
      req.reply({ statusCode: 202, body: backend.commit(req.body.batch_id) });
      return;
    }
    if (req.method === "POST" && suffix === "/task-lifecycle/") {
      req.alias = "taskLifecycle";
      expect(req.headers["x-csrftoken"], "task-lifecycle uses the production CSRF header").to.equal(
        "browser-e2e-csrf-token",
      );
      const productionRequest = cloneJson(req.body) as Record<string, unknown>;
      const taskId = Number(productionRequest.task_id);

      // Only after asserting the exact production request do we redirect to
      // the disposable fixture's SQLite Draft-CAS persistence seam.
      req.url = new URL(LIFECYCLE_SEAM_PATH, req.url).href;
      req.headers["x-coordexp-browser-e2e-seam"] = LIFECYCLE_SEAM_HEADER;
      delete req.headers["content-length"];
      req.headers["content-type"] = "application/json";
      req.body = backend.lifecycleSeamBody(productionRequest);
      req.continue((res) => {
        expect(res.statusCode, `fixture lifecycle seam persists successfully: ${JSON.stringify(res.body)}`).to.equal(
          200,
        );
        backend.applyLifecycleResponse(taskId, res.body as Record<string, unknown>);
      });
      return;
    }
    if (req.method === "GET" && suffix === "/status/") {
      exactKeys(Object.fromEntries(url.searchParams), ["batch_id"], "status query");
      const batchId = url.searchParams.get("batch_id");
      const batch =
        backend.active?.batchId === batchId
          ? backend.active
          : backend.terminal?.batchId === batchId
            ? backend.terminal
            : null;
      expect(batch, "status only polls a known batch").not.to.equal(null);
      req.reply({ statusCode: 200, body: backend.receipt(batch as Batch) });
      return;
    }
    if (req.method === "POST" && suffix === "/roi/infer/") {
      req.alias = "roiInfer";
      expect(req.headers["x-csrftoken"]).to.equal("browser-e2e-csrf-token");
      req.reply(backend.inference(req.body));
      return;
    }
    if (req.method === "POST" && suffix === "/roi/abandon/") {
      req.alias = "roiAbandon";
      exactKeys(req.body, ["receipt_id", "reason"], "abandon body");
      const requestId = req.body.receipt_id.replace("roi-receipt:", "");
      expect(requestId).to.match(UUID);
      expect(req.body.reason).to.be.oneOf(["user_cancelled", "superseded", "user_discarded"]);
      backend.abandonBodies.push(req.body);
      req.reply({
        statusCode: 200,
        body: {
          receipt_id: req.body.receipt_id,
          request_id: requestId,
          request_state: "abandoned_before_insertion",
          terminal_status: "abandoned_before_insertion",
          clear_roi: false,
          insertion_payload: null,
          failure: { stage: "insertion", code: req.body.reason },
          counts: { parsed: 1, inserted: 0, rejected: 0 },
        },
      });
      return;
    }
    throw new Error(`Unexpected managed fake-backend request: ${req.method} ${url.pathname}${url.search}`);
  }).as("managedBackend");
};

describe("CoordExp managed refinement browser workflow", () => {
  it("keeps Draft, Commit, ROI, presentation, and terminal reconciliation semantics aligned", () => {
    const backend = new FakeRefinementBackend();
    const colorsBeforeReload = new Map<string, string>();
    const colorsBeforeRetirement = new Map<string, string>();
    const badgesBeforeRetirement = new Map<string, number | null>();
    let firstHash = "";
    let firstResultHash = "";
    let manualAId = "";
    let analyticsRequestSeen = false;
    expect(SLOW_INFERENCE_DELAY_MS, "slow inference fixture stays below Cypress requestTimeout").to.be.lessThan(
      Cypress.config("requestTimeout"),
    );
    setupFakeBackend(backend);
    cy.intercept("https://api.vector.co/**", (req) => {
      analyticsRequestSeen = true;
      // Never let an accidental external analytics request delay localhost E2E.
      // The explicit flag assertion below still fails the test instead of stubbing success.
      req.destroy();
    });
    cy.intercept({ method: "GET", pathname: "/api/tasks/1", query: { project: "1" }, times: 1 }).as("initialTask");

    cy.visit("/projects/1/data?task=1");
    cy.get("#email").type("browser-e2e@example.test");
    cy.get("#password").type("browser-e2e-password");
    cy.get('button[type="submit"]').click();
    cy.location("pathname").should("match", /^\/projects\/1\/data\/?$/);
    cy.wait("@initialTask").its("response.statusCode").should("equal", 200);
    cy.wait("@editorLabelLinks").its("response.statusCode").should("equal", 200);
    cy.then(() => expect(analyticsRequestSeen, "login emits no external Vector analytics request").to.equal(false));
    cy.window().should((win) => {
      expect(
        (win as Cypress.AUTWindow & { APP_SETTINGS?: { collect_analytics?: boolean } }).APP_SETTINGS?.collect_analytics,
        "fixture exposes analytics-disabled frontend settings",
      ).to.equal(false);
      const dataManager = (win as Cypress.AUTWindow & { dataManager: any }).dataManager;
      expect(dataManager, "real Data Manager bridge").not.to.equal(undefined);
      expect(Number(dataManager.projectId), "real Data Manager project identity").to.equal(PROJECT_ID);
      expect(dataManager.lsf.project.description, "Data Manager managed-project marker").to.equal(
        "coordexp-refinement-project-identity:browser-e2e:train",
      );
      expect(dataManager.lsf.isManagedRefinementProject, "production managed-project detection").to.equal(true);
    });
    cy.get('[aria-label="CoordExp refinement status"]').should("be.visible");
    cy.get('[aria-label="AI Region inference"]').should("be.visible");
    waitForManagedTaskReady(1);
    assertSeededSourceBbox(1);

    drawUserBox("person", 0.08, 0.08, 0.12, 0.12).then((regionId) => {
      manualAId = regionId;
      assertManagedRegionDirty(regionId);
    });
    cy.intercept({ method: "GET", pathname: "/api/tasks/2", query: { project: "1" }, times: 1 }).as(
      "dirtyRowTaskBLoad",
    );
    cy.get('[data-testid="table-row-wrapper"]').eq(1).click();
    cy.wait("@createDraft").its("response.statusCode").should("equal", 201);
    cy.wait("@dirtyRowTaskBLoad").its("response.statusCode").should("equal", 200);
    waitForManagedTaskReady(2);
    assertSeededSourceBbox(2);
    cy.then(() => {
      const first = backend.drafts.get(1);

      expect(first, "dirty row navigation waited for Task A durable Draft").not.to.equal(undefined);
      firstHash = first?.hash ?? "";
      firstResultHash = first?.resultHash ?? "";
    });
    clickRowAndWaitForManagedTask(0, 1, "returnTaskAForUserEdit");
    selectRegionAt(0.14, 0.14);
    let beforeResize = { width: 0, height: 0 };
    cy.window().then((win) => {
      const annotation = wrapper(win).currentAnnotation;
      const region = annotation.regions.find((candidate: any) => candidate.cleanId === manualAId);

      expect(region, "pointer-selected manual bbox").not.to.equal(undefined);
      expect(annotation.selectedRegions, "manual bbox is selected before transformer resize").to.have.length(1);
      expect(annotation.selectedRegions[0].cleanId, "selected manual bbox is the resize target").to.equal(manualAId);
      beforeResize = { width: region.width, height: region.height };
      resizeSelectedRegion(0.04, 0.03);
    });
    cy.window().should((win) => {
      const annotation = wrapper(win).currentAnnotation;
      const region = annotation.regions.find((candidate: any) => candidate.cleanId === manualAId);

      expect(annotation.selectedRegions, "manual bbox stays selected after transformer resize").to.have.length(1);
      expect(annotation.selectedRegions[0].cleanId, "resized manual bbox stays selected").to.equal(manualAId);
      expect(region.width, "transformer pointer resize changes width").to.be.greaterThan(beforeResize.width);
      expect(region.height, "transformer pointer resize changes height").to.be.greaterThan(beforeResize.height);
    });
    let beforeMove = { x: 0, y: 0 };
    cy.window().then((win) => {
      const region = wrapper(win).currentAnnotation.regions.find((candidate: any) => candidate.cleanId === manualAId);
      beforeMove = { x: region.x, y: region.y };
      moveSelectedRegion((region.x + region.width / 2) / 100, (region.y + region.height / 2) / 100, 0.03, 0.02);
    });
    cy.window().should((win) => {
      const region = wrapper(win).currentAnnotation.regions.find((candidate: any) => candidate.cleanId === manualAId);
      expect([region.x, region.y], "pointer drag moves the manual bbox").not.to.deep.equal([
        beforeMove.x,
        beforeMove.y,
      ]);
    });
    selectCocoLabel("bicycle");
    cy.window().should((win) => {
      const region = wrapper(win).currentAnnotation.regions.find((candidate: any) => candidate.cleanId === manualAId);
      expect(region.hasLabel("bicycle"), "selected bbox relabeled through the COCO label UI").to.equal(true);
    });
    deleteSelectedRegion();
    cy.window().should((win) => {
      expect(
        wrapper(win).currentAnnotation.regions.some((candidate: any) => candidate.cleanId === manualAId),
        "selected bbox deleted through Backspace",
      ).to.equal(false);
    });
    cy.get('[data-testid="bottombar-undo-button"]').should("be.enabled").click();
    cy.window().should((win) => {
      const restored = wrapper(win).currentAnnotation.regions.find((candidate: any) => candidate.cleanId === manualAId);
      expect(restored, "one visible Undo restores the deleted bbox").not.to.equal(undefined);
      expect(restored.hasLabel("bicycle"), "Undo restores the relabeled bbox").to.equal(true);
    });
    cy.intercept({ method: "GET", pathname: "/api/tasks/2", query: { project: "1" }, times: 1 }).as(
      "editedRowTaskBLoad",
    );
    cy.get('[data-testid="table-row-wrapper"]').eq(1).click();
    cy.wait("@updateDraft").its("response.statusCode").should("equal", 200);
    cy.wait("@editedRowTaskBLoad").its("response.statusCode").should("equal", 200);
    waitForManagedTaskReady(2);
    cy.then(() => {
      const edited = backend.drafts.get(1);

      expect(edited, "edited durable Draft recorded").not.to.equal(undefined);
      expect(edited?.hash, "bbox edit changes semantic hash").not.to.equal(firstHash);
      expect(edited?.resultHash, "bbox edit changes full result hash").not.to.equal(firstResultHash);
      expect(edited?.hash).to.match(SHA256);
      expect(edited?.resultHash).to.match(SHA256);
    });

    drawUserBox("person", 0.15, 0.15, 0.12, 0.12);
    cy.contains("button", "Commit Drafts").click();
    cy.wait("@commitDrafts").its("response.statusCode").should("equal", 202);
    cy.contains("Batch queued durably").should("be.visible");
    cy.wrap(null).then(() => expect(backend.active?.state, "202 keeps worker active").to.equal("queued"));
    cy.then(() => backend.markActiveRunning());
    cy.get('[aria-label="Active batch"]').should("contain.text", "State: Running");

    clickRowAndWaitForManagedTask(0, 1, "returnTaskALoad");
    let taskANewerDraftRegionId = "";
    drawUserBox("person", 0.28, 0.28, 0.12, 0.12).then((regionId) => {
      taskANewerDraftRegionId = regionId;
      assertManagedRegionDirty(regionId);
    });
    cy.intercept({ method: "GET", pathname: "/api/tasks/2", query: { project: "1" }, times: 1 }).as("returnTaskBLoad");
    cy.get('[data-testid="table-row-wrapper"]').eq(1).click();
    cy.wait("@updateDraft").its("response.statusCode").should("equal", 200);
    cy.wait("@returnTaskBLoad").its("response.statusCode").should("equal", 200);
    waitForManagedTaskReady(2);
    let taskBNewerLocalId = "";
    let taskBNewerUndoIndex = -1;
    drawUserBox("person", 0.57, 0.52, 0.07, 0.07).then((regionId) => {
      taskBNewerLocalId = regionId;
      cy.window().then((win) => {
        taskBNewerUndoIndex = wrapper(win).currentAnnotation.history.undoIdx;
      });
    });
    cy.wrap(null).then(() => backend.finishActiveSuccess());
    cy.wait(1800);
    cy.wrap(null).should(() => {
      expect(
        backend.lifecycleRequests.some((request) => request.action === "inspect" && request.task_id === 2),
        "terminal success inspects, rather than rebases, a newer loaded Draft",
      ).to.equal(true);
      expect(backend.lifecycleDispositions, "newer terminal lifecycle is metadata-only").to.include("metadata_only");
    });
    cy.window().should((win) => {
      const annotation = wrapper(win).currentAnnotation;

      expect(
        annotation.regions.some((region: any) => region.cleanId === taskBNewerLocalId),
        "metadata-only terminal handling preserves newer local semantics",
      ).to.equal(true);
      expect(annotation.history.undoIdx, "metadata-only terminal handling preserves newer undo history").to.equal(
        taskBNewerUndoIndex,
      );
    });
    cy.get('[aria-label="CoordExp refinement status"]').should("contain.text", "Draft");
    cy.get('[aria-label="CoordExp refinement status"]').should("contain.text", "Pending Drafts: 2");

    cy.window().then((win) => wrapper(win).currentAnnotation.saveDraft());
    cy.wait("@updateDraft").its("response.statusCode").should("equal", 200);
    clickRowAndWaitForManagedTask(0, 1, "firstTerminalTaskAInspection");
    cy.window().should((win) => {
      expect(
        wrapper(win).currentAnnotation.regions.some((region: any) => region.cleanId === taskANewerDraftRegionId),
        "first-terminal metadata-only handling preserves Task A's durable newer Draft",
      ).to.equal(true);
    });
    clickRowAndWaitForManagedTask(1, 2, "firstTerminalReturnTaskB");
    cy.window().should((win) => {
      expect(
        wrapper(win).currentAnnotation.regions.some((region: any) => region.cleanId === taskBNewerLocalId),
        "first-terminal metadata-only handling preserves Task B's now-durable newer Draft",
      ).to.equal(true);
    });

    cy.get('[aria-label="Canvas width"]').should("have.value", "1024");
    cy.get('[aria-label="Canvas height"]').should("have.value", "1024");
    cy.then(() => backend.setInferenceMode("produced"));
    for (let index = 0; index < 9; index += 1) inferOne();

    unselectAll();
    assertRenderedPresentations(9, 9);
    cy.window().then((win) => {
      const inferred = inferenceRegions(win);
      expect(new Set(inferred.map((region: any) => region.inferencePresentation.color)).size).to.equal(8);
      for (const region of inferred) {
        colorsBeforeReload.set(region.presentationRegionKey, region.inferencePresentation.color);
      }
      const focused = inferred[0];
      selectRegionAt((focused.x + focused.width / 2) / 100, (focused.y + focused.height / 2) / 100);
    });

    cy.get('[aria-label="Dense Focus"]').contains("button", "Dim non-selected").click();
    cy.get('[aria-label="Dense Focus"] button[aria-pressed="true"]').should("contain.text", "Dim non-selected");
    cy.window().should((win) => {
      const annotation = wrapper(win).currentAnnotation;
      const inferred = inferenceRegions(win);
      expect(annotation.selectedRegions).to.have.length(1);
      for (const region of inferred) {
        const expectedOpacity = region.inSelection ? 1 : 0.25;
        expect(region.presentationOpacity, `model opacity ${region.presentationRegionKey}`).to.equal(expectedOpacity);
        expect(region.shapeRef.opacity(), `rendered opacity ${region.presentationRegionKey}`).to.equal(expectedOpacity);
      }
    });

    cy.get('[aria-label="Dense Focus"]').contains("button", "Hide non-selected").click();
    cy.get('[aria-label="Dense Focus"] button[aria-pressed="true"]').should("contain.text", "Hide non-selected");
    cy.window().should((win) => {
      const inferred = inferenceRegions(win);
      for (const region of inferred) {
        expect(region.presentationHidden, `model visibility ${region.presentationRegionKey}`).to.equal(
          !region.inSelection,
        );
        if (region.inSelection) {
          expect(
            region.shapeRef.getStage(),
            `focused bbox ${region.presentationRegionKey} remains rendered`,
          ).not.to.equal(null);
        } else {
          expect(
            region.shapeRef.getStage(),
            `hidden bbox ${region.presentationRegionKey} is removed from the stage`,
          ).to.be.oneOf([null, undefined]);
        }
      }
    });

    cy.get('[aria-label="Dense Focus"]').contains("button", "Show all").click();
    cy.get('[aria-label="Dense Focus"] button[aria-pressed="true"]').should("contain.text", "Show all");
    unselectAll();
    assertRenderedPresentations(9, 9);

    reloadManagedTask(2);
    unselectAll();
    cy.window().should((win) => {
      const inferred = inferenceRegions(win);
      const serialized = serializedInferenceResults(win);
      expect(inferred).to.have.length(9);
      expect(serialized, "all inference results retain durable provenance after reload").to.have.length(9);
      for (const region of inferred) {
        expect(
          region.inferencePresentation.color,
          `deterministic reload color ${region.presentationRegionKey}`,
        ).to.equal(colorsBeforeReload.get(region.presentationRegionKey));
      }
      for (const result of serialized) {
        exactKeys(
          result.meta,
          [
            "coordexp_region_key",
            "coordexp_inference_receipt_id",
            "coordexp_inference_request_id",
            "coordexp_inference_result_id",
            "coordexp_inference_source_draft_revision",
          ],
          `inference provenance ${result.id}`,
        );
        expect(result.meta.coordexp_region_key, "serialized region link").to.equal(result.id);
        expect(result.meta.coordexp_inference_receipt_id, "receipt/request link").to.equal(
          `roi-receipt:${result.meta.coordexp_inference_request_id}`,
        );
        expect(result.meta.coordexp_inference_result_id, "service result link").to.be.a("string").and.not.be.empty;
        expect(result.meta.coordexp_inference_source_draft_revision, "frozen Draft revision link").to.be.a("string").and
          .not.be.empty;
      }
    });
    assertRenderedPresentations(9, 9);
    cy.wrap(null).then(() => {
      expect(backend.draftBodies.length).to.be.greaterThan(3);
      expect(JSON.stringify(backend.draftBodies)).not.to.match(VISUAL_METADATA);
    });

    cy.then(() => backend.setInferenceMode("produced", { delay: SLOW_INFERENCE_DELAY_MS }));
    setExactRoi();
    cy.contains("button", "Infer").click();
    cy.wrap(null).should(() => expect(backend.inferCount, "delayed inference reached the fake worker").to.equal(10));
    cy.contains("button", /^Cancel$/).should("be.enabled");
    cy.contains("button", /^Cancel$/).click();
    cy.wait("@roiAbandon").its("response.statusCode").should("equal", 200);
    cy.wait("@roiInfer").its("response.statusCode").should("equal", 200);
    cy.contains(/abandoned before insertion/i).should("be.visible");
    cy.wrap(null).then(() =>
      expect(backend.abandonBodies.some((body) => body.reason === "user_cancelled")).to.equal(true),
    );

    cy.window().then((win) => {
      for (const region of inferenceRegions(win)) {
        colorsBeforeRetirement.set(region.presentationRegionKey, region.inferencePresentation.color);
        badgesBeforeRetirement.set(region.presentationRegionKey, region.inferencePresentation.numericBadge ?? null);
      }
      expect(colorsBeforeRetirement.size).to.equal(9);
      expect([...badgesBeforeRetirement.values()], "palette badge 9 is captured before Commit").to.include(9);
    });
    cy.contains("button", "Commit Drafts").click();
    cy.wait("@commitDrafts").its("response.statusCode").should("equal", 202);
    cy.contains("Batch queued durably").should("be.visible");
    cy.wrap(null).then(() => {
      expect(backend.active?.memberCount, "inference-assisted Commit captures both task Drafts").to.equal(2);
      expect([...(backend.active?.captured.keys() ?? [])].sort(), "captured task identities").to.deep.equal([1, 2]);
    });
    let taskBPostEnqueueRegionId = "";
    let taskBPostEnqueueUndoIndex = -1;
    drawUserBox("person", 0.44, 0.44, 0.08, 0.08).then((regionId) => {
      taskBPostEnqueueRegionId = regionId;
      assertManagedRegionDirty(regionId);
      cy.window().then((win) => {
        taskBPostEnqueueUndoIndex = wrapper(win).currentAnnotation.history.undoIdx;
      });
    });
    cy.window().then((win) => wrapper(win).currentAnnotation.saveDraft());
    cy.wait("@updateDraft").its("response.statusCode").should("equal", 200);
    cy.window().should((win) => {
      expect(
        wrapper(win).currentAnnotation.history.undoIdx,
        "durable post-enqueue Draft save does not reset undo history",
      ).to.equal(taskBPostEnqueueUndoIndex);
    });
    cy.wrap(null).then(() => {
      const activeHash = backend.active?.captured.get(2);
      const newerHash = backend.drafts.get(2)?.hash;
      expect(newerHash, "post-enqueue Task 2 Draft saved").to.match(SHA256);
      expect(newerHash, "post-enqueue Task 2 Draft remains newer than frozen batch member").not.to.equal(activeHash);
    });
    cy.wrap(null).then(() => backend.finishActiveSuccess());
    cy.wait(1800);
    cy.wrap(null).should(() => {
      expect(
        backend.lifecycleOutcomes.some(
          (outcome) => outcome.taskId === 2 && outcome.action === "inspect" && outcome.disposition === "metadata_only",
        ),
        "loaded Task 2 newer Draft receives inspect/metadata_only terminal handling",
      ).to.equal(true);
    });
    cy.get('[aria-label="CoordExp refinement status"]').should("contain.text", "Draft");
    cy.get('[aria-label="CoordExp refinement status"]').should("contain.text", "Pending Drafts: 2");
    cy.window().should((win) => {
      const annotation = wrapper(win).currentAnnotation;
      const inferred = inferenceRegions(win);

      expect(
        annotation.regions.some((region: any) => region.cleanId === taskBPostEnqueueRegionId),
        "metadata-only terminal handling preserves the newer Task 2 semantic edit",
      ).to.equal(true);
      expect(annotation.history.undoIdx, "metadata-only terminal handling preserves newer undo history").to.equal(
        taskBPostEnqueueUndoIndex,
      );
      expect(inferred, "metadata-only terminal handling preserves all inference presentations").to.have.length(9);
      for (const region of inferred) {
        expect(region.inferencePresentation.color, `preserved model color ${region.presentationRegionKey}`).to.equal(
          colorsBeforeRetirement.get(region.presentationRegionKey),
        );
        expect(
          region.inferencePresentation.numericBadge ?? null,
          `preserved model badge ${region.presentationRegionKey}`,
        ).to.equal(badgesBeforeRetirement.get(region.presentationRegionKey));
      }
    });
    assertRenderedPresentations(9, 9);

    reloadManagedTask(2);
    cy.get('[aria-label="CoordExp refinement status"]').should("contain.text", "Draft");
    cy.get('[aria-label="CoordExp refinement status"]').should("contain.text", "Pending Drafts: 1");
    cy.window().should((win) => {
      const annotation = wrapper(win).currentAnnotation;
      const inferred = inferenceRegions(win);
      const status = wrapper(win).getManagedStatusState();
      const member = status.authority?.members?.find((candidate: any) => Number(candidate.task_id) === 2);

      expect(
        annotation.regions.some((region: any) => region.cleanId === taskBPostEnqueueRegionId),
        "reloaded durable newer Draft retains its post-enqueue edit",
      ).to.equal(true);
      expect(status.taskSemanticState, "reloaded newer Task 2 remains Draft").to.equal("Draft");
      expect(member, "reloaded newer Task 2 remains ahead of committed").to.include({
        pending: true,
        draft_ahead_of_committed: true,
        draft_matches_last_terminal_batch: false,
      });
      expect(inferred, "reloaded newer Draft restores all inference presentations").to.have.length(9);
      for (const region of inferred) {
        expect(region.inferencePresentation.color, `reloaded newer color ${region.presentationRegionKey}`).to.equal(
          colorsBeforeRetirement.get(region.presentationRegionKey),
        );
        expect(
          region.inferencePresentation.numericBadge ?? null,
          `reloaded newer badge ${region.presentationRegionKey}`,
        ).to.equal(badgesBeforeRetirement.get(region.presentationRegionKey));
      }
    });
    assertRenderedPresentations(9, 9);

    clickRowAndWaitForManagedTask(0, 1, "secondTerminalTaskAReconcile");
    cy.wrap(null).should(() => {
      expect(
        backend.lifecycleOutcomes.some(
          (outcome) => outcome.taskId === 1 && outcome.action === "reconcile" && outcome.disposition === "rebased",
        ),
        "the exact unloaded Task 1 member is reconciled before the next Commit",
      ).to.equal(true);
    });
    clickRowAndWaitForManagedTask(1, 2, "secondTerminalReturnTaskB");
    cy.get('[aria-label="CoordExp refinement status"]').should("contain.text", "Draft");
    cy.get('[aria-label="CoordExp refinement status"]').should("contain.text", "Pending Drafts: 1");
    cy.window().should((win) => {
      const annotation = wrapper(win).currentAnnotation;

      expect(
        annotation.regions.some((region: any) => region.cleanId === taskBPostEnqueueRegionId),
        "Task 2 newer semantics survive the Task 1 reconciliation round trip",
      ).to.equal(true);
    });
    assertRenderedPresentations(9, 9);

    cy.contains("button", "Commit Drafts").click();
    cy.wait("@commitDrafts").its("response.statusCode").should("equal", 202);
    cy.contains("Batch queued durably").should("be.visible");
    cy.wrap(null).then(() => {
      expect(backend.active?.memberCount, "exact retirement Commit captures only newer Task 2").to.equal(1);
      expect([...(backend.active?.captured.keys() ?? [])], "exact retirement member identity").to.deep.equal([2]);
      backend.finishActiveSuccess();
    });
    cy.wait(1800);
    cy.wrap(null).should(() => {
      expect(
        backend.lifecycleOutcomes.some(
          (outcome) => outcome.taskId === 2 && outcome.action === "reconcile" && outcome.disposition === "rebased",
        ),
        "exact Task 2 terminal lifecycle persists a Draft rebase",
      ).to.equal(true);
    });
    cy.get('[aria-label="CoordExp refinement status"]').should("contain.text", "Committed");
    cy.window().then((win) => {
      const inferencePresentations = wrapper(win)
        .currentAnnotation.regions.map((region: any) => region.inferencePresentation)
        .filter(Boolean);
      expect(inferencePresentations, "matching terminal Draft retires volatile colors").to.deep.equal([]);
    });
    reloadManagedTask(2);
    waitForTerminalPresentationRetirement(2, "train:2");
    assertSeededSourceBbox(2);
    assertTerminalSerializedContract(2);
    unselectAll();
    cy.window().should((win) => {
      const annotation = wrapper(win).currentAnnotation;
      const retired = annotation.regions.filter((region: any) =>
        colorsBeforeRetirement.has(region.presentationRegionKey),
      );
      expect(retired, "all inference-origin regions survive terminal reload").to.have.length(9);
      for (const region of retired) {
        expect(region.inferencePresentation, `retired model color ${region.presentationRegionKey}`).to.equal(null);
        expect(
          region.shapeRef.getStage(),
          `retired bbox ${region.presentationRegionKey} remains rendered`,
        ).not.to.equal(null);
        expect(region.shapeRef.isVisible(), `retired bbox ${region.presentationRegionKey} is visible`).to.equal(true);
        expect(region.shapeRef.opacity(), `retired bbox ${region.presentationRegionKey} is opaque`).to.equal(1);
        expect(
          region.shapeRef.stroke().toLowerCase(),
          `retired rendered stroke ${region.presentationRegionKey}`,
        ).not.to.equal(colorsBeforeRetirement.get(region.presentationRegionKey)?.toLowerCase());
      }
      const remainingBadges = retired[0].shapeRef
        .getLayer()
        .find("Text")
        .filter((node: any) => node.text() === "9");
      expect(remainingBadges, "terminal reload removes rendered palette badge").to.have.length(0);
    });

    let baselineInferenceCount = 0;
    let baselineRegionCount = 0;
    cy.window().then((win) => {
      baselineInferenceCount = serializedInferenceResults(win).length;
      baselineRegionCount = wrapper(win).currentAnnotation.regions.length;
    });
    cy.contains("button", "Draw ROI").click();
    dragStageRelative(0.1, 0.1, 0.08, 0.08, { force: true });
    assertRoiGeometry({ x: 10, y: 10, width: 8, height: 8 }, 0.3);
    dragStageRelative(0.2, 0.2, 0.01, 0.01, { force: true });
    assertRoiGeometry({ x: 20, y: 20, width: 1, height: 1 });
    cy.window().should((win) => {
      const annotation = wrapper(win).currentAnnotation;
      const roi = annotation.names.get("image").aiRegion;
      expect(serializedInferenceResults(win), "ROI redraw does not mutate annotations").to.have.length(
        baselineInferenceCount,
      );
      expect(annotation.regions, "ROI redraw leaves the full annotation object list unchanged").to.have.length(
        baselineRegionCount,
      );
      expect(roi.x, "later pointer drag replaces ROI x").to.be.closeTo(20, 0.2);
      expect(roi.y, "later pointer drag replaces ROI y").to.be.closeTo(20, 0.2);
    });

    setCanvasResolution({ width: 1279, height: 768 });
    cy.contains("Width and height must be divisible by 32.").should("be.visible");
    cy.contains("button", "Infer").should("be.disabled");
    setCanvasResolution(RECTANGULAR_RESOLUTION);
    cy.contains("Width and height must be divisible by 32.").should("not.exist");
    let submittedRectangularRoi: { x: number; y: number; width: number; height: number } | null = null;
    let slowInferCount = 0;
    let blockedTaskRequestSeen = false;
    cy.intercept({ method: "GET", pathname: "/api/tasks/1", query: { project: "1" } }, (req) => {
      blockedTaskRequestSeen = true;
      req.continue();
    });
    cy.window().then((win) => {
      const roi = wrapper(win).currentAnnotation.names.get("image").aiRegion;

      submittedRectangularRoi = { x: roi.x, y: roi.y, width: roi.width, height: roi.height };
    });
    cy.then(() => {
      slowInferCount = backend.inferCount;
      // Simulate a bounded slow inference window for lock assertions. This is
      // backend response latency, not a cy.wait, and remains below requestTimeout.
      backend.setInferenceMode("produced", {
        delay: SLOW_INFERENCE_DELAY_MS,
        resolution: RECTANGULAR_RESOLUTION,
      });
    });
    cy.contains("button", "Infer").click();
    cy.wrap(null).should(() => {
      expect(backend.inferCount, "one rectangular request reaches the fake service").to.equal(slowInferCount + 1);
    });
    cy.get('[aria-label="Inference profile"]').should("be.disabled");
    cy.get('[aria-label="Canvas width"]').should("be.disabled");
    cy.get('[aria-label="Canvas height"]').should("be.disabled");
    cy.contains("button", /^Drawing ROI$/).should("be.disabled");
    cy.contains("button", "Infer").should("not.exist");
    cy.contains("button", /^Cancel$/).should("be.enabled");
    cy.get('[data-testid="table-row-wrapper"]').eq(0).click();
    cy.contains("Wait for the current AI Region inference before leaving this annotation.").should("be.visible");
    cy.location("search").should("contain", "task=2");
    cy.wrap(null).then(() =>
      expect(blockedTaskRequestSeen, "running ROI blocks Data Manager navigation").to.equal(false),
    );
    cy.wait("@roiInfer").then((interception) => {
      expect(submittedRectangularRoi, "selected rectangular ROI was captured before submission").not.to.equal(null);
      expect(interception.request.body.roi, "ROI request preserves the exact selected editor ROI").to.deep.equal(
        submittedRectangularRoi,
      );
      expect(interception.response?.statusCode).to.equal(200);
    });
    cy.contains("button", /^Draw ROI$/).should("be.enabled");
    aiRegionStatus().should("contain.text", "Inserted 1.");
    assertRoiState(false);
    cy.window().should((win) => {
      expect(serializedInferenceResults(win), "rectangular result appends after prior ROI results").to.have.length(
        baselineInferenceCount + 1,
      );
    });

    setCanvasResolution(DEFAULT_RESOLUTION);
    let beforeAtomicPair = 0;
    cy.window().then((win) => {
      beforeAtomicPair = serializedInferenceResults(win).length;
    });
    cy.then(() => backend.setInferenceMode("produced_pair"));
    setExactRoi();
    cy.contains("button", "Infer").click();
    cy.wait("@roiInfer").its("response.statusCode").should("equal", 200);
    aiRegionStatus().should("contain.text", "Inserted 2.").and("contain.text", "Potential duplicate pairs:");
    cy.window().should((win) => {
      expect(serializedInferenceResults(win), "both overlapping results are inserted without NMS").to.have.length(
        beforeAtomicPair + 2,
      );
    });
    cy.get('[data-testid="bottombar-undo-button"]').should("be.enabled").click();
    cy.window().should((win) => {
      expect(serializedInferenceResults(win), "one Undo removes the whole insertion action").to.have.length(
        beforeAtomicPair,
      );
    });

    const outcomes: Array<{
      clearRoi: boolean;
      delta: number;
      message: string;
      mode: InferenceMode;
      statusCode: number;
    }> = [
      { mode: "partial", delta: 1, clearRoi: true, statusCode: 200, message: "Inserted 1; 1 dropped." },
      { mode: "empty", delta: 0, clearRoi: true, statusCode: 200, message: "No objects found in this ROI." },
      {
        mode: "all_rejected",
        delta: 0,
        clearRoi: true,
        statusCode: 200,
        message: "All 2 results were rejected.",
      },
      {
        mode: "all_spans_dropped",
        delta: 0,
        clearRoi: false,
        statusCode: 200,
        message: "ROI inference failed (response_failure).",
      },
      {
        mode: "unsupported_format",
        delta: 0,
        clearRoi: false,
        statusCode: 200,
        message: "ROI inference failed (response_failure).",
      },
      {
        mode: "runtime_failure",
        delta: 0,
        clearRoi: false,
        statusCode: 200,
        message: "ROI inference failed (runtime_failure).",
      },
      {
        mode: "timeout_failure",
        delta: 0,
        clearRoi: false,
        statusCode: 200,
        message: "ROI inference failed (timeout_failure).",
      },
      {
        mode: "profile_failure",
        delta: 0,
        clearRoi: false,
        statusCode: 200,
        message: "ROI inference failed (profile_failure).",
      },
      {
        mode: "transport_failure",
        delta: 0,
        clearRoi: false,
        statusCode: 503,
        message: "Synthetic transport failure.",
      },
    ];

    for (const outcome of outcomes) {
      let beforeOutcome = 0;
      cy.window().then((win) => {
        beforeOutcome = serializedInferenceResults(win).length;
      });
      cy.then(() => backend.setInferenceMode(outcome.mode));
      setExactRoi();
      cy.contains("button", "Infer").click();
      cy.wait("@roiInfer").its("response.statusCode").should("equal", outcome.statusCode);
      aiRegionStatus().should("contain.text", outcome.message);
      cy.window().should((win) => {
        expect(serializedInferenceResults(win), `${outcome.mode} annotation delta`).to.have.length(
          beforeOutcome + outcome.delta,
        );
      });
      assertRoiState(!outcome.clearRoi);
    }

    let beforeSaveRetry = 0;
    cy.window().then((win) => {
      beforeSaveRetry = serializedInferenceResults(win).length;
    });
    cy.then(() => {
      backend.armNewInferenceDraftSaveFailure();
      expect(backend.isNewInferenceDraftSaveFailureArmed(), "new-receipt Draft failure is armed").to.equal(true);
      backend.setInferenceMode("produced");
    });
    assertRoiState(true);
    cy.contains("button", "Infer").click();
    cy.wait("@inferenceDraftPreflight").its("response.statusCode").should("be.within", 200, 299);
    cy.then(() =>
      expect(
        backend.isNewInferenceDraftSaveFailureArmed(),
        "unchanged pre-inference Draft does not consume the new-receipt failure",
      ).to.equal(true),
    );
    cy.wait("@roiInfer").its("response.statusCode").should("equal", 200);
    cy.wait("@newInferenceDraftFailure").its("response.statusCode").should("equal", 503);
    cy.get(".lsf-modal-ls:visible")
      .should("contain.text", "Runtime error")
      .and("contain.text", "Synthetic inference Draft save failure.");
    cy.get('.lsf-modal-ls:visible button[aria-label="Close modal"]').should("be.visible").click();
    cy.get(".lsf-modal-ls:visible").should("not.exist");
    let successfulDraftCountBeforeRetry = 0;
    cy.then(() => {
      expect(
        backend.isNewInferenceDraftSaveFailureArmed(),
        "post-insertion Draft with a new receipt consumes the failure",
      ).to.equal(false);
      successfulDraftCountBeforeRetry = backend.draftBodies.length;
    });
    aiRegionStatus().should("contain.text", "Boxes were inserted, but Draft save failed:");
    cy.contains("button", "Retry Draft save").should("be.enabled");
    assertRoiState(true);
    cy.window().should((win) => {
      expect(serializedInferenceResults(win), "save failure retains inserted boxes for exact retry").to.have.length(
        beforeSaveRetry + 1,
      );
    });
    cy.contains("button", "Retry Draft save").click();
    aiRegionStatus().should("contain.text", "Inserted 1.");
    cy.wrap(null).should(() =>
      expect(backend.draftBodies.length, "Retry writes one successful authoritative Draft").to.equal(
        successfulDraftCountBeforeRetry + 1,
      ),
    );
    assertRoiState(false);

    let editedInferenceKey = "";
    cy.then(() => {
      const editedInferenceBbox = backend.lastProducedBboxes[0];

      selectRegionAt(
        (editedInferenceBbox[0] + editedInferenceBbox[2]) / (2 * 999),
        (editedInferenceBbox[1] + editedInferenceBbox[3]) / (2 * 999),
      );
    });
    cy.window().should((win) => {
      const annotation = wrapper(win).currentAnnotation;
      const selected = annotation.selectedRegions;

      expect(selected, "pointer selects one inference result from the overlap cluster").to.have.length(1);
      const selectedRegion = selected[0];
      const serialized = (annotation.serialized as Array<Record<string, any>>).find(
        (result) => result.id === selectedRegion.cleanId,
      );
      const receiptId = serialized?.meta?.coordexp_inference_receipt_id;
      const hasInferenceOrigin =
        Boolean(selectedRegion.inferencePresentation) || (typeof receiptId === "string" && receiptId.length > 0);

      expect(hasInferenceOrigin, "pointer-selected overlap region has inference provenance").to.equal(true);
      editedInferenceKey = selectedRegion.cleanId;
    });
    let inferenceSizeBeforeResize = { width: 0, height: 0 };
    cy.window().then((win) => {
      const annotation = wrapper(win).currentAnnotation;
      const region = annotation.regions.find((candidate: any) => candidate.cleanId === editedInferenceKey);

      expect(annotation.selectedRegions, "inferred bbox is selected before transformer resize").to.have.length(1);
      expect(annotation.selectedRegions[0].cleanId, "selected inferred bbox is the resize target").to.equal(
        editedInferenceKey,
      );
      inferenceSizeBeforeResize = { width: region.width, height: region.height };
      resizeSelectedRegion(0.03, 0.03);
    });
    cy.window().should((win) => {
      const annotation = wrapper(win).currentAnnotation;
      const region = annotation.regions.find((candidate: any) => candidate.cleanId === editedInferenceKey);

      expect(annotation.selectedRegions, "inferred bbox stays selected after transformer resize").to.have.length(1);
      expect(annotation.selectedRegions[0].cleanId, "resized inferred bbox stays selected").to.equal(
        editedInferenceKey,
      );
      expect(region.width, "inferred bbox accepts transformer width resize").to.be.greaterThan(
        inferenceSizeBeforeResize.width,
      );
      expect(region.height, "inferred bbox accepts transformer height resize").to.be.greaterThan(
        inferenceSizeBeforeResize.height,
      );
    });
    let inferencePositionBeforeMove = { x: 0, y: 0 };
    cy.window().then((win) => {
      const region = wrapper(win).currentAnnotation.regions.find(
        (candidate: any) => candidate.cleanId === editedInferenceKey,
      );
      inferencePositionBeforeMove = { x: region.x, y: region.y };
      moveSelectedRegion((region.x + region.width / 2) / 100, (region.y + region.height / 2) / 100, 0.02, 0.02);
    });
    cy.window().should((win) => {
      const region = wrapper(win).currentAnnotation.regions.find(
        (candidate: any) => candidate.cleanId === editedInferenceKey,
      );
      expect([region.x, region.y], "pointer drag moves the inferred bbox").not.to.deep.equal([
        inferencePositionBeforeMove.x,
        inferencePositionBeforeMove.y,
      ]);
    });
    selectCocoLabel("bicycle");
    cy.window().should((win) => {
      const region = wrapper(win).currentAnnotation.regions.find(
        (candidate: any) => candidate.cleanId === editedInferenceKey,
      );
      expect(region.hasLabel("bicycle"), "inferred bbox accepts direct COCO relabel").to.equal(true);
      const serialized = (wrapper(win).currentAnnotation.serialized as Array<Record<string, any>>).find(
        (result) => result.id === editedInferenceKey,
      );
      expect(serialized?.meta?.coordexp_inference_receipt_id, "receipt linkage survives direct edit").to.be.a("string");
    });
    deleteSelectedRegion();
    cy.window().should((win) => {
      expect(
        wrapper(win).currentAnnotation.regions.some((candidate: any) => candidate.cleanId === editedInferenceKey),
        "inferred bbox accepts direct delete",
      ).to.equal(false);
    });
    cy.get('[data-testid="bottombar-undo-button"]').should("be.enabled").click();
    cy.window().should((win) => {
      const restored = wrapper(win).currentAnnotation.regions.find(
        (candidate: any) => candidate.cleanId === editedInferenceKey,
      );
      expect(restored, "Undo restores directly deleted inference bbox").not.to.equal(undefined);
      expect(restored.hasLabel("bicycle"), "restored inference bbox retains reviewer relabel").to.equal(true);
    });

    let beforeMismatch = 0;
    cy.window().then((win) => {
      beforeMismatch = serializedInferenceResults(win).length;
    });
    cy.then(() => backend.setInferenceMode("target_mismatch"));
    setExactRoi();
    cy.contains("button", "Infer").click();
    cy.wait("@roiInfer").its("response.statusCode").should("equal", 200);
    cy.wait("@roiAbandon").its("response.statusCode").should("equal", 200);
    aiRegionStatus().should("contain.text", "The mismatched response was abandoned before insertion.");
    assertRoiState(true);
    cy.window().should((win) => {
      expect(serializedInferenceResults(win), "target mismatch never inserts").to.have.length(beforeMismatch);
    });

    let beforeForcedUnload = 0;
    let forcedUnloadInferCount = 0;
    cy.window().then((win) => {
      beforeForcedUnload = serializedInferenceResults(win).length;
    });
    cy.then(() => {
      forcedUnloadInferCount = backend.inferCount;
      backend.setInferenceMode("produced", { delay: SLOW_INFERENCE_DELAY_MS });
    });
    setExactRoi();
    cy.contains("button", "Infer").click();
    cy.wrap(null).should(() => {
      expect(backend.inferCount, "forced-unload response is held after submission").to.equal(
        forcedUnloadInferCount + 1,
      );
    });
    cy.reload();
    cy.wait("@roiAbandon").its("response.statusCode").should("equal", 200);
    cy.wait("@roiInfer").its("response.statusCode").should("equal", 200);
    cy.wrap(null).should(() => {
      expect(
        backend.abandonBodies.some((body) => body.reason === "user_discarded"),
        "forced unload records abandoned-before-insertion",
      ).to.equal(true);
    });
    waitForManagedTaskReady(2);
    assertRoiState(false);
    cy.wrap(null).then(() =>
      expect(backend.inferCount, "late response does not trigger another inference request").to.equal(
        forcedUnloadInferCount + 1,
      ),
    );
    cy.window().should((win) => {
      expect(serializedInferenceResults(win), "forced unload never inserts a late response").to.have.length(
        beforeForcedUnload,
      );
    });
    cy.then(() => expect(analyticsRequestSeen, "workflow emits no external Vector analytics request").to.equal(false));
  });
});
