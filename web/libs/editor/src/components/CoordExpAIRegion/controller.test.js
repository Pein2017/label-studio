import {
  buildVisualPolicy,
  expandedNeighbors,
  intersectionOverUnion,
  percentRoiToOriginalPixels,
  roiFromDrag,
  shouldRetireInferencePresentations,
  validateAbandonResponse,
  validateCanvasResolution,
  validateDurableDraftReceipt,
  validateInferenceResponse,
  validateProfilesResponse,
  visualPolicyConflictCount,
} from "./controller";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const frozen = {
  requestId: REQUEST_ID,
  projectId: 7,
  taskId: 17,
  taskKey: "train:42",
  annotationId: 9,
  draftId: 5,
  draftRevision: "revision-2",
  browserSemanticProjectionHash: "fnv1a32:abcd",
  profileSelector: "safe",
};

const profile = {
  selector: "safe",
  display_label: "Safe",
  default_canvas: { width: 1024, height: 1024 },
  processor_factor: 32,
  bounds: { min_axis_pixels: 32, max_axis_pixels: 2048, max_total_pixels: 1572864 },
  generation_deadline_seconds: 20,
};

const target = {
  request_id: REQUEST_ID,
  project_id: "7",
  task_id: "train:42",
  task_epoch: "epoch",
  image_id: "42",
  annotation_id: "9",
  annotation_revision: "revision-1",
  current_user_id: "3",
  draft_id: "5",
  draft_revision: "revision-2",
  profile_fingerprint: "a".repeat(64),
  project_generation: 4,
  transform_fingerprint: "b".repeat(64),
  preexisting_draft_dirty: false,
};

const region = (key = `roi:${REQUEST_ID}:1`, bbox = [100, 200, 400, 600]) => ({
  result_id: `${REQUEST_ID}:result-0`,
  category_name: "person",
  category_id: 1,
  bbox_2d: bbox,
  request_id: REQUEST_ID,
  parser_object_span_id: "span-1",
  source_draft_revision: "revision-2",
  region_key: key,
  label_studio_result: {
    id: key,
    type: "rectanglelabels",
    from_name: "bbox",
    to_name: "image",
    original_width: 800,
    original_height: 600,
    image_rotation: 0,
    value: {
      x: (bbox[0] * 100) / 999,
      y: (bbox[1] * 100) / 999,
      width: ((bbox[2] - bbox[0]) * 100) / 999,
      height: ((bbox[3] - bbox[1]) * 100) / 999,
      rotation: 0,
      rectanglelabels: ["person"],
    },
    meta: {
      coordexp_region_key: key,
      coordexp_inference_receipt_id: `roi-receipt:${REQUEST_ID}`,
      coordexp_inference_request_id: REQUEST_ID,
      coordexp_inference_result_id: `${REQUEST_ID}:result-0`,
      coordexp_inference_source_draft_revision: "revision-2",
    },
  },
});

const response = (updates = {}) => ({
  receipt_id: `roi-receipt:${REQUEST_ID}`,
  request_id: REQUEST_ID,
  request_state: "produced",
  terminal_status: null,
  clear_roi: false,
  insertion_payload: { target, mode: "append_one_undo_action", regions: [region()] },
  failure: null,
  counts: { parsed: 1, produced: 1, rejected: 0 },
  ...updates,
});

const draftReceipt = {
  task_id: 17,
  annotation_id: 9,
  draft_id: 5,
  status: 200,
  revision: "revision-2",
  serialized_hash: "fnv1a32:serialized",
  browser_semantic_projection_hash: "fnv1a32:abcd",
  authoritative_semantic_hash: null,
};

const abandoned = (reason = "user_cancelled") => ({
  receipt_id: `roi-receipt:${REQUEST_ID}`,
  request_id: REQUEST_ID,
  request_state: "abandoned_before_insertion",
  terminal_status: "abandoned_before_insertion",
  clear_roi: false,
  insertion_payload: null,
  failure: { stage: "insertion", code: reason },
  counts: { parsed: 1, inserted: 0, rejected: 0 },
});

describe("AI Region controller", () => {
  const retirementStatus = (updates = {}) => ({
    taskSemanticState: "Committed",
    authority: {
      last_terminal_batch: { state: "succeeded" },
      members: [
        {
          task_id: 17,
          task_key: "train:42",
          last_terminal_batch_member: true,
          draft_matches_last_terminal_batch: true,
          draft_ahead_of_committed: false,
          pending: false,
        },
      ],
    },
    local: { dirty: false, saveInFlight: false, roiRunning: false, pendingTaskCount: 0 },
    ...updates,
  });

  it("retires inference presentation only for the exact succeeded terminal member with committed local state", () => {
    expect(shouldRetireInferencePresentations(retirementStatus(), { taskId: 17, taskKey: "train:42" })).toBe(true);
  });

  it.each([
    ["failed terminal", { authority: { ...retirementStatus().authority, last_terminal_batch: { state: "failed" } } }],
    [
      "other task",
      {
        authority: {
          ...retirementStatus().authority,
          members: [{ ...retirementStatus().authority.members[0], task_id: 18, task_key: "train:43" }],
        },
      },
    ],
    [
      "newer Draft",
      {
        taskSemanticState: "Draft",
        authority: {
          ...retirementStatus().authority,
          members: [
            {
              ...retirementStatus().authority.members[0],
              pending: true,
              draft_ahead_of_committed: true,
            },
          ],
        },
      },
    ],
    ["dirty browser", { local: { ...retirementStatus().local, dirty: true } }],
    ["save in flight", { local: { ...retirementStatus().local, saveInFlight: true } }],
    ["ROI running", { local: { ...retirementStatus().local, roiRunning: true } }],
    ["pending local task", { local: { ...retirementStatus().local, pendingTaskCount: 1 } }],
    ["missing terminal match", { authority: { last_terminal_batch: { state: "succeeded" }, members: [] } }],
    [
      "ambiguous duplicate current member",
      {
        authority: {
          ...retirementStatus().authority,
          members: [retirementStatus().authority.members[0], retirementStatus().authority.members[0]],
        },
      },
    ],
  ])("fails closed for %s", (_name, updates) => {
    expect(shouldRetireInferencePresentations(retirementStatus(updates), { taskId: 17, taskKey: "train:42" })).toBe(
      false,
    );
  });

  it("clips and replaces drag rectangles without accepting degenerate drags", () => {
    expect(roiFromDrag({ x: 80, y: 90 }, { x: -20, y: 120 })).toEqual({ x: 0, y: 90, width: 80, height: 10 });
    expect(roiFromDrag({ x: 3, y: 3 }, { x: 3, y: 9 })).toBeNull();
  });

  it("converts percentages to natural-image pixels exactly once", () => {
    expect(percentRoiToOriginalPixels({ x: 25, y: 25, width: 50, height: 50 }, 800, 600)).toEqual({
      x: 200,
      y: 150,
      width: 400,
      height: 300,
    });
  });

  it("strictly validates profile factor, axis, and total-pixel limits", () => {
    expect(validateProfilesResponse({ profiles: [profile] })).toEqual([profile]);
    expect(validateCanvasResolution(profile, "1280", "768")).toEqual({
      valid: true,
      value: { width: 1280, height: 768 },
      error: null,
    });
    expect(validateCanvasResolution(profile, 1279, 768).error).toMatch(/divisible by 32/);
    expect(validateCanvasResolution(profile, 2048, 1024).error).toMatch(/must not exceed/);
    expect(() => validateProfilesResponse({ profiles: [{ ...profile, extra: true }] })).toThrow(/unsupported shape/);
    expect(() =>
      validateProfilesResponse({ profiles: [{ ...profile, default_canvas: { width: 1000, height: 1024 } }] }),
    ).toThrow(/default canvas/);
    expect(() =>
      validateProfilesResponse({ profiles: [{ ...profile, default_canvas: { width: 2048, height: 1024 } }] }),
    ).toThrow(/default canvas/);
  });

  it("strictly freezes a durable Draft receipt and exact terminal abandonment", () => {
    expect(validateDurableDraftReceipt(draftReceipt, { taskId: 17, annotationId: 9 })).toBe(draftReceipt);
    expect(validateAbandonResponse(abandoned(), { requestId: REQUEST_ID, reason: "user_cancelled" })).toEqual(
      abandoned(),
    );
    expect(() =>
      validateDurableDraftReceipt({ ...draftReceipt, extra: true }, { taskId: 17, annotationId: 9 }),
    ).toThrow(/receipt shape/);
    expect(() =>
      validateAbandonResponse(
        { ...abandoned(), receipt_id: "roi-receipt:22222222-2222-4222-8222-222222222222" },
        { requestId: REQUEST_ID, reason: "user_cancelled" },
      ),
    ).toThrow(/exact terminal/);
    expect(() => validateAbandonResponse({}, { requestId: REQUEST_ID, reason: "user_cancelled" })).toThrow(
      /unsupported shape/,
    );
  });

  it("accepts one exact produced payload and derives accepted_with_drops", () => {
    const accepted = validateInferenceResponse(response(), frozen);
    const partial = validateInferenceResponse(response({ counts: { parsed: 1, produced: 1, rejected: 2 } }), frozen);

    expect(accepted).toMatchObject({ kind: "produced", status: "accepted", clearRoi: true });
    expect(accepted.results).toEqual([region().label_studio_result]);
    expect(partial.status).toBe("accepted_with_drops");
  });

  it.each([
    ["empty", { parsed: 0, produced: 0, rejected: 0 }],
    ["all_rejected", { parsed: 2, produced: 0, rejected: 2 }],
  ])("validates terminal %s without insertion", (state, counts) => {
    const plan = validateInferenceResponse(
      response({
        request_state: state,
        terminal_status: state,
        clear_roi: true,
        insertion_payload: null,
        counts,
      }),
      frozen,
    );

    expect(plan).toMatchObject({ kind: state, clearRoi: true });
  });

  it("retains ROI for a parser response failure with result counts", () => {
    const plan = validateInferenceResponse(
      response({
        request_state: "response_failure",
        terminal_status: "response_failure",
        insertion_payload: null,
        counts: { parsed: 0, produced: 0, rejected: 0 },
      }),
      frozen,
    );

    expect(plan).toMatchObject({ kind: "failure", clearRoi: false });
  });

  it.each([
    "runtime_failure",
    "profile_failure",
    "timeout_failure",
    "transport_failure",
    "abandoned_before_insertion",
  ])("retains ROI for exact count-free %s", (state) => {
    const payload = response({
      request_state: state,
      terminal_status: state,
      insertion_payload: null,
      failure: { stage: "runtime", code: `resident.${state}` },
    });

    delete payload.counts;
    const plan = validateInferenceResponse(payload, frozen);

    expect(plan).toMatchObject({ kind: "failure", clearRoi: false });
  });

  it("fails closed on target, receipt, region, or geometry mismatch", () => {
    expect(() => validateInferenceResponse(response({ request_id: "bad" }), frozen)).toThrow(/request identity/);
    expect(() =>
      validateInferenceResponse(
        response({
          insertion_payload: {
            target: { ...target, annotation_id: "10" },
            mode: "append_one_undo_action",
            regions: [region()],
          },
        }),
        frozen,
      ),
    ).toThrow(/annotation_id/);
    expect(() =>
      validateInferenceResponse(
        response({
          insertion_payload: {
            target: { ...target, preexisting_draft_dirty: true },
            mode: "append_one_undo_action",
            regions: [region()],
          },
        }),
        frozen,
      ),
    ).toThrow(/Draft dirtiness/);
    const forged = region();

    forged.label_studio_result.value.x += 1;
    expect(() =>
      validateInferenceResponse(
        response({ insertion_payload: { target, mode: "append_one_undo_action", regions: [forged] } }),
        frozen,
      ),
    ).toThrow(/disagrees/);
  });

  it.each([
    [
      [100, 200, 300, 400],
      [10000 / 999, 20000 / 999, 20000 / 999, 20000 / 999],
    ],
    [
      [568, 4, 717, 153],
      [56800 / 999, 400 / 999, 14900 / 999, 14900 / 999],
    ],
    [
      [0, 0, 999, 999],
      [0, 0, 100, 100],
    ],
  ])("validates exact norm1000 geometry %j through the inference response", (bbox, expected) => {
    const candidate = region(undefined, bbox);
    const payload = response({
      insertion_payload: { target, mode: "append_one_undo_action", regions: [candidate] },
    });

    expect(validateInferenceResponse(payload, frozen).results[0].value).toMatchObject({
      x: expected[0],
      y: expected[1],
      width: expected[2],
      height: expected[3],
    });
  });

  it("rejects legacy divide-by-ten Label Studio geometry", () => {
    const candidate = region(undefined, [100, 200, 300, 400]);

    Object.assign(candidate.label_studio_result.value, { x: 10, y: 20, width: 20, height: 20 });
    expect(() =>
      validateInferenceResponse(
        response({ insertion_payload: { target, mode: "append_one_undo_action", regions: [candidate] } }),
        frozen,
      ),
    ).toThrow(/disagrees with norm1000 geometry/);
  });

  it("uses stable-key greedy colors, exhaustion badges, and duplicate cues", () => {
    const descriptors = Array.from({ length: 4 }, (_, index) => ({
      stableRegionKey: `region-${index}`,
      categoryName: "person",
      bbox: [100, 100, 500, 500],
    }));
    const policy = buildVisualPolicy(descriptors, ["#005A9C", "#A64073"]);

    expect(policy.presentations.map((item) => item.color)).toEqual(["#005A9C", "#A64073", "#005A9C", "#A64073"]);
    expect(policy.presentations.map((item) => item.numeric_badge)).toEqual([null, null, 3, 4]);
    expect(visualPolicyConflictCount(policy)).toBe(6);
    expect(expandedNeighbors([0, 0, 10, 10], [34, 0, 40, 10])).toBe(true);
    expect(intersectionOverUnion([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
  });

  it("marks an inferred region that duplicates an existing human region without coloring the human region", () => {
    const inferred = { stableRegionKey: "inferred", categoryName: "person", bbox: [0, 0, 100, 100] };
    const human = { stableRegionKey: "human", categoryName: "person", bbox: [0, 0, 100, 100] };
    const policy = buildVisualPolicy([inferred], undefined, [inferred, human]);

    expect(policy.presentations).toHaveLength(1);
    expect(policy.presentations[0].advisory_conflict_keys).toEqual(["human"]);
    expect(visualPolicyConflictCount(policy)).toBe(1);
  });
});
