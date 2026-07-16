import { COORDEXP_MANAGED_PROJECT_PREFIX, CoordExpDraftSaveError, LSFWrapper } from "./lsf-sdk";

jest.mock("mobx-state-tree", () => ({
  ...jest.requireActual("mobx-state-tree"),
  isAlive: jest.fn((node) => Boolean(node) && node.__dead !== true),
}));

class FakeLabelStudio {
  static settings = null;

  constructor(_root, settings) {
    FakeLabelStudio.settings = settings;
    this.on = jest.fn();
    this.destroy = jest.fn();
  }
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const withoutField = (value, field) => {
  const result = { ...value };

  delete result[field];
  return result;
};

const draftResponse = ({
  id = 501,
  status = 201,
  task = 10,
  annotation = 77,
  updated_at = "2026-07-15T00:00:00Z",
  ...rest
} = {}) => ({
  id,
  task,
  annotation,
  updated_at,
  $meta: { status },
  ...rest,
});

const managedState = ({
  generation = 0,
  version = 1,
  pending_draft_count = 0,
  batch_state = null,
  members = [],
  ...rest
} = {}) => ({
  generation,
  version,
  pending_draft_count,
  batch_state,
  members,
  ...rest,
});

const makeAnnotation = ({ pk = "77", id = "local-77", draftId = 0, initialResult } = {}) => {
  let result = initialResult ?? [
    {
      id: "region-1",
      from_name: "label",
      to_name: "image",
      type: "rectanglelabels",
      value: { x: 1, y: 2, width: 3, height: 4, rectanglelabels: ["person"] },
    },
  ];
  const annotation = {
    pk,
    id,
    draftId,
    draftSaved: undefined,
    history: {
      hasChanges: false,
      isFrozen: false,
      undoIdx: 0,
      lastAdditionTime: null,
      freeze: jest.fn(() => {
        annotation.history.isFrozen = true;
      }),
      safeUnfreeze: jest.fn(() => {
        annotation.history.isFrozen = false;
      }),
      abortFreeze: jest.fn(() => {
        const wasFrozen = annotation.history.isFrozen;

        annotation.history.isFrozen = false;
        return wasFrozen;
      }),
    },
    areas: new Map(),
    trackedState: {},
    versions: { draft: [] },
    loadedDate: new Date("2026-07-15T00:00:00Z"),
    leadTime: 0,
    userGenerate: true,
    sentUserGenerate: false,
    serializeAnnotation: jest.fn(() => clone(result)),
    pauseAutosave: jest.fn(),
    startAutosave: jest.fn(),
    setExternalDraftSaveOwner: jest.fn((owned = true) => {
      annotation.externalDraftSaveOwner = owned;
      if (owned) annotation.pauseAutosave();
    }),
    setDraftId: jest.fn((value) => {
      annotation.draftId = value;
    }),
    setDraftSaved: jest.fn((value) => {
      annotation.draftSaved = value;
    }),
    setDraftSaving: jest.fn((value) => {
      annotation.isDraftSaving = value;
    }),
    deserializeResults: jest.fn((nextResult) => {
      result = clone(nextResult);
      annotation.versions.result = clone(nextResult);
      annotation.areas = new Map(nextResult.map((item, index) => [item.id ?? String(index), item]));
    }),
    updateObjects: jest.fn(),
    reinitHistory: jest.fn(() => {
      annotation.history.hasChanges = false;
      annotation.history.undoIdx = 0;
      annotation.history.lastAdditionTime = null;
    }),
    replaceResult(nextResult) {
      result = clone(nextResult);
      annotation.history.hasChanges = true;
      annotation.history.undoIdx += 1;
      annotation.history.lastAdditionTime = new Date().toISOString();
    },
  };

  return annotation;
};

const makeHarness = ({ managed = true, annotation = makeAnnotation(), taskId = 10 } = {}) => {
  const project = {
    id: 3,
    description: managed ? `${COORDEXP_MANAGED_PROJECT_PREFIX}fixture` : "ordinary project",
    enable_empty_annotation: true,
    show_skip_button: false,
    review_settings: {},
    queue_total: 1,
    queue_done: 0,
    queue_left: 1,
  };
  const task = {
    id: taskId,
    drafts: [],
    annotations: [],
    predictions: [],
    allow_postpone: true,
    data: { coordexp_task_key: "must-not-control-managed-detection" },
  };
  const datamanager = {
    callbacks: new Map(),
    store: {
      project,
      labelingConfig: '<View><Image name="image" value="$image"/></View>',
      users: [],
      taskStore: {},
    },
    api: {},
    apiCall: jest.fn(),
    getEventCallbacks: jest.fn(() => new Set()),
    hasInterface: jest.fn(() => false),
    invoke: jest.fn(),
  };
  const wrapper = new LSFWrapper(datamanager, document.createElement("div"), { task });
  const annotations = [annotation];
  const annotationStore = {
    selected: annotation,
    annotations,
    predictions: [],
    selectAnnotation: jest.fn((annotationId) => {
      annotationStore.selected = annotations.find((item) => item.id === annotationId || item.pk === annotationId);
    }),
  };

  wrapper.lsf = {
    annotationStore,
    taskHistory: [],
    userLabels: null,
  };
  wrapper._initializeManagedDraftBaselines();

  return { annotation, annotationStore, datamanager, project, task, wrapper };
};

beforeAll(() => {
  window.LabelStudio = FakeLabelStudio;
});

beforeEach(() => {
  window.APP_SETTINGS = {
    annotator_reviewer_firewall_enabled: false,
    label_stream_navigation_disabled: false,
    read_only_quick_view_enabled: false,
  };
  window.history.replaceState({}, "", "/projects/3/data?task=10");
  jest.clearAllMocks();
});

describe("managed project detection", () => {
  it("uses only the exact project description prefix", () => {
    const managed = makeHarness();
    const ordinary = makeHarness({ managed: false });

    expect(managed.wrapper.isManagedRefinementProject).toBe(true);
    expect(ordinary.wrapper.isManagedRefinementProject).toBe(false);

    managed.wrapper.destroy();
    ordinary.wrapper.destroy();
  });
});

describe("strict managed Draft responses", () => {
  it.each([400, 409, 500])("rejects a resolved %s response without advancing the baseline", async (status) => {
    const { annotation, datamanager, wrapper } = makeHarness();
    const priorBaseline = wrapper._managedDraftBaselines.get("10:77");

    annotation.replaceResult([{ id: `changed-${status}` }]);
    datamanager.apiCall.mockResolvedValue(draftResponse({ status }));

    await expect(wrapper.saveDraft()).rejects.toMatchObject({
      name: "CoordExpDraftSaveError",
      code: "DRAFT_HTTP_ERROR",
    });
    expect(wrapper._managedDraftBaselines.get("10:77")).toBe(priorBaseline);
    expect(annotation.setDraftSaved).not.toHaveBeenCalled();
    expect(datamanager.invoke).not.toHaveBeenCalledWith(
      "toast",
      expect.objectContaining({ message: "Draft saved successfully" }),
    );
    wrapper.destroy();
  });

  it.each([
    ["empty response", undefined, "EMPTY_RESPONSE"],
    ["missing metadata", { id: 501, task: 10, annotation: 77 }, "MISSING_RESPONSE_STATUS"],
    ["missing Draft id", { ...draftResponse(), id: undefined }, "INVALID_DRAFT_ID"],
    ["resolved error object", draftResponse({ error: "conflict" }), "RESOLVED_API_ERROR"],
  ])("rejects %s", async (_name, response, code) => {
    const { annotation, datamanager, wrapper } = makeHarness();

    annotation.replaceResult([{ id: "changed" }]);
    datamanager.apiCall.mockResolvedValue(response);

    await expect(wrapper.saveDraft()).rejects.toMatchObject({ code });
    expect(annotation.setDraftSaved).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("makes onSubmitDraft reject a resolved API failure without a success toast", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();

    annotation.replaceResult([{ id: "editor-save" }]);
    datamanager.apiCall.mockResolvedValue(draftResponse({ status: 409 }));

    await expect(wrapper.onSubmitDraft(null, annotation, { useToast: true })).rejects.toMatchObject({
      code: "DRAFT_HTTP_ERROR",
    });
    expect(annotation.setDraftSaved).not.toHaveBeenCalled();
    expect(datamanager.invoke).not.toHaveBeenCalledWith(
      "toast",
      expect.objectContaining({ message: "Draft saved successfully" }),
    );
    wrapper.destroy();
  });

  it("persists non-toast Draft parameters even when the managed annotation is semantically clean", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();

    datamanager.apiCall.mockResolvedValue(draftResponse());

    await expect(wrapper.onSubmitDraft(null, annotation, { was_postponed: true })).resolves.toMatchObject({ id: 501 });
    expect(datamanager.apiCall).toHaveBeenCalledWith(
      "createDraftForAnnotation",
      { taskID: 10, annotationID: "77" },
      expect.objectContaining({ body: expect.objectContaining({ was_postponed: true }) }),
    );
    wrapper.destroy();
  });

  it("queues persisted Draft parameters behind an in-flight save instead of dropping them", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();
    const firstRequest = deferred();

    annotation.replaceResult([{ id: "autosave-in-flight" }]);
    datamanager.apiCall
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValueOnce(draftResponse({ id: 501, status: 200 }));

    const autosave = wrapper.saveDraft();
    const postpone = wrapper.onSubmitDraft(null, annotation, { was_postponed: true });

    await Promise.resolve();
    expect(datamanager.apiCall).toHaveBeenCalledTimes(1);
    firstRequest.resolve(draftResponse());

    await expect(autosave).resolves.toMatchObject({ id: 501 });
    await expect(postpone).resolves.toMatchObject({ id: 501 });
    expect(datamanager.apiCall).toHaveBeenCalledTimes(2);
    expect(datamanager.apiCall).toHaveBeenNthCalledWith(
      2,
      "updateDraft",
      { draftID: 501 },
      expect.objectContaining({ body: expect.objectContaining({ was_postponed: true }) }),
    );
    wrapper.destroy();
  });

  it("creates and strictly receipts a Draft for an existing Annotation", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();

    annotation.replaceResult([{ id: "created" }]);
    datamanager.apiCall.mockResolvedValue(draftResponse());

    const receipt = await wrapper.ensureDurableDraft();

    expect(datamanager.apiCall).toHaveBeenCalledWith(
      "createDraftForAnnotation",
      { taskID: 10, annotationID: "77" },
      expect.objectContaining({ body: expect.objectContaining({ result: [{ id: "created" }] }) }),
    );
    expect(receipt).toEqual({
      task_id: 10,
      annotation_id: "77",
      draft_id: 501,
      status: 201,
      revision: "2026-07-15T00:00:00Z",
      serialized_hash: expect.stringMatching(/^fnv1a32:/),
      browser_semantic_projection_hash: expect.stringMatching(/^fnv1a32:/),
      authoritative_semantic_hash: null,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(annotation.draftId).toBe(501);
    expect(wrapper.lastPersistedDraftResult).toBe(receipt);
    wrapper.destroy();
  });

  it("refreshes only the task-load baseline after a server Draft is fully deserialized", () => {
    const annotation = makeAnnotation({ initialResult: [] });
    const { wrapper } = makeHarness({ annotation });

    expect(wrapper._managedDraftBaselines.get("10:77")?.serialized).toBe("[]");
    annotation.replaceResult([{ id: "server-draft-region" }]);

    wrapper._finalizeManagedDraftBaselineAfterLoad(annotation);
    const loadedBaseline = wrapper._managedDraftBaselines.get("10:77");

    expect(JSON.parse(loadedBaseline.serialized)).toEqual([{ id: "server-draft-region" }]);
    expect(wrapper._isManagedAnnotationDirty(annotation)).toBe(false);

    annotation.replaceResult([{ id: "later-user-edit" }]);
    wrapper._initializeManagedDraftBaseline(annotation);
    expect(wrapper._managedDraftBaselines.get("10:77")).toBe(loadedBaseline);
    expect(wrapper._isManagedAnnotationDirty(annotation)).toBe(true);
    wrapper.destroy();
  });

  it("finalizes a lazy managed baseline only after deferred server hydration completes", async () => {
    const annotation = makeAnnotation({ initialResult: [] });

    annotation.userGenerate = false;
    annotation.sentUserGenerate = true;
    annotation.versions.result = [];
    const { datamanager, wrapper } = makeHarness({ annotation });
    const request = deferred();
    const baselineBeforeHydration = wrapper._managedDraftBaselines.get("10:77");

    datamanager.apiCall.mockReturnValue(request.promise);
    const hydration = wrapper._hydrateStubAnnotation(annotation);

    await Promise.resolve();
    expect(datamanager.apiCall).toHaveBeenCalledWith("fetchAnnotation", { annotationID: "77" });
    expect(wrapper._managedDraftBaselines.get("10:77")).toBe(baselineBeforeHydration);

    request.resolve({ result: [{ id: "hydrated-server-region" }] });
    await hydration;

    const hydratedBaseline = wrapper._managedDraftBaselines.get("10:77");
    expect(hydratedBaseline).not.toBe(baselineBeforeHydration);
    expect(JSON.parse(hydratedBaseline.serialized)).toEqual([{ id: "hydrated-server-region" }]);
    expect(annotation.deserializeResults).toHaveBeenCalledWith([{ id: "hydrated-server-region" }]);
    expect(annotation.reinitHistory).toHaveBeenCalledTimes(1);
    expect(wrapper._isManagedAnnotationDirty(annotation)).toBe(false);
    wrapper.destroy();
  });

  it("does not hydrate or overwrite the baseline after a managed user edit wins the deferred load race", async () => {
    const annotation = makeAnnotation({ initialResult: [] });

    annotation.userGenerate = false;
    annotation.sentUserGenerate = true;
    annotation.versions.result = [];
    const { datamanager, wrapper } = makeHarness({ annotation });
    const request = deferred();
    const baselineBeforeHydration = wrapper._managedDraftBaselines.get("10:77");

    datamanager.apiCall.mockReturnValue(request.promise);
    const hydration = wrapper._hydrateStubAnnotation(annotation);

    await Promise.resolve();
    annotation.replaceResult([{ id: "user-edit-during-hydration" }]);
    request.resolve({ result: [{ id: "late-server-region" }] });
    await hydration;

    expect(annotation.deserializeResults).not.toHaveBeenCalled();
    expect(wrapper._managedDraftBaselines.get("10:77")).toBe(baselineBeforeHydration);
    expect(wrapper._isManagedAnnotationDirty(annotation)).toBe(true);
    wrapper.destroy();
  });

  it("waits for deferred managed hydration before force-saving the authoritative server result", async () => {
    const annotation = makeAnnotation({ initialResult: [] });

    annotation.userGenerate = false;
    annotation.sentUserGenerate = true;
    annotation.versions.result = [];
    const { datamanager, wrapper } = makeHarness({ annotation });
    const request = deferred();

    datamanager.apiCall.mockImplementation((name) => {
      if (name === "fetchAnnotation") return request.promise;
      if (name === "createDraftForAnnotation") return Promise.resolve(draftResponse());
      throw new Error(`Unexpected API call: ${name}`);
    });

    const hydration = wrapper._hydrateStubAnnotation(annotation);
    const save = wrapper.ensureDurableDraft();

    await Promise.resolve();
    expect(datamanager.apiCall).toHaveBeenCalledTimes(1);
    expect(datamanager.apiCall).toHaveBeenCalledWith("fetchAnnotation", { annotationID: "77" });

    request.resolve({ result: [{ id: "authoritative-server-region" }] });
    await hydration;
    await expect(save).resolves.toMatchObject({ draft_id: 501 });

    expect(datamanager.apiCall).toHaveBeenCalledTimes(2);
    expect(datamanager.apiCall).toHaveBeenLastCalledWith(
      "createDraftForAnnotation",
      { taskID: 10, annotationID: "77" },
      expect.objectContaining({ body: expect.objectContaining({ result: [{ id: "authoritative-server-region" }] }) }),
    );
    wrapper.destroy();
  });

  it("starts unregistered lazy hydration before a direct force-save", async () => {
    const annotation = makeAnnotation({ initialResult: [] });

    annotation.userGenerate = false;
    annotation.sentUserGenerate = true;
    annotation.versions.result = [];
    const { datamanager, wrapper } = makeHarness({ annotation });
    const apiOrder = [];

    datamanager.apiCall.mockImplementation((name) => {
      apiOrder.push(name);
      if (name === "fetchAnnotation") return Promise.resolve({ result: [{ id: "server-before-save" }] });
      if (name === "createDraftForAnnotation") return Promise.resolve(draftResponse());
      throw new Error(`Unexpected API call: ${name}`);
    });

    await expect(wrapper.ensureDurableDraft()).resolves.toMatchObject({ draft_id: 501 });

    expect(apiOrder).toEqual(["fetchAnnotation", "createDraftForAnnotation"]);
    expect(datamanager.apiCall).toHaveBeenLastCalledWith(
      "createDraftForAnnotation",
      { taskID: 10, annotationID: "77" },
      expect.objectContaining({ body: expect.objectContaining({ result: [{ id: "server-before-save" }] }) }),
    );
    wrapper.destroy();
  });

  it("fails closed without a Draft request when managed hydration fails", async () => {
    const annotation = makeAnnotation({ initialResult: [] });

    annotation.userGenerate = false;
    annotation.sentUserGenerate = true;
    annotation.versions.result = [];
    const { datamanager, wrapper } = makeHarness({ annotation });
    const request = deferred();

    datamanager.apiCall.mockReturnValue(request.promise);
    const hydration = wrapper._hydrateStubAnnotation(annotation);
    const save = wrapper.ensureDurableDraft();

    request.reject(new Error("fetch failed"));
    await expect(hydration).resolves.toBeNull();
    await expect(save).rejects.toMatchObject({ code: "ANNOTATION_HYDRATION_FAILED" });
    expect(datamanager.apiCall).toHaveBeenCalledTimes(1);
    expect(annotation.setDraftSaved).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("preserves and saves a managed user edit that wins while hydration is pending", async () => {
    const annotation = makeAnnotation({ initialResult: [] });

    annotation.userGenerate = false;
    annotation.sentUserGenerate = true;
    annotation.versions.result = [];
    const { datamanager, wrapper } = makeHarness({ annotation });
    const request = deferred();

    datamanager.apiCall.mockImplementation((name) => {
      if (name === "fetchAnnotation") return request.promise;
      if (name === "createDraftForAnnotation") return Promise.resolve(draftResponse());
      throw new Error(`Unexpected API call: ${name}`);
    });

    const hydration = wrapper._hydrateStubAnnotation(annotation);
    const save = wrapper.ensureDurableDraft();

    annotation.replaceResult([{ id: "user-edit-during-hydration" }]);
    request.resolve({ result: [{ id: "late-server-region" }] });
    await hydration;
    await expect(save).resolves.toMatchObject({ draft_id: 501 });

    expect(annotation.deserializeResults).not.toHaveBeenCalled();
    expect(datamanager.apiCall).toHaveBeenLastCalledWith(
      "createDraftForAnnotation",
      { taskID: 10, annotationID: "77" },
      expect.objectContaining({ body: expect.objectContaining({ result: [{ id: "user-edit-during-hydration" }] }) }),
    );
    expect(wrapper._isManagedAnnotationDirty(annotation)).toBe(false);
    wrapper.destroy();
  });

  it("lets only the newest annotation-node hydration generation mutate a reused stable identity", async () => {
    const annotation = makeAnnotation({ initialResult: [] });
    const replacement = makeAnnotation({ id: "reloaded-local-77", initialResult: [] });

    for (const candidate of [annotation, replacement]) {
      candidate.userGenerate = false;
      candidate.sentUserGenerate = true;
      candidate.versions.result = [];
    }
    const { annotationStore, datamanager, wrapper } = makeHarness({ annotation });
    const first = deferred();
    const second = deferred();
    const fetches = [first, second];

    datamanager.apiCall.mockImplementation((name) => {
      if (name !== "fetchAnnotation") throw new Error(`Unexpected API call: ${name}`);
      return fetches.shift().promise;
    });

    const firstHydration = wrapper._hydrateStubAnnotation(annotation);

    annotationStore.annotations.splice(0, 1, replacement);
    annotationStore.selected = replacement;
    const secondHydration = wrapper._hydrateStubAnnotation(replacement);

    expect(wrapper._managedAnnotationHydrations.get("10:77")).toMatchObject({
      annotation: replacement,
      generation: 2,
      status: "pending",
    });

    second.resolve({ result: [{ id: "new-generation-region" }] });
    await secondHydration;
    first.resolve({ result: [{ id: "stale-generation-region" }] });
    await firstHydration;

    expect(annotation.deserializeResults).not.toHaveBeenCalled();
    expect(replacement.deserializeResults).toHaveBeenCalledTimes(1);
    expect(replacement.deserializeResults).toHaveBeenCalledWith([{ id: "new-generation-region" }]);
    expect(JSON.parse(wrapper._managedDraftBaselines.get("10:77").serialized)).toEqual([
      { id: "new-generation-region" },
    ]);
    wrapper.destroy();
  });

  it("prunes detached hydration nodes while retaining only the active task record", async () => {
    const { annotation, annotationStore, wrapper } = makeHarness();
    const retired = [];

    await wrapper._hydrateStubAnnotation(annotation);
    expect(wrapper._managedAnnotationHydrations.size).toBe(1);

    let active = annotation;
    for (const taskId of [11, 12, 13]) {
      retired.push(active);
      active = makeAnnotation({ id: `local-${taskId}`, pk: String(taskId + 100) });
      wrapper.task = { ...wrapper.task, id: taskId };
      annotationStore.annotations.splice(0, 1, active);
      annotationStore.selected = active;

      await wrapper._hydrateStubAnnotation(active);

      expect(wrapper._managedAnnotationHydrations.size).toBe(1);
      expect([...wrapper._managedAnnotationHydrations.values()][0]).toMatchObject({
        annotation: active,
        status: "ready",
      });
      for (const oldNode of retired) {
        expect([...wrapper._managedAnnotationHydrations.values()].some((record) => record.annotation === oldNode)).toBe(
          false,
        );
      }
    }

    wrapper.destroy();
  });

  it("never lets a pruned pending hydration save across a task replacement", async () => {
    const annotation = makeAnnotation({ initialResult: [] });

    annotation.userGenerate = false;
    annotation.sentUserGenerate = true;
    annotation.versions.result = [];
    const { annotationStore, datamanager, wrapper } = makeHarness({ annotation });
    const request = deferred();
    const apiOrder = [];

    datamanager.apiCall.mockImplementation((name) => {
      apiOrder.push(name);
      if (name === "fetchAnnotation") return request.promise;
      throw new Error(`Draft API must not run after task replacement: ${name}`);
    });

    const hydration = wrapper._hydrateStubAnnotation(annotation);
    const save = wrapper.ensureDurableDraft();

    await Promise.resolve();
    const replacement = makeAnnotation({ id: "task-b-local", pk: "88" });

    wrapper.task = { ...wrapper.task, id: 11 };
    annotationStore.annotations.splice(0, 1, replacement);
    annotationStore.selected = replacement;
    await wrapper._hydrateStubAnnotation(replacement);

    expect(wrapper._managedAnnotationHydrations.size).toBe(2);
    request.resolve({ result: [{ id: "stale-task-a-region" }] });
    await hydration;
    await expect(save).rejects.toMatchObject({
      code: expect.stringMatching(/^ANNOTATION_HYDRATION_/),
    });

    expect(apiOrder).toEqual(["fetchAnnotation"]);
    expect(annotation.deserializeResults).not.toHaveBeenCalled();
    expect(wrapper._managedAnnotationHydrations.size).toBe(1);
    expect([...wrapper._managedAnnotationHydrations.values()][0].annotation).toBe(replacement);
    wrapper.destroy();
  });

  it.each([
    "deserializeResults",
    "updateObjects",
  ])("releases managed hydration history and preserves the baseline when %s throws", async (failingStep) => {
    const annotation = makeAnnotation({ initialResult: [] });

    annotation.userGenerate = false;
    annotation.sentUserGenerate = true;
    annotation.versions.result = [];
    const { datamanager, wrapper } = makeHarness({ annotation });
    const baseline = wrapper._managedDraftBaselines.get("10:77");
    const original = annotation[failingStep].getMockImplementation();

    annotation[failingStep].mockImplementation((...args) => {
      if (failingStep === "updateObjects") original?.(...args);
      throw new Error(`${failingStep} failed`);
    });
    datamanager.apiCall.mockResolvedValue({ result: [{ id: "server-region" }] });

    await expect(wrapper._hydrateStubAnnotation(annotation)).resolves.toBeNull();

    expect(annotation.history.isFrozen).toBe(false);
    expect(annotation.history.abortFreeze).toHaveBeenCalledTimes(1);
    expect(annotation.reinitHistory).not.toHaveBeenCalled();
    expect(wrapper._managedDraftBaselines.get("10:77")).toBe(baseline);
    await expect(wrapper.ensureDurableDraft()).rejects.toMatchObject({ code: "ANNOTATION_HYDRATION_FAILED" });
    expect(datamanager.apiCall).toHaveBeenCalledTimes(1);
    wrapper.destroy();
  });

  it("fences a pending native autosave around the forced durable save", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();
    const pendingAutosave = jest.fn(async () => {
      await wrapper.onSubmitDraft(null, annotation);
      annotation.setDraftSaved("local-autosave-revision");
    });
    let pendingTimer = setTimeout(pendingAutosave, 0);

    annotation.pauseAutosave.mockImplementation(() => {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    });
    annotation.pauseAutosave.mockClear();
    annotation.startAutosave.mockClear();
    annotation.setExternalDraftSaveOwner.mockClear();
    annotation.replaceResult([{ id: "frozen-for-inference" }]);
    datamanager.apiCall.mockResolvedValue(draftResponse());

    await expect(wrapper.ensureDurableDraft()).resolves.toMatchObject({ revision: "2026-07-15T00:00:00Z" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(annotation.pauseAutosave).toHaveBeenCalledTimes(1);
    expect(annotation.setExternalDraftSaveOwner).toHaveBeenCalledWith(true);
    expect(pendingAutosave).not.toHaveBeenCalled();
    expect(datamanager.apiCall).toHaveBeenCalledTimes(1);
    expect(annotation.setDraftSaved).toHaveBeenCalledTimes(1);
    expect(annotation.setDraftSaved).toHaveBeenCalledWith("2026-07-15T00:00:00Z");
    expect(annotation.startAutosave).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("keeps native autosave paused after a forced-save failure", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();

    annotation.pauseAutosave.mockClear();
    annotation.startAutosave.mockClear();
    annotation.replaceResult([{ id: "failing-frozen-target" }]);
    datamanager.apiCall.mockResolvedValue(draftResponse({ status: 409 }));

    await expect(wrapper.ensureDurableDraft()).rejects.toMatchObject({ code: "DRAFT_HTTP_ERROR" });
    expect(annotation.pauseAutosave).toHaveBeenCalledTimes(1);
    expect(annotation.startAutosave).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("does not resume native autosave on a replacement annotation", async () => {
    const { annotation, annotationStore, datamanager, wrapper } = makeHarness();
    const request = deferred();

    annotation.pauseAutosave.mockClear();
    annotation.startAutosave.mockClear();
    annotation.replaceResult([{ id: "replaced-frozen-target" }]);
    datamanager.apiCall.mockImplementation(() => request.promise);
    const save = wrapper.ensureDurableDraft();

    await Promise.resolve();
    annotationStore.selected = makeAnnotation({ pk: "88", id: "local-88" });
    request.resolve(draftResponse());

    await expect(save).rejects.toMatchObject({ code: "SOURCE_ANNOTATION_CHANGED" });
    expect(annotation.pauseAutosave).toHaveBeenCalledTimes(1);
    expect(annotation.startAutosave).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("does not resume native autosave after the managed coordinator is destroyed", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();
    const request = deferred();

    annotation.pauseAutosave.mockClear();
    annotation.startAutosave.mockClear();
    annotation.replaceResult([{ id: "destroyed-frozen-target" }]);
    datamanager.apiCall.mockImplementation(() => request.promise);
    const save = wrapper.ensureDurableDraft();

    await Promise.resolve();
    wrapper.destroy();
    request.resolve(draftResponse());

    await expect(save).rejects.toMatchObject({ code: "MISSING_DRAFT_RECEIPT" });
    expect(annotation.pauseAutosave).toHaveBeenCalledTimes(1);
    expect(annotation.startAutosave).not.toHaveBeenCalled();
  });

  it("does not touch native autosave for ordinary projects", async () => {
    const { annotation, wrapper } = makeHarness({ managed: false });

    annotation.pauseAutosave.mockClear();
    annotation.startAutosave.mockClear();

    await expect(wrapper.ensureDurableDraft()).rejects.toMatchObject({ code: "PROJECT_NOT_MANAGED" });
    expect(annotation.pauseAutosave).not.toHaveBeenCalled();
    expect(annotation.startAutosave).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("updates an existing Draft and validates its returned id", async () => {
    const annotation = makeAnnotation({ draftId: 44 });
    const { datamanager, wrapper } = makeHarness({ annotation });

    annotation.replaceResult([{ id: "updated" }]);
    datamanager.apiCall.mockResolvedValue(draftResponse({ id: 44, status: 200 }));

    await wrapper.ensureDurableDraft();

    expect(datamanager.apiCall).toHaveBeenCalledWith(
      "updateDraft",
      { draftID: 44 },
      expect.objectContaining({ body: expect.objectContaining({ result: [{ id: "updated" }] }) }),
    );
    wrapper.destroy();
  });

  it.each([
    ["changed Draft id", draftResponse({ id: 45, status: 200 }), "DRAFT_ID_MISMATCH"],
    ["missing task", withoutField(draftResponse({ id: 44, status: 200 }), "task"), "DRAFT_TASK_MISMATCH"],
    ["changed task", draftResponse({ id: 44, status: 200, task: 11 }), "DRAFT_TASK_MISMATCH"],
    [
      "missing annotation",
      withoutField(draftResponse({ id: 44, status: 200 }), "annotation"),
      "DRAFT_ANNOTATION_MISMATCH",
    ],
    ["changed annotation", draftResponse({ id: 44, status: 200, annotation: 88 }), "DRAFT_ANNOTATION_MISMATCH"],
    [
      "missing updated_at",
      withoutField(draftResponse({ id: 44, status: 200 }), "updated_at"),
      "MISSING_DRAFT_UPDATED_AT",
    ],
    ["empty updated_at", draftResponse({ id: 44, status: 200, updated_at: "" }), "MISSING_DRAFT_UPDATED_AT"],
  ])("rejects update identity with %s", async (_name, response, code) => {
    const annotation = makeAnnotation({ draftId: 44 });
    const { datamanager, wrapper } = makeHarness({ annotation });
    const baseline = wrapper._managedDraftBaselines.get("10:77");

    annotation.replaceResult([{ id: "updated" }]);
    datamanager.apiCall.mockResolvedValue(response);

    await expect(wrapper.ensureDurableDraft()).rejects.toMatchObject({ code });
    expect(wrapper._managedDraftBaselines.get("10:77")).toBe(baseline);
    expect(annotation.setDraftSaved).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("forces a clean new Annotation through the Draft endpoint", async () => {
    const annotation = makeAnnotation({ pk: null, id: "new-local" });
    const { datamanager, wrapper } = makeHarness({ annotation });

    datamanager.apiCall.mockResolvedValue(draftResponse({ annotation: null }));

    const receipt = await wrapper.ensureDurableDraft();

    expect(datamanager.apiCall).toHaveBeenCalledWith("createDraftForTask", { taskID: 10 }, expect.any(Object));
    expect(receipt.annotation_id).toBe("new-local");
    wrapper.destroy();
  });

  it("requires task Draft responses to carry annotation=null", async () => {
    const annotation = makeAnnotation({ pk: null, id: "new-local" });
    const { datamanager, wrapper } = makeHarness({ annotation });

    datamanager.apiCall.mockResolvedValue(draftResponse({ annotation: 77 }));

    await expect(wrapper.ensureDurableDraft()).rejects.toMatchObject({ code: "DRAFT_ANNOTATION_MISMATCH" });
    expect(annotation.draftId).toBe(0);
    wrapper.destroy();
  });

  it.each([
    ["missing task", withoutField(draftResponse(), "task"), "DRAFT_TASK_MISMATCH"],
    ["changed task", draftResponse({ task: 11 }), "DRAFT_TASK_MISMATCH"],
    ["missing annotation", withoutField(draftResponse(), "annotation"), "DRAFT_ANNOTATION_MISMATCH"],
    ["missing updated_at", withoutField(draftResponse(), "updated_at"), "MISSING_DRAFT_UPDATED_AT"],
  ])("rejects a newly created Draft with %s", async (_name, response, code) => {
    const { annotation, datamanager, wrapper } = makeHarness();
    const baseline = wrapper._managedDraftBaselines.get("10:77");

    annotation.replaceResult([{ id: "changed" }]);
    datamanager.apiCall.mockResolvedValue(response);

    await expect(wrapper.ensureDurableDraft()).rejects.toMatchObject({ code });
    expect(wrapper._managedDraftBaselines.get("10:77")).toBe(baseline);
    expect(annotation.draftId).toBe(0);
    wrapper.destroy();
  });

  it("allows ROI finalization to force its result save while navigation remains blocked", async () => {
    const { datamanager, wrapper } = makeHarness();

    wrapper.setManagedRoiRunning(true);
    datamanager.apiCall.mockResolvedValue(draftResponse());

    await expect(wrapper.ensureDurableDraft()).resolves.toMatchObject({ draft_id: 501 });
    await expect(wrapper.coordinateManagedNavigation(jest.fn())).resolves.toBe(false);
    wrapper.destroy();
  });

  it("deduplicates an in-flight save and re-saves an edit made while it is pending", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();
    const first = deferred();

    annotation.replaceResult([{ id: "first-version" }]);
    datamanager.apiCall
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(draftResponse({ id: 501, status: 200 }));

    const saveA = wrapper.ensureDurableDraft();
    const saveB = wrapper.ensureDurableDraft();

    await Promise.resolve();
    expect(datamanager.apiCall).toHaveBeenCalledTimes(1);
    annotation.replaceResult([{ id: "second-version" }]);
    first.resolve(draftResponse());

    const [receiptA, receiptB] = await Promise.all([saveA, saveB]);

    expect(datamanager.apiCall).toHaveBeenCalledTimes(2);
    expect(receiptA.serialized_hash).toBe(receiptB.serialized_hash);
    expect(wrapper._isManagedAnnotationDirty(annotation)).toBe(false);
    wrapper.destroy();
  });

  it("runs one forced save after an in-flight clean native no-op", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();

    datamanager.apiCall.mockResolvedValue(draftResponse());
    const nativeSave = wrapper.onSubmitDraft(null, annotation);
    const receipt = wrapper.ensureDurableDraft();

    await expect(nativeSave).resolves.toBeUndefined();
    await expect(receipt).resolves.toMatchObject({ draft_id: 501, revision: "2026-07-15T00:00:00Z" });
    expect(datamanager.apiCall).toHaveBeenCalledTimes(1);
    wrapper.destroy();
  });

  it("deduplicates concurrent forced saves behind one dirty in-flight request", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();
    const request = deferred();

    annotation.replaceResult([{ id: "one-forced-version" }]);
    datamanager.apiCall.mockImplementation(() => request.promise);
    const saveA = wrapper.ensureDurableDraft();
    const saveB = wrapper.ensureDurableDraft();

    await Promise.resolve();
    expect(datamanager.apiCall).toHaveBeenCalledTimes(1);
    request.resolve(draftResponse());

    const [receiptA, receiptB] = await Promise.all([saveA, saveB]);
    expect(receiptA).toBe(receiptB);
    expect(datamanager.apiCall).toHaveBeenCalledTimes(1);
    wrapper.destroy();
  });

  it("awaits the current-task PATCH and ignores its clean delayed autosave after navigation", async () => {
    const annotationB = makeAnnotation({ draftId: 44 });
    const annotationA = makeAnnotation({ pk: "88", id: "local-88" });
    const { annotationStore, datamanager, wrapper } = makeHarness({ annotation: annotationB, taskId: 10 });
    const patch = deferred();

    annotationB.replaceResult([{ id: "task-b-edit" }]);
    datamanager.apiCall.mockImplementation(() => patch.promise);

    const autosave = wrapper.onSubmitDraft(null, annotationB);

    await Promise.resolve();
    expect(datamanager.apiCall).toHaveBeenCalledWith(
      "updateDraft",
      { draftID: 44 },
      expect.objectContaining({ body: expect.objectContaining({ result: [{ id: "task-b-edit" }] }) }),
    );

    const action = jest.fn(() => {
      wrapper.task = { ...wrapper.task, id: 11, drafts: [] };
      annotationStore.annotations.push(annotationA);
      annotationStore.selected = annotationA;
      wrapper._initializeManagedDraftBaselines();
      return "navigated";
    });
    const navigation = wrapper.coordinateManagedNavigation(action, {
      intentKey: "row:11:annotation:88",
      reason: "row-click",
    });

    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();

    patch.resolve(draftResponse({ id: 44, status: 200, task: 10, annotation: 77 }));
    await expect(autosave).resolves.toMatchObject({ id: 44, task: 10, annotation: 77 });
    await expect(navigation).resolves.toBe("navigated");
    expect(wrapper._managedDraftBaselines.has("10:77")).toBe(true);
    expect(wrapper._managedDraftBaselines.has("11:88")).toBe(true);

    datamanager.apiCall.mockClear();
    await expect(wrapper.onSubmitDraft(null, annotationB)).resolves.toBeUndefined();
    expect(datamanager.apiCall).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("rejects a dirty delayed autosave after its bound task changes without mutating durable state", async () => {
    const annotationB = makeAnnotation({ draftId: 44 });
    const annotationA = makeAnnotation({ pk: "88", id: "local-88" });
    const { annotationStore, datamanager, wrapper } = makeHarness({ annotation: annotationB, taskId: 10 });
    const priorBaseline = wrapper._managedDraftBaselines.get("10:77");
    const priorReceipt = wrapper.lastPersistedDraftResult;
    const priorPending = wrapper._managedPendingDraftPayload();

    annotationB.replaceResult([{ id: "late-dirty-task-b-edit" }]);
    wrapper.task = { ...wrapper.task, id: 11, drafts: [] };
    annotationStore.annotations.push(annotationA);
    annotationStore.selected = annotationA;
    wrapper._initializeManagedDraftBaselines();

    await expect(wrapper.onSubmitDraft(null, annotationB)).rejects.toMatchObject({ code: "SOURCE_TASK_CHANGED" });
    expect(datamanager.apiCall).not.toHaveBeenCalled();
    expect(wrapper._managedDraftBaselines.get("10:77")).toBe(priorBaseline);
    expect(wrapper.lastPersistedDraftResult).toBe(priorReceipt);
    expect(wrapper._managedPendingDraftPayload()).toEqual(priorPending);
    wrapper.destroy();
  });

  it("rejects when the selected annotation identity changes during the request", async () => {
    const { annotation, annotationStore, datamanager, wrapper } = makeHarness();
    const request = deferred();
    const replacement = makeAnnotation({ pk: "88", id: "local-88" });

    annotation.replaceResult([{ id: "changed" }]);
    datamanager.apiCall.mockImplementation(() => request.promise);
    const save = wrapper.ensureDurableDraft();

    await Promise.resolve();
    annotationStore.selected = replacement;
    request.resolve(draftResponse());

    await expect(save).rejects.toMatchObject({ code: "SOURCE_ANNOTATION_CHANGED" });
    expect(annotation.setDraftSaved).not.toHaveBeenCalled();
    wrapper.destroy();
  });
});

describe("managed navigation coordination", () => {
  it("cancels native autosave before executing managed navigation", async () => {
    const { annotation, wrapper } = makeHarness();
    const action = jest.fn(() => "navigated");

    annotation.pauseAutosave.mockClear();

    await expect(wrapper.coordinateManagedNavigation(action, { reason: "row-click" })).resolves.toBe("navigated");
    expect(annotation.pauseAutosave).toHaveBeenCalledTimes(1);
    expect(annotation.pauseAutosave.mock.invocationCallOrder[0]).toBeLessThan(action.mock.invocationCallOrder[0]);
    wrapper.destroy();
  });

  it.each([
    ["Next", (wrapper, action) => (wrapper._loadTaskUncoordinated = action) && wrapper.onNextTask(11, 78)],
    ["Previous", (wrapper, action) => (wrapper._loadTaskUncoordinated = action) && wrapper.onPrevTask(9, 76)],
    ["public loadTask", (wrapper, action) => (wrapper._loadTaskUncoordinated = action) && wrapper.loadTask(11, 78)],
  ])("blocks %s until the active Draft is strictly saved", async (_name, invokeNavigation) => {
    const { annotation, datamanager, wrapper } = makeHarness();
    const request = deferred();
    const action = jest.fn();

    annotation.replaceResult([{ id: "dirty" }]);
    datamanager.apiCall.mockImplementation(() => request.promise);

    const navigation = invokeNavigation(wrapper, action);

    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
    request.resolve(draftResponse());
    await navigation;
    expect(action).toHaveBeenCalledTimes(1);
    wrapper.destroy();
  });

  it("stays on the source task when Draft save fails", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();
    const action = jest.fn();

    annotation.replaceResult([{ id: "dirty" }]);
    datamanager.apiCall.mockResolvedValue(draftResponse({ status: 409 }));
    wrapper._loadTaskUncoordinated = action;

    await expect(wrapper.onNextTask(11, 78)).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(wrapper._isManagedAnnotationDirty(annotation)).toBe(true);
    wrapper.destroy();
  });

  it("rolls an Annotation tab switch back, saves, then replays it once", async () => {
    const oldAnnotation = makeAnnotation();
    const nextAnnotation = makeAnnotation({ pk: "88", id: "local-88" });
    const { annotationStore, datamanager, wrapper } = makeHarness({ annotation: oldAnnotation });
    const request = deferred();

    annotationStore.annotations.push(nextAnnotation);
    oldAnnotation.replaceResult([{ id: "dirty-old" }]);
    annotationStore.selected = nextAnnotation;
    datamanager.apiCall.mockImplementation(() => request.promise);

    const selection = wrapper._invokeSelectAnnotation(nextAnnotation, oldAnnotation, {});

    expect(annotationStore.selected).toBe(oldAnnotation);
    request.resolve(draftResponse());
    await selection;
    expect(annotationStore.selected).toBe(nextAnnotation);
    expect(annotationStore.selectAnnotation).toHaveBeenCalledTimes(2);
    wrapper.destroy();
  });

  it("coalesces rapid B then C tabs from dirty A into one save and the latest C selection", async () => {
    const annotationA = makeAnnotation();
    const annotationB = makeAnnotation({ pk: "88", id: "local-88" });
    const annotationC = makeAnnotation({ pk: "99", id: "local-99" });
    const { annotationStore, datamanager, wrapper } = makeHarness({ annotation: annotationA });
    const request = deferred();

    annotationStore.annotations.push(annotationB, annotationC);
    annotationA.replaceResult([{ id: "dirty-a" }]);
    datamanager.apiCall.mockImplementation(() => request.promise);

    annotationStore.selected = annotationB;
    const selectionB = wrapper._invokeSelectAnnotation(annotationB, annotationA, {});
    expect(annotationStore.selected).toBe(annotationA);

    annotationStore.selected = annotationC;
    const selectionC = wrapper._invokeSelectAnnotation(annotationC, annotationA, {});
    expect(annotationStore.selected).toBe(annotationA);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(datamanager.apiCall).toHaveBeenCalledTimes(1);
    request.resolve(draftResponse());

    const [resultB, resultC] = await Promise.all([selectionB, selectionC]);
    const finalResult = {
      finalIntentKey: "annotation-tab:10:99",
      result: undefined,
      status: "coalesced",
      supersededIntentKeys: ["annotation-tab:10:88"],
    };

    expect(resultB).toEqual(finalResult);
    expect(resultC).toEqual(finalResult);
    expect(annotationStore.selected).toBe(annotationC);
    expect(annotationStore.selectAnnotation).not.toHaveBeenCalledWith(annotationB.id);
    expect(annotationStore.selectAnnotation).toHaveBeenCalledWith(annotationC.id);
    expect(datamanager.apiCall).toHaveBeenCalledTimes(1);
    wrapper.destroy();
  });

  it("keeps the previous Annotation selected when a tab-switch save fails", async () => {
    const oldAnnotation = makeAnnotation();
    const nextAnnotation = makeAnnotation({ pk: "88", id: "local-88" });
    const { annotationStore, datamanager, wrapper } = makeHarness({ annotation: oldAnnotation });

    annotationStore.annotations.push(nextAnnotation);
    oldAnnotation.replaceResult([{ id: "dirty-old" }]);
    annotationStore.selected = nextAnnotation;
    datamanager.apiCall.mockResolvedValue(draftResponse({ status: 409 }));

    await expect(wrapper._invokeSelectAnnotation(nextAnnotation, oldAnnotation, {})).resolves.toBe(false);
    expect(annotationStore.selected).toBe(oldAnnotation);
    expect(annotationStore.selectAnnotation).toHaveBeenCalledTimes(1);
    wrapper.destroy();
  });

  it("does not wait for queued/running batch work and emits a pending reminder", async () => {
    const { datamanager, wrapper } = makeHarness();
    const action = jest.fn(() => "navigated");

    wrapper.updateManagedProjectState(
      managedState({ pending_draft_count: 3, batch_state: "running" }),
      wrapper.beginManagedProjectStatePoll(),
    );

    await expect(wrapper.coordinateManagedNavigation(action, { reason: "next-task" })).resolves.toBe("navigated");
    expect(action).toHaveBeenCalledTimes(1);
    expect(datamanager.apiCall).not.toHaveBeenCalled();
    expect(datamanager.invoke).toHaveBeenCalledWith(
      "managedNavigationReminder",
      expect.objectContaining({ pendingDraftCount: 3, batchState: "running" }),
    );
    wrapper.destroy();
  });

  it("deduplicates only identical intents and ultimately executes a later row intent", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();
    const request = deferred();
    const order = [];

    annotation.replaceResult([{ id: "dirty" }]);
    datamanager.apiCall.mockImplementation(() => request.promise);

    const next = wrapper.coordinateManagedNavigation(() => order.push("next"), {
      intentKey: "next:11:annotation:78",
      reason: "next-task",
    });
    const row = wrapper.coordinateManagedNavigation(() => order.push("row"), {
      intentKey: "row:42:annotation:91",
      reason: "row-click",
    });
    const duplicateRow = wrapper.coordinateManagedNavigation(() => order.push("duplicate-row"), {
      intentKey: "row:42:annotation:91",
      reason: "row-click",
    });

    expect(duplicateRow).toBe(row);
    expect(order).toEqual([]);
    request.resolve(draftResponse());
    await Promise.all([next, row, duplicateRow]);
    expect(order).toEqual(["next", "row"]);
    wrapper.destroy();
  });

  it("cancels active and queued intents on destroy and detaches a deferred Draft response", async () => {
    jest.useFakeTimers();
    const { annotation, datamanager, wrapper } = makeHarness();
    const request = deferred();

    try {
      const activeAction = jest.fn();
      const queuedAction = jest.fn();
      const postDestroyAction = jest.fn();
      const timerAction = jest.fn();

      annotation.replaceResult([{ id: "dirty-before-destroy" }]);
      datamanager.apiCall.mockImplementation(() => request.promise);
      const active = wrapper.coordinateManagedNavigation(activeAction, {
        intentKey: "row:11:annotation:78",
        reason: "row-click",
      });
      const queued = wrapper.coordinateManagedNavigation(queuedAction, {
        intentKey: "row:12:annotation:79",
        reason: "row-click",
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(datamanager.apiCall).toHaveBeenCalledTimes(1);
      expect(wrapper._managedNavigationCurrent).not.toBeNull();
      expect(wrapper._managedNavigationQueue).toHaveLength(1);
      wrapper._selectAnnotationTimeout = setTimeout(timerAction, 1000);

      wrapper.destroy();
      await expect(active).resolves.toEqual({
        intentKey: "row:11:annotation:78",
        reason: "destroyed",
        status: "cancelled",
      });
      await expect(queued).resolves.toEqual({
        intentKey: "row:12:annotation:79",
        reason: "destroyed",
        status: "cancelled",
      });

      expect(wrapper._managedCoordinatorDestroyed).toBe(true);
      expect(wrapper._managedNavigationCurrent).toBeNull();
      expect(wrapper._managedNavigationQueue).toEqual([]);
      expect(wrapper._managedDraftSaves.size).toBe(0);
      expect(wrapper._managedDraftBaselines.size).toBe(0);
      expect(wrapper._managedLocalPendingDrafts.size).toBe(0);
      expect(wrapper._managedBeforeUnloadHandler).toBeNull();
      expect(wrapper._selectAnnotationTimeout).toBeNull();
      expect(jest.getTimerCount()).toBe(0);

      const invokeCountAfterDestroy = datamanager.invoke.mock.calls.length;

      annotation.setDraftSaving.mockClear();
      request.resolve(draftResponse());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(activeAction).not.toHaveBeenCalled();
      expect(queuedAction).not.toHaveBeenCalled();
      expect(annotation.setDraftId).not.toHaveBeenCalled();
      expect(annotation.setDraftSaved).not.toHaveBeenCalled();
      expect(annotation.setDraftSaving).not.toHaveBeenCalled();
      expect(datamanager.invoke).toHaveBeenCalledTimes(invokeCountAfterDestroy);
      expect(wrapper._managedDraftSaves.size).toBe(0);
      expect(wrapper._managedDraftBaselines.size).toBe(0);
      expect(wrapper._managedLocalPendingDrafts.size).toBe(0);

      await expect(
        wrapper.coordinateManagedNavigation(postDestroyAction, {
          intentKey: "row:13:annotation:80",
          reason: "row-click",
        }),
      ).resolves.toEqual({
        intentKey: "row:13:annotation:80",
        reason: "destroyed",
        status: "cancelled",
      });
      expect(postDestroyAction).not.toHaveBeenCalled();
      expect(timerAction).not.toHaveBeenCalled();
    } finally {
      request.resolve(draftResponse());
      if (!wrapper._managedCoordinatorDestroyed) wrapper.destroy();
      jest.useRealTimers();
    }
  });

  it("blocks close and exit controls on ROI or failed Draft save", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();

    wrapper.setManagedRoiRunning(true);
    await expect(wrapper.closeTask()).resolves.toBe(false);
    expect(datamanager.invoke).not.toHaveBeenCalledWith("closeTask");

    wrapper.setManagedRoiRunning(false);
    annotation.replaceResult([{ id: "dirty" }]);
    datamanager.apiCall.mockResolvedValue(draftResponse({ status: 500 }));
    await expect(wrapper.exitStream()).resolves.toBe(false);
    expect(datamanager.invoke).not.toHaveBeenCalledWith("navigate", "projects");
    wrapper.destroy();
  });
});

describe("managed authoritative status", () => {
  it("keeps a post-poll local Draft pending until a newer authoritative poll observes its token", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();
    const oldPoll = wrapper.beginManagedProjectStatePoll();

    annotation.replaceResult([{ id: "saved-after-poll" }]);
    datamanager.apiCall.mockResolvedValue(draftResponse());
    await wrapper.ensureDurableDraft();

    const committedMember = {
      task_id: 10,
      draft_id: 501,
      draft_updated_at: "2026-07-15T00:00:00Z",
      draft_semantic_hash: "sha256:same",
      committed_semantic_hash: "sha256:same",
    };

    wrapper.updateManagedProjectState(managedState({ version: 1, members: [committedMember] }), oldPoll);
    expect(wrapper.getManagedStatusState()).toMatchObject({
      taskSemanticState: "Draft",
      pendingDraftCount: 1,
      local: { pendingTaskCount: 1, authority: false },
    });

    const observingPoll = wrapper.beginManagedProjectStatePoll();
    wrapper.updateManagedProjectState(managedState({ version: 2, members: [committedMember] }), observingPoll);
    expect(wrapper.getManagedStatusState()).toMatchObject({
      taskSemanticState: "Committed",
      pendingDraftCount: 0,
      local: { pendingTaskCount: 0, authority: false },
    });
    wrapper.destroy();
  });

  it("adds a post-poll local task to the cached authoritative pending count", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();
    const poll = wrapper.beginManagedProjectStatePoll();

    annotation.replaceResult([{ id: "new-local-task-version" }]);
    datamanager.apiCall.mockResolvedValue(draftResponse());
    await wrapper.ensureDurableDraft();
    wrapper.updateManagedProjectState(managedState({ pending_draft_count: 3 }), poll);

    expect(wrapper.getManagedStatusState()).toMatchObject({
      pendingDraftCount: 4,
      local: { pendingTaskCount: 1 },
    });
    expect(wrapper._managedPendingDraftPayload()).toMatchObject({
      authoritativePendingCount: 3,
      localPendingTaskCount: 1,
      postPollLocalPendingTaskCount: 1,
    });
    wrapper.destroy();
  });

  it("never calls a browser hash authoritative and never claims Committed without matching server hashes", () => {
    const { wrapper } = makeHarness();

    wrapper.updateManagedProjectState(
      managedState({
        members: [{ task_id: 10, draft_semantic_hash: "sha256:draft", committed_semantic_hash: "sha256:base" }],
      }),
      wrapper.beginManagedProjectStatePoll(),
    );
    const state = wrapper.getManagedStatusState();

    expect(state.taskSemanticState).toBe("Draft");
    expect(state.local.browserSemanticProjectionHash).toMatch(/^fnv1a32:/);
    expect(state.local.authority).toBe(false);
    expect(state.authority.members[0]).toMatchObject({
      draft_semantic_hash: "sha256:draft",
      committed_semantic_hash: "sha256:base",
    });
    wrapper.destroy();
  });

  it("ignores stale or conflicting status projections and preserves a persistent observable error", () => {
    const { datamanager, wrapper } = makeHarness();
    const olderPoll = wrapper.beginManagedProjectStatePoll();
    const newestPoll = wrapper.beginManagedProjectStatePoll();

    wrapper.updateManagedProjectState(managedState({ generation: 2, version: 4, pending_draft_count: 2 }), newestPoll);
    wrapper.updateManagedProjectState(managedState({ generation: 1, version: 99, pending_draft_count: 0 }), olderPoll);
    expect(wrapper.getManagedStatusState()).toMatchObject({ generation: 2, version: 4, pendingDraftCount: 2 });

    wrapper.updateManagedProjectState(
      managedState({ generation: 2, version: 4, pending_draft_count: 0 }),
      wrapper.beginManagedProjectStatePoll(),
    );
    expect(wrapper.getManagedStatusState()).toMatchObject({
      generation: 2,
      version: 4,
      pendingDraftCount: 2,
      error: { code: "STATUS_VERSION_CONFLICT", domain: "status" },
    });
    expect(datamanager.invoke).toHaveBeenCalledWith(
      "managedStatusChanged",
      expect.objectContaining({ error: expect.objectContaining({ code: "STATUS_VERSION_CONFLICT" }) }),
    );

    wrapper.clearManagedStatusError();
    expect(wrapper.getManagedStatusState().error).toBeNull();
    wrapper.destroy();
  });

  it("keeps Draft-save errors until successful save or explicit clear", async () => {
    const { annotation, datamanager, wrapper } = makeHarness();

    annotation.replaceResult([{ id: "dirty" }]);
    datamanager.apiCall.mockResolvedValueOnce(draftResponse({ status: 500 }));
    await expect(wrapper.ensureDurableDraft()).rejects.toMatchObject({ code: "DRAFT_HTTP_ERROR" });
    expect(wrapper.getManagedStatusState().error).toMatchObject({ code: "DRAFT_HTTP_ERROR", domain: "draft" });

    wrapper.onEntityCreate({ id: "non-clearing-edit-event" });
    expect(wrapper.getManagedStatusState().error).toMatchObject({ code: "DRAFT_HTTP_ERROR" });

    datamanager.apiCall.mockResolvedValueOnce(draftResponse());
    await wrapper.ensureDurableDraft();
    expect(wrapper.getManagedStatusState().error).toBeNull();
    wrapper.destroy();
  });
});

describe("managed beforeunload", () => {
  const event = () => ({ preventDefault: jest.fn(), returnValue: undefined });

  it("warns only for an unsaved local semantic payload", async () => {
    const { annotation, wrapper } = makeHarness();
    const cleanEvent = event();

    wrapper.updateManagedProjectState(
      managedState({ pending_draft_count: 2, batch_state: "queued" }),
      wrapper.beginManagedProjectStatePoll(),
    );
    expect(wrapper._handleManagedBeforeUnload(cleanEvent)).toBeUndefined();
    expect(cleanEvent.preventDefault).not.toHaveBeenCalled();

    annotation.replaceResult([{ id: "dirty" }]);
    const dirtyEvent = event();
    expect(wrapper._handleManagedBeforeUnload(dirtyEvent)).toBe("");
    expect(dirtyEvent.preventDefault).toHaveBeenCalledTimes(1);

    const { wrapper: cleanWrapper } = makeHarness();

    cleanWrapper.setManagedRoiRunning(true);
    const roiEvent = event();
    expect(cleanWrapper._handleManagedBeforeUnload(roiEvent)).toBeUndefined();
    expect(roiEvent.preventDefault).not.toHaveBeenCalled();
    cleanWrapper.destroy();
    wrapper.destroy();
  });

  it("does not warn for a clean forced save in flight or a persisted Draft", async () => {
    const { datamanager, wrapper } = makeHarness();
    const request = deferred();

    datamanager.apiCall.mockImplementation(() => request.promise);
    const saving = wrapper.ensureDurableDraft();
    await Promise.resolve();

    const savingEvent = event();
    expect(wrapper._isManagedAnnotationDirty()).toBe(false);
    expect(wrapper._handleManagedBeforeUnload(savingEvent)).toBeUndefined();
    expect(savingEvent.preventDefault).not.toHaveBeenCalled();

    request.resolve(draftResponse());
    await saving;
    const persistedEvent = event();
    expect(wrapper._handleManagedBeforeUnload(persistedEvent)).toBeUndefined();
    wrapper.destroy();
  });

  it("does not install a warning for an ordinary project", () => {
    const { annotation, wrapper } = makeHarness({ managed: false });

    annotation.replaceResult([{ id: "ordinary-dirty" }]);
    expect(wrapper.hasManagedUnsavedWork()).toBe(false);
    expect(wrapper._managedBeforeUnloadHandler).toBeUndefined();
    wrapper.destroy();
  });

  it("ignores persisted presentation metadata while detecting bbox changes", () => {
    const initialResult = [
      {
        id: "region-1",
        type: "rectanglelabels",
        value: { x: 1, y: 2, width: 3, height: 4, rectanglelabels: ["person"] },
        meta: { stable_region_key: "region-1", visual_policy_v1: { color: "#ff0000" } },
      },
    ];
    const annotation = makeAnnotation({ initialResult });
    const { wrapper } = makeHarness({ annotation });

    annotation.replaceResult([
      {
        ...initialResult[0],
        meta: { ...initialResult[0].meta, visual_policy_v1: { color: "#00ff00" } },
      },
    ]);
    expect(wrapper._isManagedAnnotationDirty()).toBe(false);
    expect(wrapper._handleManagedBeforeUnload(event())).toBeUndefined();

    annotation.replaceResult([{ ...initialResult[0], value: { ...initialResult[0].value, width: 5 } }]);
    expect(wrapper._isManagedAnnotationDirty()).toBe(true);
    wrapper.destroy();
  });

  it("requires an exact boolean ROI-running state", () => {
    const { wrapper } = makeHarness();

    expect(() => wrapper.setManagedRoiRunning(1)).toThrow(TypeError);
    expect(() => wrapper.setManagedRoiRunning("false")).toThrow(TypeError);
    expect(wrapper.getManagedStatusState().local.roiRunning).toBe(false);
    wrapper.destroy();
  });
});

describe("ordinary project regression", () => {
  it("keeps the native Draft save path even when task data resembles a managed task", async () => {
    const annotation = makeAnnotation();
    annotation.history.hasChanges = true;
    annotation.saveDraftImmediatelyWithResults = jest.fn(() => Promise.resolve(draftResponse({ status: 200 })));
    const { datamanager, wrapper } = makeHarness({ managed: false, annotation });

    await wrapper.saveDraft();

    expect(annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(1);
    expect(datamanager.apiCall).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("exports a stable typed error", () => {
    const error = new CoordExpDraftSaveError("EXAMPLE", "safe message");

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "CoordExpDraftSaveError", code: "EXAMPLE", message: "safe message" });
  });
});
