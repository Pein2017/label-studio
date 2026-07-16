if (typeof globalThis.structuredClone === "undefined") {
  globalThis.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
}
if (typeof globalThis.URL.createObjectURL === "undefined") {
  globalThis.URL.createObjectURL = jest.fn(() => "blob:coordexp-test");
}

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("keymaster", () => {
  const keymaster = () => {};
  keymaster.unbind = () => {};
  keymaster.setScope = () => {};
  return { __esModule: true, default: keymaster };
});

import "../../tags/visual/View";
import "../../tags/object/Image";
import "../../tags/control/RectangleLabels";
import { ImageModel } from "../../tags/object/Image/Image";
import AppStore from "../../stores/AppStore";
import { CoordExpRefinementClient } from "../../services/coordexp-refinement-api";
import { DATA_MANAGER_READY_EVENT } from "../../services/data-manager-ready";
import {
  CoordExpAIRegion,
  CoordExpAIRegionMount,
  isAIRegionMountTarget,
  resolveAIRegionDataManager,
} from "./CoordExpAIRegion";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const BROWSER_HASH = "fnv1a32:browser";
const profile = {
  selector: "safe",
  display_label: "Safe",
  default_canvas: { width: 1024, height: 1024 },
  processor_factor: 32,
  bounds: { min_axis_pixels: 32, max_axis_pixels: 2048, max_total_pixels: 1572864 },
  generation_deadline_seconds: 20,
};

const produced = () => {
  const key = `roi:${REQUEST_ID}:1`;
  const result = {
    id: key,
    type: "rectanglelabels",
    from_name: "bbox",
    to_name: "image",
    original_width: 800,
    original_height: 600,
    image_rotation: 0,
    value: {
      x: (100 * 100) / 999,
      y: (200 * 100) / 999,
      width: (300 * 100) / 999,
      height: (400 * 100) / 999,
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
  };

  return {
    receipt_id: `roi-receipt:${REQUEST_ID}`,
    request_id: REQUEST_ID,
    request_state: "produced",
    terminal_status: null,
    clear_roi: false,
    insertion_payload: {
      mode: "append_one_undo_action",
      target: {
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
      },
      regions: [
        {
          result_id: `${REQUEST_ID}:result-0`,
          category_name: "person",
          category_id: 1,
          bbox_2d: [100, 200, 400, 600],
          request_id: REQUEST_ID,
          parser_object_span_id: "span-1",
          source_draft_revision: "revision-2",
          region_key: key,
          label_studio_result: result,
        },
      ],
    },
    failure: null,
    counts: { parsed: 1, produced: 1, rejected: 0 },
  };
};

const draftReceipt = (updates = {}) => ({
  task_id: 17,
  annotation_id: 9,
  draft_id: 5,
  status: 200,
  revision: "revision-2",
  serialized_hash: "fnv1a32:serialized",
  browser_semantic_projection_hash: BROWSER_HASH,
  authoritative_semantic_hash: null,
  ...updates,
});

const abandoned = (reason, updates = {}) => ({
  receipt_id: `roi-receipt:${REQUEST_ID}`,
  request_id: REQUEST_ID,
  request_state: "abandoned_before_insertion",
  terminal_status: "abandoned_before_insertion",
  clear_roi: false,
  insertion_payload: null,
  failure: { stage: "insertion", code: reason },
  counts: { parsed: 1, inserted: 0, rejected: 0 },
  ...updates,
});

const managedStatus = ({
  generation = 1,
  version = 1,
  terminalState = null,
  taskSemanticState = "Draft",
  member = {},
  local = {},
} = {}) => ({
  generation,
  version,
  taskSemanticState,
  authority: {
    last_terminal_batch: terminalState === null ? null : { state: terminalState },
    members: [
      {
        task_id: 17,
        task_key: "train:42",
        last_terminal_batch_member: terminalState !== null,
        draft_matches_last_terminal_batch: false,
        draft_ahead_of_committed: true,
        pending: true,
        ...member,
      },
    ],
  },
  local: {
    dirty: false,
    saveInFlight: false,
    roiRunning: false,
    pendingTaskCount: 0,
    browserSemanticProjectionHash: BROWSER_HASH,
    ...local,
  },
});

const retiredStatus = (updates = {}) =>
  managedStatus({
    terminalState: "succeeded",
    taskSemanticState: "Committed",
    member: {
      last_terminal_batch_member: true,
      draft_matches_last_terminal_batch: true,
      draft_ahead_of_committed: false,
      pending: false,
    },
    ...updates,
  });

const setup = ({
  save = jest.fn().mockResolvedValue(draftReceipt()),
  inferResponse = produced(),
  inferImpl,
  imageOverrides = {},
  imageInstance,
  annotationInstance,
  annotationResults = [],
  profiles = [profile],
  abandonImpl,
  initialManagedStatus,
  useDefaultClient = false,
} = {}) => {
  const resultModel = {
    meta: produced().insertion_payload.regions[0].label_studio_result.meta,
    setMetaValue: jest.fn(),
  };
  const mockAnnotation = {
    id: 9,
    draftId: 5,
    draftSaved: "revision-2",
    serialized: annotationResults,
    regions: [{ results: [resultModel], cleanId: `roi:${REQUEST_ID}:1` }],
    history: { isFrozen: false, freeze: jest.fn(), abortFreeze: jest.fn(() => true), unfreeze: jest.fn() },
    appendResultsAtomically: jest.fn(() => [{ presentationRegionKey: `roi:${REQUEST_ID}:1` }]),
  };
  const annotation = annotationInstance ?? mockAnnotation;
  let image = imageInstance;

  if (!image) {
    image = {
      aiRegion: { x: 25, y: 10, width: 50, height: 40 },
      aiRegionRunning: false,
      aiRegionDrawEnabled: false,
      regionPresentationMode: "show_all",
      selectedRegions: [],
      setAIRegionRunning: jest.fn((running) => {
        image.aiRegionRunning = running;
      }),
      finishAIRegion: jest.fn(({ clear }) => {
        if (clear) image.aiRegion = null;
        image.aiRegionDrawEnabled = false;
        image.aiRegionRunning = false;
      }),
      setAIRegionDrawEnabled: jest.fn(),
      setRegionPresentation: jest.fn(),
      restoreRegionPresentation: jest.fn(),
      setInferenceRegionPresentation: jest.fn(),
      clearInferenceRegionPresentations: jest.fn(),
      focusInferenceGroup: jest.fn(),
      ...imageOverrides,
    };
  }
  const client = {
    profiles: jest.fn().mockResolvedValue({ profiles }),
    infer: jest.fn(inferImpl ?? (() => Promise.resolve({ payload: inferResponse }))),
    abandon: jest.fn(abandonImpl ?? (({ reason }) => Promise.resolve({ payload: abandoned(reason), status: 200 }))),
  };
  const statusRef = { hash: BROWSER_HASH, status: initialManagedStatus ?? managedStatus() };
  const listeners = new Map();
  const dataManager = {
    ensureDurableDraft: save,
    setManagedRoiRunning: jest.fn(),
    getManagedStatusState: jest.fn(() => ({
      ...statusRef.status,
      local: { ...statusRef.status.local, browserSemanticProjectionHash: statusRef.hash },
    })),
    on: jest.fn((event, listener) => listeners.set(event, listener)),
    off: jest.fn((event, listener) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    }),
    emitManagedStatus(next) {
      statusRef.status = next;
      listeners.get("managedStatusChanged")?.(next);
    },
  };
  const store = { project: null, task: { id: 17, dataObj: { coordexp_task_key: "train:42" } } };
  const clientFactory = () => client;
  const requestIdFactory = () => REQUEST_ID;
  const renderComponent = (overrides = {}) => (
    <CoordExpAIRegion
      store={store}
      dataManager={dataManager}
      annotation={annotation}
      image={image}
      projectId={7}
      taskId={17}
      requestIdFactory={requestIdFactory}
      {...(useDefaultClient ? {} : { clientFactory })}
      {...overrides}
    />
  );

  const view = render(renderComponent());
  return { annotation, image, client, clientFactory, dataManager, renderComponent, statusRef, store, ...view };
};

const createRealImage = () => {
  const image = ImageModel.create({
    name: "image",
    value: "$image",
    type: "image",
    zoomby: "1.2",
    crossorigin: "anonymous",
    horizontalalignment: "left",
    verticalalignment: "top",
    defaultzoom: "fit",
  });

  image.setAIRegion({ x: 25, y: 10, width: 50, height: 40 });
  image.setAIRegionDrawEnabled(true);
  return image;
};

const createRealAnnotation = (results = []) => {
  const store = AppStore.create(
    {
      config: `<View>
        <Image name="image" value="$image" />
        <RectangleLabels name="bbox" toName="image"><Label value="person" /></RectangleLabels>
      </View>`,
      task: {
        id: 17,
        data: JSON.stringify({
          image: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
        }),
      },
      interfaces: ["basic"],
    },
    {
      events: { hasEvent: jest.fn(() => false), invoke: jest.fn() },
      messages: {},
      settings: {},
    },
  );

  store.initializeStore({});
  const annotation = store.annotationStore.addAnnotation({ id: 9, result: [] });
  store.annotationStore.selectAnnotation(annotation.id);
  if (results.length > 0) {
    annotation.deserializeResults(results);
    annotation.updateObjects();
    annotation.history.reinit();
  }
  annotation.setDraftId(5);
  annotation.setDraftSaved("revision-2");
  return { store, annotation, image: annotation.names.get("image") };
};

const expectSemanticInferenceOnly = (results) => {
  expect(results).toHaveLength(1);
  expect(results[0].meta).toEqual({
    coordexp_region_key: `roi:${REQUEST_ID}:1`,
    coordexp_inference_receipt_id: `roi-receipt:${REQUEST_ID}`,
    coordexp_inference_request_id: REQUEST_ID,
    coordexp_inference_result_id: `${REQUEST_ID}:result-0`,
    coordexp_inference_source_draft_revision: "revision-2",
  });
  expect(JSON.stringify(results)).not.toMatch(
    /visual_policy_v1|stable_region_key|coordexp_visual_presentation|visual_policy_presentation|numeric_badge|advisory_conflict|duplicate_iou|neighborhood_expansion|"color"/,
  );
};

const cloneCandidate = (
  source,
  { editorStore = source.lsf.lsfInstance.store, projectId = source.lsf.project.id } = {},
) => {
  const project = { id: projectId };
  const ownerStore = { project };
  const candidate = {
    ...source,
    projectId,
    store: ownerStore,
    on: jest.fn(),
    off: jest.fn(),
  };

  candidate.lsf = {
    ...source.lsf,
    datamanager: candidate,
    store: ownerStore,
    project,
    task: { id: editorStore.task.id },
    lsfInstance: { store: editorStore },
  };
  return candidate;
};

const mountHarness = ({
  managed = true,
  selected = true,
  imageTags = "one",
  imageOverrides = {},
  candidateOverrides = {},
  candidateMode = "explicit",
  projectId = 7,
  candidateProjectId = 7,
  storeProject = null,
  candidateMutator,
} = {}) => {
  const image = {
    type: "image",
    isMultiItem: false,
    valuelist: null,
    parsedValue: "image.jpg",
    images: ["image.jpg"],
    aiRegion: null,
    aiRegionRunning: false,
    aiRegionDrawEnabled: false,
    regionPresentationMode: "show_all",
    selectedRegions: [],
    setAIRegionRunning: jest.fn(),
    finishAIRegion: jest.fn(),
    setAIRegionDrawEnabled: jest.fn(),
    setRegionPresentation: jest.fn(),
    restoreRegionPresentation: jest.fn(),
    setInferenceRegionPresentation: jest.fn(),
    clearInferenceRegionPresentations: jest.fn(),
    focusInferenceGroup: jest.fn(),
    ...imageOverrides,
  };
  const annotation = { id: 9, serialized: [], names: new Map() };

  if (imageTags === "one") annotation.names.set("image", image);
  if (imageTags === "multiple") {
    annotation.names.set("image", image);
    annotation.names.set("image2", { ...image, name: "image2" });
  }
  const store = {
    project: storeProject,
    task: { id: 17, dataObj: { coordexp_task_key: "train:42" } },
    annotationStore: { selected: selected ? annotation : { id: 10 } },
  };
  const listeners = new Map();
  const project = { id: candidateProjectId };
  const ownerStore = { project };
  const dataManager = {
    projectId,
    store: ownerStore,
    lsf: {
      datamanager: null,
      store: ownerStore,
      project,
      task: { id: store.task.id },
      lsfInstance: { store },
      isManagedRefinementProject: managed,
    },
    ensureDurableDraft: jest.fn(),
    setManagedRoiRunning: jest.fn(),
    getManagedStatusState: jest.fn(() => managedStatus()),
    on: jest.fn((event, listener) => listeners.set(event, listener)),
    off: jest.fn((event, listener) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    }),
    ...candidateOverrides,
  };
  dataManager.lsf.datamanager = dataManager;
  candidateMutator?.(dataManager);
  const client = {
    profiles: jest.fn().mockResolvedValue({ profiles: [profile] }),
    infer: jest.fn(),
    abandon: jest.fn(),
  };
  const clientFactory = jest.fn(() => client);
  if (candidateMode === "window") window.dataManager = dataManager;
  if (candidateMode === "none") window.dataManager = null;
  const view = render(
    <CoordExpAIRegionMount
      store={store}
      image={image}
      annotation={annotation}
      candidate={candidateMode === "explicit" ? dataManager : undefined}
      clientFactory={clientFactory}
    />,
  );

  return { ...view, store, annotation, image, dataManager, client, clientFactory };
};

describe("CoordExpAIRegionMount", () => {
  const publish = (dataManager, detail = dataManager) => {
    window.dataManager = dataManager;
    window.dispatchEvent(new CustomEvent(DATA_MANAGER_READY_EVENT, { detail }));
  };

  afterEach(() => {
    delete window.dataManager;
    jest.restoreAllMocks();
  });

  it.each([
    ["candidate back-reference", (dataManager) => (dataManager.lsf.datamanager = {})],
    ["owner-store back-reference", (dataManager) => (dataManager.lsf.store = { project: dataManager.lsf.project })],
    ["canonical project object", (dataManager) => (dataManager.lsf.project = { id: 7 })],
    ["task identity", (dataManager) => (dataManager.lsf.task = { id: 18 })],
  ])("rejects a mismatched %s", (_name, candidateMutator) => {
    const { store, dataManager } = mountHarness({ candidateMutator });

    expect(resolveAIRegionDataManager(store, dataManager)).toBeNull();
    expect(screen.queryByLabelText("AI Region inference")).not.toBeInTheDocument();
  });

  it("mounts only the selected annotation's sole ordinary configured Image tag for a managed resolver", async () => {
    const { clientFactory, dataManager } = mountHarness();

    expect(await screen.findByLabelText("AI Region inference")).toBeInTheDocument();
    expect(dataManager.on).toHaveBeenCalledWith("managedStatusChanged", expect.any(Function));
    expect(clientFactory).toHaveBeenCalledWith(7);
  });

  it("uses the owning candidate project even when a legacy editor project differs", async () => {
    const { clientFactory } = mountHarness({ storeProject: { id: 999 } });

    expect(await screen.findByLabelText("AI Region inference")).toBeInTheDocument();
    expect(clientFactory).toHaveBeenCalledWith(7);
  });

  it.each([
    ["ordinary project", { managed: false }],
    ["selected annotation mismatch", { selected: false }],
    ["no configured Image tag", { imageTags: "none" }],
    ["multiple configured Image tags", { imageTags: "multiple" }],
    [
      "value-list Image tag",
      { imageOverrides: { isMultiItem: true, valuelist: "$images", parsedValue: ["a", "b"], images: ["a", "b"] } },
    ],
    ["ordinary value resolving multiple images", { imageOverrides: { parsedValue: ["a", "b"], images: ["a", "b"] } }],
    ["resolver without event subscription", { candidateOverrides: { on: undefined } }],
    ["resolver without event unsubscription", { candidateOverrides: { off: undefined } }],
    ["candidate project-id mismatch", { projectId: 8 }],
    ["missing canonical candidate project", { candidateProjectId: null }],
  ])("fails closed for %s", (_name, options) => {
    mountHarness(options);

    expect(screen.queryByLabelText("AI Region inference")).not.toBeInTheDocument();
  });

  it("fails closed when annotation names are missing or not iterable", () => {
    const image = { type: "image", isMultiItem: false, valuelist: null, parsedValue: "x", images: ["x"] };
    const annotation = { names: { values: () => null } };
    const store = { annotationStore: { selected: annotation } };

    expect(isAIRegionMountTarget(store, annotation, image)).toBe(false);
    annotation.names = undefined;
    expect(isAIRegionMountTarget(store, annotation, image)).toBe(false);
  });

  it("mounts from readiness both before mount and after an initial null render", async () => {
    const before = mountHarness({ candidateMode: "window" });

    expect(await screen.findByLabelText("AI Region inference")).toBeInTheDocument();
    before.unmount();

    const after = mountHarness({ candidateMode: "none" });

    expect(screen.queryByLabelText("AI Region inference")).not.toBeInTheDocument();
    act(() => publish(after.dataManager));
    expect(await screen.findByLabelText("AI Region inference")).toBeInTheDocument();
  });

  it("ignores malformed and other-store readiness events", async () => {
    const harness = mountHarness({ candidateMode: "none" });
    const otherStore = { ...harness.store };
    const otherManager = cloneCandidate(harness.dataManager, { editorStore: otherStore });

    act(() => publish(otherManager));
    expect(screen.queryByLabelText("AI Region inference")).not.toBeInTheDocument();
    act(() => publish(harness.dataManager, { malformed: true }));
    expect(screen.queryByLabelText("AI Region inference")).not.toBeInTheDocument();
    act(() => publish(harness.dataManager));
    expect(await screen.findByLabelText("AI Region inference")).toBeInTheDocument();
  });

  it("keeps explicit candidate precedence and removes the exact readiness listener", () => {
    const addEventListener = jest.spyOn(window, "addEventListener");
    const removeEventListener = jest.spyOn(window, "removeEventListener");
    const explicit = mountHarness();
    const replacement = cloneCandidate(explicit.dataManager);

    act(() => publish(replacement));
    expect(explicit.dataManager.on).toHaveBeenCalledWith("managedStatusChanged", expect.any(Function));
    expect(replacement.on).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalledWith(DATA_MANAGER_READY_EVENT, expect.any(Function));
    explicit.unmount();

    const subscribed = mountHarness({ candidateMode: "window" });
    const listener = addEventListener.mock.calls.find(([name]) => name === DATA_MANAGER_READY_EVENT)?.[1];

    expect(listener).toEqual(expect.any(Function));
    subscribed.unmount();
    expect(removeEventListener).toHaveBeenCalledWith(DATA_MANAGER_READY_EVENT, listener);
  });

  it("replaces the manager and resets across a project-store transition", async () => {
    const harness = mountHarness({ candidateMode: "window" });
    const replacement = cloneCandidate(harness.dataManager);

    expect(await screen.findByLabelText("AI Region inference")).toBeInTheDocument();
    act(() => publish(replacement));
    expect(harness.dataManager.off).toHaveBeenCalledWith("managedStatusChanged", expect.any(Function));
    expect(replacement.on).toHaveBeenCalledWith("managedStatusChanged", expect.any(Function));

    const storeB = {
      ...harness.store,
      project: null,
      annotationStore: { selected: harness.annotation },
    };
    const managerB = cloneCandidate(harness.dataManager, { editorStore: storeB, projectId: 8 });

    harness.rerender(
      <CoordExpAIRegionMount
        store={storeB}
        image={harness.image}
        annotation={harness.annotation}
        clientFactory={() => harness.client}
      />,
    );
    expect(screen.queryByLabelText("AI Region inference")).not.toBeInTheDocument();

    act(() => publish(managerB));
    expect(await screen.findByLabelText("AI Region inference")).toBeInTheDocument();
  });

  it("fails closed when the sole configured Image tag is not the supplied Image identity", () => {
    const image = { type: "image", isMultiItem: false, valuelist: null, parsedValue: "x", images: ["x"] };
    const configuredImage = { ...image };
    const annotation = { names: new Map([["image", configuredImage]]) };
    const store = { annotationStore: { selected: annotation } };

    expect(isAIRegionMountTarget(store, annotation, image)).toBe(false);
  });
});

describe("CoordExpAIRegion", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps the default client and active attempt stable through running and status rerenders", async () => {
    let resolveFrozenDraft;
    const frozenDraft = new Promise((resolve) => {
      resolveFrozenDraft = resolve;
    });
    const save = jest
      .fn()
      .mockImplementationOnce(() => frozenDraft)
      .mockResolvedValue(draftReceipt());
    const profiles = jest
      .spyOn(CoordExpRefinementClient.prototype, "profiles")
      .mockResolvedValue({ profiles: [profile] });
    const infer = jest.spyOn(CoordExpRefinementClient.prototype, "infer").mockResolvedValue({ payload: produced() });
    const abandon = jest
      .spyOn(CoordExpRefinementClient.prototype, "abandon")
      .mockImplementation(({ reason }) => Promise.resolve({ payload: abandoned(reason), status: 200 }));
    const harness = setup({ save, useDefaultClient: true });

    await screen.findByRole("option", { name: "Safe" });
    expect(profiles).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

    act(() => harness.dataManager.emitManagedStatus(managedStatus({ version: 2 })));
    expect(profiles).toHaveBeenCalledTimes(1);
    expect(abandon).not.toHaveBeenCalled();

    act(() => resolveFrozenDraft(draftReceipt()));
    await waitFor(() => expect(infer).toHaveBeenCalledTimes(1));
    await screen.findByText(/Inserted 1\./);
    expect(save).toHaveBeenCalledTimes(2);
    expect(profiles).toHaveBeenCalledTimes(1);
    expect(abandon).not.toHaveBeenCalled();
    harness.unmount();
  });

  it("resets lifecycle and status ownership across a same-project manager and image replacement", async () => {
    const inferenceResult = produced().insertion_payload.regions[0].label_studio_result;
    const harness = setup({
      annotationResults: [inferenceResult],
      initialManagedStatus: retiredStatus({ generation: 9, version: 9 }),
    });

    await screen.findByRole("option", { name: "Safe" });
    expect(harness.client.profiles).toHaveBeenCalledTimes(1);

    const replacementListeners = new Map();
    const replacementStatus = managedStatus({ generation: 1, version: 1 });
    const replacementManager = {
      ensureDurableDraft: jest.fn().mockResolvedValue(draftReceipt()),
      setManagedRoiRunning: jest.fn(),
      getManagedStatusState: jest.fn(() => replacementStatus),
      on: jest.fn((event, listener) => replacementListeners.set(event, listener)),
      off: jest.fn((event, listener) => {
        if (replacementListeners.get(event) === listener) replacementListeners.delete(event);
      }),
    };
    let replacementImage;

    replacementImage = {
      ...harness.image,
      aiRegion: { x: 25, y: 10, width: 50, height: 40 },
      aiRegionRunning: false,
      setAIRegionRunning: jest.fn((running) => {
        replacementImage.aiRegionRunning = running;
      }),
      finishAIRegion: jest.fn(({ clear }) => {
        if (clear) replacementImage.aiRegion = null;
        replacementImage.aiRegionRunning = false;
      }),
      setInferenceRegionPresentation: jest.fn(),
      clearInferenceRegionPresentations: jest.fn(),
      focusInferenceGroup: jest.fn(),
    };

    harness.rerender(harness.renderComponent({ dataManager: replacementManager, image: replacementImage }));
    await waitFor(() =>
      expect(replacementManager.on).toHaveBeenCalledWith("managedStatusChanged", expect.any(Function)),
    );
    await waitFor(() => expect(replacementImage.setInferenceRegionPresentation).toHaveBeenCalled());
    expect(replacementImage.clearInferenceRegionPresentations).not.toHaveBeenCalled();
    expect(harness.client.profiles).toHaveBeenCalledTimes(1);

    act(() => harness.dataManager.emitManagedStatus(retiredStatus({ generation: 10, version: 10 })));
    expect(replacementImage.clearInferenceRegionPresentations).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    await screen.findByText(/Inserted 1\./);
    expect(harness.client.infer).toHaveBeenCalledTimes(1);
    expect(harness.annotation.appendResultsAtomically).toHaveBeenCalledTimes(1);
    expect(replacementManager.ensureDurableDraft).toHaveBeenCalledTimes(2);
    expect(harness.client.abandon).not.toHaveBeenCalled();
  });

  it("still abandons an active attempt on a genuine unmount", async () => {
    let resolveInfer;
    const inferPromise = new Promise((resolve) => {
      resolveInfer = resolve;
    });
    const harness = setup({ inferImpl: () => inferPromise });

    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    await waitFor(() => expect(harness.client.infer).toHaveBeenCalledTimes(1));
    harness.unmount();
    await waitFor(() =>
      expect(harness.client.abandon).toHaveBeenCalledWith({
        receiptId: `roi-receipt:${REQUEST_ID}`,
        reason: "user_discarded",
      }),
    );
    act(() => resolveInfer({ payload: produced() }));
  });

  it("still abandons an active attempt when its task target changes", async () => {
    let resolveInfer;
    const inferPromise = new Promise((resolve) => {
      resolveInfer = resolve;
    });
    const harness = setup({ inferImpl: () => inferPromise });

    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    await waitFor(() => expect(harness.client.infer).toHaveBeenCalledTimes(1));
    const nextStore = {
      ...harness.store,
      task: { id: 18, dataObj: { coordexp_task_key: "train:43" } },
    };

    harness.rerender(harness.renderComponent({ store: nextStore, taskId: 18 }));
    act(() => resolveInfer({ payload: produced() }));
    await waitFor(() =>
      expect(harness.client.abandon).toHaveBeenCalledWith({
        receiptId: `roi-receipt:${REQUEST_ID}`,
        reason: "superseded",
      }),
    );
    expect(harness.annotation.appendResultsAtomically).not.toHaveBeenCalled();
  });

  it("switches Dense Focus overlays using stable selected keys without semantic mutation or saving", async () => {
    const save = jest.fn().mockResolvedValue({ draft_id: 5 });
    const { annotation, image } = setup({
      save,
      imageOverrides: {
        selectedRegions: [
          { id: "runtime-1", presentationRegionKey: "stable-1" },
          { id: "runtime-2", presentationRegionKey: "stable-2" },
        ],
      },
    });
    const before = JSON.stringify(annotation.serialized);

    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Dim non-selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide non-selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));

    expect(image.setRegionPresentation).toHaveBeenNthCalledWith(1, "dim_non_selected", ["stable-1", "stable-2"]);
    expect(image.setRegionPresentation).toHaveBeenNthCalledWith(2, "hide_non_selected", ["stable-1", "stable-2"]);
    expect(image.restoreRegionPresentation).toHaveBeenCalledTimes(1);
    expect(annotation.appendResultsAtomically).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(annotation.serialized)).toBe(before);
  });

  it("disables Dense Focus dim and hide actions without a selected region", async () => {
    setup();

    await screen.findByRole("option", { name: "Safe" });
    expect(screen.getByRole("button", { name: "Dim non-selected" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Hide non-selected" })).toBeDisabled();
  });

  it.each([
    ["accepted", produced(), /Inserted 1\./, 2],
    [
      "empty",
      {
        ...produced(),
        request_state: "empty",
        terminal_status: "empty",
        clear_roi: true,
        insertion_payload: null,
        counts: { parsed: 0, produced: 0, rejected: 0 },
      },
      /No objects found/,
      1,
    ],
    [
      "all_rejected",
      {
        ...produced(),
        request_state: "all_rejected",
        terminal_status: "all_rejected",
        clear_roi: true,
        insertion_payload: null,
        counts: { parsed: 1, produced: 0, rejected: 1 },
      },
      /All 1 results were rejected/,
      1,
    ],
  ])("uses the real Image MST terminal action for %s", async (_state, inferResponse, message, saveCalls) => {
    const image = createRealImage();
    const { dataManager } = setup({ imageInstance: image, inferResponse });

    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    await screen.findByText(message);

    expect(dataManager.ensureDurableDraft).toHaveBeenCalledTimes(saveCalls);
    expect(image.aiRegion).toBeNull();
    expect(image.aiRegionRunning).toBe(false);
    expect(image.aiRegionDrawEnabled).toBe(false);
    expect(dataManager.setManagedRoiRunning.mock.calls).toEqual([[true], [false]]);
  });

  it("sends the clipped percentage ROI, appends once, then strictly saves before clearing", async () => {
    const { annotation, image, client, dataManager } = setup();

    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));

    await waitFor(() => expect(dataManager.ensureDurableDraft).toHaveBeenCalledTimes(2));
    expect(client.infer).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      taskId: 17,
      roi: { x: 25, y: 10, width: 50, height: 40 },
      resolution: { width: 1024, height: 1024 },
      profileSelector: "safe",
    });
    expect(dataManager.ensureDurableDraft.mock.invocationCallOrder[0]).toBeLessThan(
      client.infer.mock.invocationCallOrder[0],
    );
    expect(annotation.appendResultsAtomically).toHaveBeenCalledTimes(1);
    expect(annotation.appendResultsAtomically).toHaveBeenCalledWith(
      produced().insertion_payload.regions.map((region) => region.label_studio_result),
    );
    expect(annotation.regions[0].results[0].setMetaValue).not.toHaveBeenCalled();
    expect(image.finishAIRegion).toHaveBeenCalledTimes(1);
    expect(image.finishAIRegion).toHaveBeenCalledWith({ clear: true });
    expect(image.focusInferenceGroup).toHaveBeenCalledWith([`roi:${REQUEST_ID}:1`]);
  });

  it("keeps insertion and presentation changes out of real annotation serialization and reload", async () => {
    const first = createRealAnnotation();

    first.image.setAIRegion({ x: 25, y: 10, width: 50, height: 40 });
    const harness = setup({ annotationInstance: first.annotation, imageInstance: first.image });
    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    await screen.findByText(/Inserted 1\./);

    const region = first.annotation.regions[0];
    const inserted = first.annotation.serializeAnnotation();

    expectSemanticInferenceOnly(inserted);
    expect(region.inferencePresentation).toEqual({ color: "#005A9C", numericBadge: null });
    expect(first.image.inferenceFocusMarker).toEqual({
      regionKeys: [`roi:${REQUEST_ID}:1`],
      sequence: 1,
    });
    act(() => first.image.setRegionPresentation("dim_non_selected", [region.presentationRegionKey]));
    expect(first.image.regionPresentationMode).toBe("dim_non_selected");
    expectSemanticInferenceOnly(first.annotation.serialized);
    act(() => first.image.setRegionPresentation("hide_non_selected", [region.presentationRegionKey]));
    expect(first.image.regionPresentationMode).toBe("hide_non_selected");
    expectSemanticInferenceOnly(first.annotation.serializeAnnotation());
    act(() => first.image.restoreRegionPresentation());
    expectSemanticInferenceOnly(first.annotation.serialized);

    harness.unmount();
    const reloaded = createRealAnnotation(inserted);
    const reloadedRegion = reloaded.annotation.regions[0];

    expect(reloaded.image.inferenceRegionPresentations).toEqual({});
    expect(reloadedRegion.inferencePresentation).toBeNull();
    expectSemanticInferenceOnly(reloaded.annotation.serializeAnnotation());

    const reloadHarness = setup({ annotationInstance: reloaded.annotation, imageInstance: reloaded.image });
    await waitFor(() => expect(reloadedRegion.inferencePresentation).toEqual({ color: "#005A9C", numericBadge: null }));
    expectSemanticInferenceOnly(reloaded.annotation.serializeAnnotation());
    reloadHarness.unmount();
  });

  it("retires exact inference keys on reload reconciliation without repainting or serializing presentation metadata", async () => {
    const inserted = [produced().insertion_payload.regions[0].label_studio_result];
    const reloaded = createRealAnnotation(inserted);
    const clearPresentations = jest.spyOn(reloaded.image, "clearInferenceRegionPresentations");
    const setPresentation = jest.spyOn(reloaded.image, "setInferenceRegionPresentation");
    const harness = setup({
      annotationInstance: reloaded.annotation,
      imageInstance: reloaded.image,
      initialManagedStatus: retiredStatus(),
    });

    await waitFor(() => expect(clearPresentations).toHaveBeenCalledWith([`roi:${REQUEST_ID}:1`]));
    expect(setPresentation).not.toHaveBeenCalled();
    expect(reloaded.annotation.regions[0].inferencePresentation).toBeNull();
    expectSemanticInferenceOnly(reloaded.annotation.serializeAnnotation());
    harness.unmount();
  });

  it.each([
    ["failed terminal", managedStatus({ terminalState: "failed" })],
    [
      "other terminal member",
      retiredStatus({
        member: {
          task_id: 18,
          task_key: "train:43",
          last_terminal_batch_member: true,
          draft_matches_last_terminal_batch: true,
          draft_ahead_of_committed: false,
          pending: false,
        },
      }),
    ],
  ])("keeps inference colors for %s", async (_name, status) => {
    const inferenceResult = produced().insertion_payload.regions[0].label_studio_result;
    const { image } = setup({ annotationResults: [inferenceResult], initialManagedStatus: status });

    await waitFor(() => expect(image.setInferenceRegionPresentation).toHaveBeenCalledTimes(1));
    expect(image.clearInferenceRegionPresentations).not.toHaveBeenCalled();
  });

  it("allows a newer Draft to color again after terminal retirement", async () => {
    const inferenceResult = produced().insertion_payload.regions[0].label_studio_result;
    const { dataManager, image } = setup({
      annotationResults: [inferenceResult],
      initialManagedStatus: retiredStatus(),
    });

    await waitFor(() => expect(image.clearInferenceRegionPresentations).toHaveBeenCalledTimes(1));
    act(() =>
      dataManager.emitManagedStatus(
        managedStatus({
          generation: 1,
          version: 2,
          taskSemanticState: "Draft",
          member: { last_terminal_batch_member: true },
          local: { dirty: true },
        }),
      ),
    );
    await waitFor(() => expect(image.setInferenceRegionPresentation).toHaveBeenCalledTimes(1));
  });

  it("ignores a stale older status event after a newer terminal state and unsubscribes its exact owner", async () => {
    const inferenceResult = produced().insertion_payload.regions[0].label_studio_result;
    const harness = setup({
      annotationResults: [inferenceResult],
      initialManagedStatus: managedStatus({ generation: 4, version: 1 }),
    });

    await waitFor(() => expect(harness.image.setInferenceRegionPresentation).toHaveBeenCalledTimes(1));
    act(() => harness.dataManager.emitManagedStatus(retiredStatus({ generation: 4, version: 3 })));
    await waitFor(() => expect(harness.image.clearInferenceRegionPresentations).toHaveBeenCalledTimes(1));
    act(() =>
      harness.dataManager.emitManagedStatus(
        managedStatus({ generation: 4, version: 2, taskSemanticState: "Draft", local: { dirty: true } }),
      ),
    );
    expect(harness.image.setInferenceRegionPresentation).toHaveBeenCalledTimes(1);

    const listener = harness.dataManager.on.mock.calls.find(([event]) => event === "managedStatusChanged")[1];
    harness.unmount();
    expect(harness.dataManager.off).toHaveBeenCalledWith("managedStatusChanged", listener);
  });

  it("retains inserted dirty boxes and ROI on save failure, then retries only the save", async () => {
    const save = jest
      .fn()
      .mockResolvedValueOnce(draftReceipt())
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(draftReceipt({ revision: "revision-3" }));
    const { annotation, image, client } = setup({ save });

    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    const retry = await screen.findByRole("button", { name: "Retry Draft save" });

    expect(annotation.appendResultsAtomically).toHaveBeenCalledTimes(1);
    expect(image.aiRegion).not.toBeNull();
    expect(image.finishAIRegion).toHaveBeenLastCalledWith({ clear: false });
    expect(client.abandon).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(annotation.appendResultsAtomically).toHaveBeenCalledTimes(1);
    expect(client.infer).toHaveBeenCalledTimes(1);
    expect(image.finishAIRegion).toHaveBeenLastCalledWith({ clear: true });
    expect(image.aiRegion).toBeNull();
  });

  it.each([
    ["empty", { parsed: 0, produced: 0, rejected: 0 }, /No objects found/],
    ["all_rejected", { parsed: 2, produced: 0, rejected: 2 }, /All 2 results were rejected/],
  ])("atomically clears %s while locked without annotation mutation", async (requestState, counts, message) => {
    const terminal = {
      ...produced(),
      request_state: requestState,
      terminal_status: requestState,
      clear_roi: true,
      insertion_payload: null,
      counts,
    };
    const { annotation, image } = setup({ inferResponse: terminal });

    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    await screen.findByText(message);
    expect(annotation.appendResultsAtomically).not.toHaveBeenCalled();
    expect(image.finishAIRegion).toHaveBeenCalledTimes(1);
    expect(image.finishAIRegion).toHaveBeenCalledWith({ clear: true });
    expect(image.aiRegion).toBeNull();
  });

  it("retains ROI and annotation for a response-level failure", async () => {
    const failure = {
      ...produced(),
      request_state: "response_failure",
      terminal_status: "response_failure",
      insertion_payload: null,
      failure: null,
      counts: { parsed: 0, produced: 0, rejected: 0 },
    };
    const { annotation, image } = setup({ inferResponse: failure });

    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    await screen.findByText(/response_failure/);
    expect(annotation.appendResultsAtomically).not.toHaveBeenCalled();
    expect(image.finishAIRegion).toHaveBeenCalledWith({ clear: false });
    expect(image.aiRegion).not.toBeNull();
  });

  it("abandons a mismatched target as superseded without appending", async () => {
    const mismatched = produced();

    mismatched.insertion_payload.target.annotation_id = "10";
    const { annotation, client } = setup({ inferResponse: mismatched });

    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    await waitFor(() =>
      expect(client.abandon).toHaveBeenCalledWith({
        receiptId: `roi-receipt:${REQUEST_ID}`,
        reason: "superseded",
      }),
    );
    expect(annotation.appendResultsAtomically).not.toHaveBeenCalled();
  });

  it.each([
    ["Draft revision", ({ annotation }) => (annotation.draftSaved = "revision-3")],
    ["Draft identity", ({ annotation }) => (annotation.draftId = 6)],
    ["browser semantic hash", ({ statusRef }) => (statusRef.hash = "fnv1a32:changed")],
    ["annotation identity", ({ annotation }) => (annotation.id = 10)],
  ])("abandons a deferred response when the frozen %s changes", async (_name, mutate) => {
    let resolveInfer;
    const inferPromise = new Promise((resolve) => {
      resolveInfer = resolve;
    });
    const harness = setup({ inferImpl: () => inferPromise });

    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    await waitFor(() => expect(harness.client.infer).toHaveBeenCalledTimes(1));
    mutate(harness);
    resolveInfer({ payload: produced() });

    await waitFor(() =>
      expect(harness.client.abandon).toHaveBeenCalledWith({
        receiptId: `roi-receipt:${REQUEST_ID}`,
        reason: "superseded",
      }),
    );
    expect(harness.annotation.appendResultsAtomically).not.toHaveBeenCalled();
    expect(harness.image.finishAIRegion).toHaveBeenCalledWith({ clear: false });
  });

  it("requests cancellation immediately, retries after receipt creation, and accepts only the exact terminal", async () => {
    let resolveInfer;
    const inferPromise = new Promise((resolve) => {
      resolveInfer = resolve;
    });
    const abandonImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("receipt not created"))
      .mockImplementationOnce(({ reason }) => Promise.resolve({ payload: abandoned(reason), status: 200 }));
    const { annotation, client } = setup({ inferImpl: () => inferPromise, abandonImpl });

    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    await waitFor(() => expect(client.infer).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(client.abandon).toHaveBeenCalledTimes(1));
    expect(annotation.appendResultsAtomically).not.toHaveBeenCalled();
    resolveInfer({ payload: produced() });
    await waitFor(() => expect(client.abandon).toHaveBeenCalledTimes(2));
    expect(client.abandon).toHaveBeenLastCalledWith({
      receiptId: `roi-receipt:${REQUEST_ID}`,
      reason: "user_cancelled",
    });
    expect(annotation.appendResultsAtomically).not.toHaveBeenCalled();
    expect(await screen.findByText(/abandoned before insertion/i)).toBeInTheDocument();
  });

  it.each([
    ["empty object", {}],
    ["wrong receipt", abandoned("superseded", { receipt_id: "roi-receipt:22222222-2222-4222-8222-222222222222" })],
    ["nonterminal", { ...abandoned("superseded"), terminal_status: null }],
  ])("does not confirm malformed abandonment: %s", async (_name, abandonPayload) => {
    const mismatched = produced();

    mismatched.insertion_payload.target.annotation_id = "10";
    const { annotation, client } = setup({
      inferResponse: mismatched,
      abandonImpl: () => Promise.resolve({ payload: abandonPayload, status: 200 }),
    });

    await screen.findByRole("option", { name: "Safe" });
    fireEvent.click(screen.getByRole("button", { name: "Infer" }));
    await screen.findByText(/could not be confirmed/i);
    expect(client.abandon).toHaveBeenCalledTimes(1);
    expect(annotation.appendResultsAtomically).not.toHaveBeenCalled();
  });

  it("revalidates independent resolution constraints when switching profiles", async () => {
    const compact = {
      ...profile,
      selector: "compact",
      display_label: "Compact",
      default_canvas: { width: 512, height: 512 },
      processor_factor: 64,
      bounds: { min_axis_pixels: 64, max_axis_pixels: 768, max_total_pixels: 589824 },
    };

    setup({ profiles: [profile, compact] });
    await screen.findByRole("option", { name: "Compact" });
    fireEvent.change(screen.getByLabelText("Inference profile"), { target: { value: "compact" } });
    expect(screen.getByRole("button", { name: "Infer" })).toBeDisabled();
    expect(screen.getByText(/between 64 and 768/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Canvas width"), { target: { value: "512" } });
    fireEvent.change(screen.getByLabelText("Canvas height"), { target: { value: "512" } });
    expect(screen.getByRole("button", { name: "Infer" })).toBeEnabled();
  });
});
