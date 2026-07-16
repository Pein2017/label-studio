import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CoordExpManagedPanel, CoordExpManagedPanelMount, resolveManagedDataManager } from "./CoordExpManagedPanel";
import { CoordExpHttpError } from "../../services/coordexp-refinement-api";
import { DATA_MANAGER_READY_EVENT } from "../../services/data-manager-ready";

const ACTIVE_BATCH_ID = "11111111-1111-4111-8111-111111111111";
const TERMINAL_BATCH_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_STATE = {
  version: 1,
  generation: 4,
  pending_draft_count: 2,
  members: [],
  active_batch_id: null,
  batch_state: null,
};

const makeStatus = (overrides = {}) => ({
  authority: PROJECT_STATE,
  generation: 4,
  version: 1,
  taskSemanticState: "Draft",
  batchState: null,
  activeBatchId: null,
  pendingDraftCount: 2,
  local: {
    dirty: false,
    roiRunning: false,
    saveInFlight: false,
    pendingTaskCount: 0,
  },
  error: null,
  ...overrides,
});

const makeDataManager = (initialStatus = makeStatus()) => {
  const listeners = new Map();
  const project = { id: 7 };
  const ownerStore = { project };
  let status = initialStatus;
  const dataManager = {
    projectId: 7,
    store: ownerStore,
    lsf: {
      datamanager: null,
      store: ownerStore,
      project,
      isManagedRefinementProject: true,
      lsfInstance: { store: null },
      task: { id: 11 },
    },
    on: jest.fn((name, callback) => {
      const values = listeners.get(name) ?? new Set();

      values.add(callback);
      listeners.set(name, values);
    }),
    off: jest.fn((name, callback) => listeners.get(name)?.delete(callback)),
    emit(name, payload) {
      listeners.get(name)?.forEach((callback) => callback(payload));
    },
    ensureDurableDraft: jest.fn().mockResolvedValue({ draft_id: 10 }),
    beginManagedProjectStatePoll: jest.fn(() => ({ pollSequence: 1, localSaveVersion: 0 })),
    updateManagedProjectState: jest.fn((state) => {
      status = makeStatus({
        authority: state,
        generation: state.generation,
        version: state.version,
        batchState: state.batch_state,
        activeBatchId: state.active_batch?.batch_id ?? state.active_batch_id,
        pendingDraftCount: state.pending_draft_count,
      });
      dataManager.emit("managedStatusChanged", status);
      return status;
    }),
    getManagedStatusState: jest.fn(() => status),
  };

  dataManager.lsf.datamanager = dataManager;

  return dataManager;
};

const setDataManagerProject = (dataManager, projectId) => {
  const project = { id: projectId };

  dataManager.projectId = projectId;
  dataManager.store.project = project;
  dataManager.lsf.project = project;
  return dataManager;
};

const makeClient = (overrides = {}) => ({
  projectState: jest.fn(() => new Promise(() => {})),
  status: jest.fn(() => new Promise(() => {})),
  commit: jest.fn().mockResolvedValue({
    status: 202,
    payload: {
      batch_id: ACTIVE_BATCH_ID,
      status: "queued",
      member_count: 2,
      base_generation: 4,
      generation: null,
    },
  }),
  ...overrides,
});

const makeStorage = () => {
  const values = new Map();
  return {
    getItem: jest.fn((key) => values.get(key) ?? null),
    setItem: jest.fn((key, value) => values.set(key, value)),
    removeItem: jest.fn((key) => values.delete(key)),
  };
};

const renderPanel = ({ dataManager = makeDataManager(), client = makeClient(), ...props } = {}) => {
  const view = render(
    <CoordExpManagedPanel
      projectId={7}
      dataManager={dataManager}
      clientFactory={() => client}
      pollIntervalMs={60_000}
      batchIdFactory={() => ACTIVE_BATCH_ID}
      batchStorage={makeStorage()}
      {...props}
    />,
  );

  return { client, dataManager, ...view };
};

describe("CoordExpManagedPanel", () => {
  it("immediately adopts a same-project replacement manager and ignores the retired owner", async () => {
    const oldManager = makeDataManager(makeStatus({ pendingDraftCount: 2, taskSemanticState: "Draft" }));
    const newManager = makeDataManager(makeStatus({ pendingDraftCount: 0, taskSemanticState: "Committed" }));
    const client = makeClient();
    const clientFactory = jest.fn(() => client);
    const batchStorage = makeStorage();
    const view = render(
      <CoordExpManagedPanel
        projectId={7}
        dataManager={oldManager}
        clientFactory={clientFactory}
        pollIntervalMs={60_000}
        batchStorage={batchStorage}
      />,
    );
    const retiredStatusHandler = oldManager.on.mock.calls.find(([name]) => name === "managedStatusChanged")?.[1];

    expect(screen.getByText("Pending Drafts: 2")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit Drafts" })).toBeEnabled();
    expect(retiredStatusHandler).toEqual(expect.any(Function));

    view.rerender(
      <CoordExpManagedPanel
        projectId={7}
        dataManager={newManager}
        clientFactory={clientFactory}
        pollIntervalMs={60_000}
        batchStorage={batchStorage}
      />,
    );

    await waitFor(() => expect(screen.getByText("Pending Drafts: 0")).toBeInTheDocument());
    expect(screen.getByText("Committed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit Drafts" })).toBeDisabled();

    act(() => retiredStatusHandler(makeStatus({ pendingDraftCount: 5, taskSemanticState: "Draft" })));
    expect(screen.getByText("Pending Drafts: 0")).toBeInTheDocument();
    expect(screen.getByText("Committed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit Drafts" })).toBeDisabled();

    act(() => newManager.emit("managedStatusChanged", makeStatus({ pendingDraftCount: 1 })));
    expect(screen.getByText("Pending Drafts: 1")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit Drafts" })).toBeEnabled();
  });

  it("retires a pending old-owner commit and lets the replacement owner commit", async () => {
    let resolveOldDraft;
    const oldManager = makeDataManager();
    const newManager = makeDataManager();
    const client = makeClient();
    const clientFactory = jest.fn(() => client);
    const batchIdFactory = jest.fn(() => ACTIVE_BATCH_ID);
    const batchStorage = makeStorage();

    oldManager.ensureDurableDraft.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOldDraft = resolve;
        }),
    );

    const view = render(
      <CoordExpManagedPanel
        projectId={7}
        dataManager={oldManager}
        clientFactory={clientFactory}
        pollIntervalMs={60_000}
        batchIdFactory={batchIdFactory}
        batchStorage={batchStorage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Commit Drafts" }));
    await waitFor(() => expect(oldManager.ensureDurableDraft).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Saving and queueing…" })).toBeDisabled();

    view.rerender(
      <CoordExpManagedPanel
        projectId={7}
        dataManager={newManager}
        clientFactory={clientFactory}
        pollIntervalMs={60_000}
        batchIdFactory={batchIdFactory}
        batchStorage={batchStorage}
      />,
    );
    expect(screen.getByRole("button", { name: "Commit Drafts" })).toBeEnabled();

    await act(async () => {
      resolveOldDraft({ draft_id: 10 });
      await Promise.resolve();
    });

    expect(client.commit).not.toHaveBeenCalled();
    expect(batchIdFactory).not.toHaveBeenCalled();
    expect(batchStorage.setItem).not.toHaveBeenCalled();
    expect(screen.queryByText(/Batch queued durably/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit Drafts" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Commit Drafts" }));
    await waitFor(() => expect(newManager.ensureDurableDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1));
    expect(batchIdFactory).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Batch queued durably/)).toBeInTheDocument();
  });

  it("subscribes, updates the post-navigation reminder, and removes exact handlers", async () => {
    const { dataManager, unmount } = renderPanel();

    expect(dataManager.on).toHaveBeenCalledWith("managedStatusChanged", expect.any(Function));
    expect(dataManager.on).toHaveBeenCalledWith("managedNavigationReminder", expect.any(Function));

    act(() => dataManager.emit("managedNavigationReminder", { pendingDraftCount: 2, reason: "next-task" }));
    expect(
      screen.getByText("Draft saved durably. 2 Draft(s) may be included in a later batch Commit."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/save this Draft first/)).not.toBeInTheDocument();

    act(() => dataManager.emit("managedStatusChanged", makeStatus({ pendingDraftCount: 3 })));
    expect(
      screen.getByText("Draft saved durably. 3 Draft(s) may be included in a later batch Commit."),
    ).toBeInTheDocument();

    act(() => dataManager.emit("managedStatusChanged", makeStatus({ pendingDraftCount: 0 })));
    expect(screen.queryByText(/Draft saved/)).not.toBeInTheDocument();

    act(() => dataManager.emit("managedStatusChanged", makeStatus({ pendingDraftCount: 2 })));
    act(() => dataManager.emit("managedNavigationReminder", { pendingDraftCount: 2, reason: "row-click" }));
    fireEvent.click(screen.getByRole("button", { name: "Commit Drafts" }));
    await waitFor(() => expect(screen.queryByText(/Draft saved/)).not.toBeInTheDocument());

    unmount();
    expect(dataManager.off).toHaveBeenCalledWith("managedStatusChanged", expect.any(Function));
    expect(dataManager.off).toHaveBeenCalledWith("managedNavigationReminder", expect.any(Function));
  });

  it("shows a new 202 active batch immediately without hiding the prior terminal batch", async () => {
    const client = makeClient();
    const dataManager = makeDataManager(
      makeStatus({
        authority: {
          ...PROJECT_STATE,
          last_terminal_batch: {
            batch_id: TERMINAL_BATCH_ID,
            state: "succeeded",
            member_count: 5,
            base_generation: 6,
            generation: 7,
          },
        },
      }),
    );
    renderPanel({ client, dataManager });

    fireEvent.click(screen.getByRole("button", { name: "Commit Drafts" }));

    await waitFor(() => expect(client.commit).toHaveBeenCalledTimes(1));
    expect(dataManager.ensureDurableDraft).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Batch queued durably/)).toBeInTheDocument();
    expect(screen.getByLabelText("Active batch")).toHaveTextContent(`ID: ${ACTIVE_BATCH_ID}`);
    expect(screen.getByLabelText("Active batch")).toHaveTextContent("State: Queued");
    expect(screen.getByLabelText("Active batch")).toHaveTextContent("Generation: 4");
    expect(screen.getByLabelText("Last terminal batch")).toHaveTextContent(`ID: ${TERMINAL_BATCH_ID}`);
    expect(screen.getByLabelText("Last terminal batch")).toHaveTextContent("State: Succeeded");
    expect(screen.getByRole("button", { name: "Queued…" })).toBeDisabled();
  });

  it("consumes simultaneous authoritative blocks and tracks the active ID for reload", async () => {
    const storage = makeStorage();
    const client = makeClient({
      projectState: jest.fn().mockResolvedValue({
        ...PROJECT_STATE,
        version: 2,
        active_batch_id: ACTIVE_BATCH_ID,
        batch_state: "running",
        active_batch: {
          batch_id: ACTIVE_BATCH_ID,
          state: "running",
          member_count: 3,
          base_generation: 4,
        },
        last_terminal_batch: {
          batch_id: TERMINAL_BATCH_ID,
          state: "succeeded",
          member_count: 2,
          base_generation: 2,
          generation: 3,
          error: null,
        },
      }),
    });

    renderPanel({ client, batchStorage: storage });

    expect(await screen.findByLabelText("Active batch")).toHaveTextContent(`ID: ${ACTIVE_BATCH_ID}`);
    expect(screen.getByLabelText("Last terminal batch")).toHaveTextContent(`ID: ${TERMINAL_BATCH_ID}`);
    expect(storage.setItem).toHaveBeenCalledWith("coordexp-refinement:last-batch:7", ACTIVE_BATCH_ID);
  });

  it("lets a same-ID authoritative terminal replace a stale stored active receipt", async () => {
    const storage = makeStorage();
    storage.setItem("coordexp-refinement:last-batch:7", ACTIVE_BATCH_ID);
    const client = makeClient({
      status: jest.fn().mockRejectedValue(new TypeError("status fetch failed")),
      projectState: jest.fn().mockResolvedValue({
        ...PROJECT_STATE,
        last_terminal_batch: {
          batch_id: ACTIVE_BATCH_ID,
          state: "succeeded",
          member_count: 2,
          base_generation: 4,
          generation: 5,
          error: null,
        },
      }),
    });

    renderPanel({ client, batchStorage: storage });

    expect(await screen.findByLabelText("Last terminal batch")).toHaveTextContent(`ID: ${ACTIVE_BATCH_ID}`);
    expect(screen.queryByLabelText("Active batch")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit Drafts" })).toBeEnabled();
    expect(client.status).toHaveBeenCalledWith(ACTIVE_BATCH_ID, expect.any(AbortSignal));
  });

  it("keeps resolved request failures visible and Drafts available", async () => {
    const client = makeClient({
      commit: jest.fn().mockRejectedValue(new CoordExpHttpError("Queue fsync failed.", { status: 503 })),
    });

    renderPanel({ client });
    fireEvent.click(screen.getByRole("button", { name: "Commit Drafts" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Queue fsync failed.");
    expect(screen.getByRole("button", { name: "Commit Drafts" })).toBeEnabled();
  });

  it("reconciles an unknown POST outcome by the persisted batch ID", async () => {
    const error = new TypeError("connection closed");
    error.outcomeUnknown = true;
    const client = makeClient({
      commit: jest.fn().mockRejectedValue(error),
      status: jest.fn(() => new Promise(() => {})),
    });

    renderPanel({ client });
    fireEvent.click(screen.getByRole("button", { name: "Commit Drafts" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("reconciling by batch ID");
    expect(screen.getByLabelText("Active batch")).toHaveTextContent("State: Reconciling");
    expect(screen.getByRole("button", { name: "Reconciling…" })).toBeDisabled();
  });

  it("uses explicit member flags for a durable dirty-false Draft ahead of the active batch", () => {
    renderPanel({
      dataManager: makeDataManager(
        makeStatus({
          generation: 8,
          authority: {
            ...PROJECT_STATE,
            active_batch: {
              batch_id: ACTIVE_BATCH_ID,
              state: "running",
              member_count: 4,
              base_generation: 8,
            },
            members: [
              {
                task_id: 11,
                pending: true,
                active_batch_member: true,
                active_batch_semantic_hash: "sha256:captured",
                draft_ahead_of_active_batch: true,
                draft_ahead_of_committed: true,
              },
            ],
          },
          local: { dirty: false, saveInFlight: false, roiRunning: false, pendingTaskCount: 1 },
        }),
      ),
    });

    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByLabelText("Active batch")).toHaveTextContent("State: Running");
    expect(screen.getByLabelText("Active batch")).toHaveTextContent("Members: 4");
    expect(screen.getByLabelText("Active batch")).toHaveTextContent("Generation: 8");
    expect(screen.getByText("Current task captured")).toBeInTheDocument();
    expect(screen.getByText("Draft ahead of active batch")).toBeInTheDocument();
    expect(screen.queryByText("Draft ahead of committed batch")).not.toBeInTheDocument();
    expect(screen.queryByText("Unsaved local edit")).not.toBeInTheDocument();
  });

  it("does not infer Draft-ahead from local dirty state", () => {
    renderPanel({
      dataManager: makeDataManager(
        makeStatus({
          authority: {
            ...PROJECT_STATE,
            active_batch: { batch_id: ACTIVE_BATCH_ID, state: "running", member_count: 2, base_generation: 4 },
            members: [{ task_id: 11, pending: true, active_batch_member: true }],
          },
          local: { dirty: true, saveInFlight: true, roiRunning: true, pendingTaskCount: 1 },
        }),
      ),
    });

    expect(screen.getByText("Unsaved local edit")).toBeInTheDocument();
    expect(screen.getByText("Saving Draft…")).toBeInTheDocument();
    expect(screen.getByText("ROI inference running…")).toBeInTheDocument();
    expect(screen.queryByText(/Draft ahead of/)).not.toBeInTheDocument();
  });

  it("shows terminal state and an explicit durable newer Draft", () => {
    renderPanel({
      dataManager: makeDataManager(
        makeStatus({
          taskSemanticState: "Draft",
          pendingDraftCount: 1,
          authority: {
            ...PROJECT_STATE,
            last_terminal_batch: {
              batch_id: TERMINAL_BATCH_ID,
              state: "succeeded",
              member_count: 5,
              base_generation: 8,
              generation: 9,
            },
            members: [{ task_id: 11, pending: true, draft_ahead_of_committed: true }],
          },
          generation: 9,
          local: { dirty: false, saveInFlight: false, roiRunning: false, pendingTaskCount: 1 },
        }),
      ),
    });

    expect(screen.getByLabelText("Last terminal batch")).toHaveTextContent(`ID: ${TERMINAL_BATCH_ID}`);
    expect(screen.getByLabelText("Last terminal batch")).toHaveTextContent("State: Succeeded");
    expect(screen.getByLabelText("Last terminal batch")).toHaveTextContent("Members: 5");
    expect(screen.getByLabelText("Last terminal batch")).toHaveTextContent("Generation: 9");
    expect(screen.getByText("Draft ahead of committed batch")).toBeInTheDocument();
    expect(screen.queryByText("Unsaved local edit")).not.toBeInTheDocument();
  });

  it("aborts an in-flight background poll on unmount", async () => {
    let observedSignal;
    const client = makeClient({
      projectState: jest.fn((signal) => {
        observedSignal = signal;
        return new Promise(() => {});
      }),
    });
    const { unmount } = renderPanel({ client });

    await waitFor(() => expect(observedSignal).toBeDefined());
    unmount();
    expect(observedSignal.aborted).toBe(true);
  });

  it("hands poll ownership to a restarted effect without overlap or losing the new abort controller", async () => {
    let activeRequests = 0;
    let maxConcurrentRequests = 0;
    const requests = [];
    const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
    const deferredRequest = (signal) => {
      let rejectRequest;
      let settled = false;

      activeRequests += 1;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
      const promise = new Promise((_, reject) => {
        rejectRequest = (error) => {
          if (settled) return;
          settled = true;
          activeRequests -= 1;
          reject(error);
        };
      });

      requests.push({ signal, reject: rejectRequest });
      return promise;
    };
    const client = makeClient({
      projectState: jest.fn(deferredRequest),
      status: jest.fn((_batchId, signal) => deferredRequest(signal)),
    });
    const consoleError = jest.spyOn(console, "error");

    try {
      const { unmount } = renderPanel({ client });

      await waitFor(() => expect(requests).toHaveLength(1));
      fireEvent.click(screen.getByRole("button", { name: "Commit Drafts" }));
      await waitFor(() => expect(requests[0].signal.aborted).toBe(true));

      expect(client.status).not.toHaveBeenCalled();
      expect(maxConcurrentRequests).toBe(1);

      await act(async () => {
        requests[0].reject(abortError());
        await Promise.resolve();
      });
      await waitFor(() => expect(client.status).toHaveBeenCalledTimes(1));

      expect(requests).toHaveLength(2);
      expect(maxConcurrentRequests).toBe(1);
      unmount();
      expect(requests[1].signal.aborted).toBe(true);

      await act(async () => {
        requests[1].reject(abortError());
        await Promise.resolve();
      });
      expect(activeRequests).toBe(0);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("CoordExpManagedPanelMount", () => {
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
    ["positive project id", (dataManager) => setDataManagerProject(dataManager, 0)],
    ["safe project id", (dataManager) => setDataManagerProject(dataManager, Number.MAX_SAFE_INTEGER + 1)],
  ])("rejects a mismatched %s", (_name, mutate) => {
    const store = { project: null };
    const dataManager = makeDataManager();

    dataManager.lsf.lsfInstance.store = store;
    mutate(dataManager);

    expect(resolveManagedDataManager(store, dataManager)).toBeNull();
  });

  it("mounts only for the identity-matched managed wrapper", async () => {
    const store = { project: null };
    const dataManager = makeDataManager();
    const clientFactory = jest.fn(() => makeClient());

    dataManager.lsf.lsfInstance.store = store;
    render(
      <CoordExpManagedPanelMount
        store={store}
        candidate={dataManager}
        clientFactory={clientFactory}
        pollIntervalMs={60_000}
        batchStorage={makeStorage()}
      />,
    );

    expect(screen.getByRole("complementary", { name: "CoordExp refinement status" })).toBeInTheDocument();
    expect(clientFactory).toHaveBeenCalledWith(7);
  });

  it("renders nothing for an ordinary or mismatched project", () => {
    const store = { project: { id: 7 } };
    const dataManager = makeDataManager();

    dataManager.lsf.lsfInstance.store = store;
    dataManager.lsf.isManagedRefinementProject = false;
    const { container, rerender } = render(
      <CoordExpManagedPanelMount store={store} candidate={dataManager} clientFactory={() => makeClient()} />,
    );

    expect(container).toBeEmptyDOMElement();

    dataManager.lsf.isManagedRefinementProject = true;
    dataManager.projectId = 9;
    rerender(<CoordExpManagedPanelMount store={store} candidate={dataManager} clientFactory={() => makeClient()} />);
    expect(container).toBeEmptyDOMElement();

    dataManager.projectId = 7;
    dataManager.lsf.project = { id: 9 };
    rerender(<CoordExpManagedPanelMount store={store} candidate={dataManager} clientFactory={() => makeClient()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("mounts from readiness both before mount and after an initial null render", async () => {
    const store = { project: null };
    const dataManager = makeDataManager();

    dataManager.lsf.lsfInstance.store = store;
    publish(null);
    const first = render(
      <CoordExpManagedPanelMount
        store={store}
        clientFactory={() => makeClient()}
        pollIntervalMs={60_000}
        batchStorage={makeStorage()}
      />,
    );

    expect(first.container).toBeEmptyDOMElement();
    act(() => publish(dataManager));
    expect(await screen.findByRole("complementary", { name: "CoordExp refinement status" })).toBeInTheDocument();
    first.unmount();

    publish(dataManager);
    render(
      <CoordExpManagedPanelMount
        store={store}
        clientFactory={() => makeClient()}
        pollIntervalMs={60_000}
        batchStorage={makeStorage()}
      />,
    );
    expect(screen.getByRole("complementary", { name: "CoordExp refinement status" })).toBeInTheDocument();
  });

  it("ignores malformed and other-store readiness events", () => {
    const store = { project: null };
    const otherStore = { project: null };
    const otherManager = makeDataManager();
    const dataManager = makeDataManager();

    otherManager.lsf.lsfInstance.store = otherStore;
    dataManager.lsf.lsfInstance.store = store;
    publish(null);
    const { container } = render(<CoordExpManagedPanelMount store={store} clientFactory={() => makeClient()} />);

    act(() => publish(otherManager));
    expect(container).toBeEmptyDOMElement();
    act(() => publish(dataManager, { malformed: true }));
    expect(container).toBeEmptyDOMElement();
    act(() => publish(dataManager));
    expect(screen.getByRole("complementary", { name: "CoordExp refinement status" })).toBeInTheDocument();
  });

  it("keeps explicit candidate precedence and removes the exact readiness listener", () => {
    const store = { project: null };
    const explicit = makeDataManager();
    const globalManager = makeDataManager();
    const addEventListener = jest.spyOn(window, "addEventListener");
    const removeEventListener = jest.spyOn(window, "removeEventListener");

    explicit.lsf.lsfInstance.store = store;
    globalManager.lsf.lsfInstance.store = store;
    publish(globalManager);
    const explicitView = render(
      <CoordExpManagedPanelMount store={store} candidate={explicit} clientFactory={() => makeClient()} />,
    );

    expect(explicit.on).toHaveBeenCalled();
    expect(globalManager.on).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalledWith(DATA_MANAGER_READY_EVENT, expect.any(Function));
    explicitView.unmount();

    const subscribedView = render(<CoordExpManagedPanelMount store={store} clientFactory={() => makeClient()} />);
    const listener = addEventListener.mock.calls.find(([name]) => name === DATA_MANAGER_READY_EVENT)?.[1];

    expect(listener).toEqual(expect.any(Function));
    subscribedView.unmount();
    expect(removeEventListener).toHaveBeenCalledWith(DATA_MANAGER_READY_EVENT, listener);
  });

  it("replaces the mounted manager and resets across a project-store transition", () => {
    const storeA = { project: null };
    const storeB = { project: null };
    const managerA1 = makeDataManager();
    const managerA2 = makeDataManager();
    const managerB = makeDataManager();

    managerA1.lsf.lsfInstance.store = storeA;
    managerA2.lsf.lsfInstance.store = storeA;
    setDataManagerProject(managerB, 8);
    managerB.lsf.lsfInstance.store = storeB;
    publish(managerA1);
    const { container, rerender } = render(
      <CoordExpManagedPanelMount store={storeA} clientFactory={() => makeClient()} pollIntervalMs={60_000} />,
    );

    act(() => publish(managerA2));
    expect(managerA1.off).toHaveBeenCalledWith("managedStatusChanged", expect.any(Function));
    expect(managerA2.on).toHaveBeenCalledWith("managedStatusChanged", expect.any(Function));

    rerender(<CoordExpManagedPanelMount store={storeB} clientFactory={() => makeClient()} pollIntervalMs={60_000} />);
    expect(container).toBeEmptyDOMElement();
    act(() => publish(managerB));
    expect(screen.getByRole("complementary", { name: "CoordExp refinement status" })).toBeInTheDocument();
  });
});
