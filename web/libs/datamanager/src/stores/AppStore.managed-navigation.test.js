import { destroy, types } from "mobx-state-tree";

let AppStore;
let Modal;
let originalNavigationDescriptor;

jest.mock("./Tabs", () => {
  const { types } = require("mobx-state-tree");

  return {
    TabStore: types
      .model("ManagedNavigationTestTabs", {
        views: types.optional(types.array(types.frozen()), []),
      })
      .views(() => ({
        get selected() {
          return undefined;
        },
      }))
      .actions(() => ({
        setSelected() {},
      })),
  };
});

jest.mock("./DataStores", () => ({}));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
};

const makeStore = ({ managed = true } = {}) => {
  const gate = deferred();
  let guardedAction;
  const lsf = {
    isManagedRefinementProject: managed,
    taskID: 10,
    currentAnnotation: { pk: "77" },
    requiresManagedNavigationSave: jest.fn(() => true),
    coordinateManagedNavigation: jest.fn((action) => {
      guardedAction = action;
      return gate.promise.then(action);
    }),
  };
  const sdk = {
    lsf,
    setMode: jest.fn(),
    destroyLSF: jest.fn(),
    invoke: jest.fn(),
  };
  const store = AppStore.create({
    toolbar: "",
    interfaces: {},
    viewsStore: { views: [{ tabKey: "main" }] },
    project: {
      config_has_control_tags: true,
      description: managed ? "coordexp-refinement-project-identity:fixture" : "ordinary-project",
    },
  });

  store._sdk = sdk;
  store.installManagedHistoryTracking();
  return { gate, getGuardedAction: () => guardedAction, lsf, sdk, store };
};

const makeTaskInitializationStore = () => {
  const firstInitialization = deferred();
  const selectedInitialization = deferred();
  const annotation = { id: "local-77", pk: "77", type: "annotation" };
  const task = { id: 11 };
  const taskStore = {
    selected: task,
    setSelected: jest.fn(),
    loadTask: jest.fn(async () => task),
  };
  const annotationStore = {
    selected: null,
    setSelected: jest.fn(),
  };
  const editorAnnotationStore = {
    annotations: [annotation],
    predictions: [],
    toggleViewingAllAnnotations: jest.fn(),
    viewingAll: false,
  };
  const lsf = {
    coordinateManagedNavigation: jest.fn((action) => action()),
    currentAnnotation: annotation,
    isManagedRefinementProject: true,
    lsf: { annotationStore: editorAnnotationStore },
    setLSFTask: jest
      .fn()
      .mockImplementationOnce(() => firstInitialization.promise)
      .mockImplementationOnce(() => selectedInitialization.promise),
  };
  const sdk = { lsf, setMode: jest.fn() };
  const HarnessStore = types.compose(
    AppStore,
    types.model("ManagedTaskInitializationHarness").volatile(() => ({ annotationStore, taskStore })),
  );
  const store = HarnessStore.create({
    toolbar: "",
    interfaces: {},
    viewsStore: { views: [{ tabKey: "main" }] },
    project: { config_has_control_tags: true },
  });

  store._sdk = sdk;
  return { annotation, editorAnnotationStore, firstInitialization, lsf, selectedInitialization, store, task };
};

const replaceEntryWithoutTracking = (store, state, href) => {
  store.managedHistoryOriginalReplaceState.call(window.history, state, document.title, href);
};

const replaceTrackedEntry = (state, href) => {
  window.history.replaceState(state, document.title, href);
  return {
    browserIndex: Number.isSafeInteger(window.navigation?.currentEntry?.index)
      ? window.navigation.currentEntry.index
      : null,
    href: window.location.href,
    position: window.history.state.__coordexp_refinement_history_v1.position,
    state: window.history.state,
  };
};

const pushTrackedEntry = (state, href) => {
  window.history.pushState(state, document.title, href);
  return {
    browserIndex: Number.isSafeInteger(window.navigation?.currentEntry?.index)
      ? window.navigation.currentEntry.index
      : null,
    href: window.location.href,
    position: window.history.state.__coordexp_refinement_history_v1.position,
    state: window.history.state,
  };
};

const mockNavigationIndex = (initialIndex) => {
  let index = initialIndex;

  Object.defineProperty(window, "navigation", {
    configurable: true,
    get: () => ({ currentEntry: { index } }),
  });
  return (nextIndex) => {
    index = nextIndex;
  };
};

beforeEach(() => {
  jest.restoreAllMocks();
  window.history.replaceState({ task: "10", annotation: "77" }, "", "/projects/3/data?task=10&annotation=77");
});

beforeAll(() => {
  window.APP_SETTINGS = { hostname: "http://localhost" };
  originalNavigationDescriptor = Object.getOwnPropertyDescriptor(window, "navigation");
  ({ AppStore } = require("./AppStore"));
  ({ Modal } = require("../components/Common/Modal/Modal"));
});

afterEach(() => {
  if (originalNavigationDescriptor) {
    Object.defineProperty(window, "navigation", originalNavigationDescriptor);
  } else {
    delete window.navigation;
  }
});

describe("AppStore managed navigation wiring", () => {
  it("keeps task navigation pending until both editor task initializations finish", async () => {
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const { annotation, firstInitialization, lsf, selectedInitialization, store, task } = makeTaskInitializationStore();
    const row = { id: annotation.pk, isSelected: false, task_id: task.id };
    const navigation = store.startLabeling(row);
    let settled = false;

    navigation.then(() => {
      settled = true;
    });

    try {
      for (let attempt = 0; attempt < 10 && lsf.setLSFTask.mock.calls.length < 1; attempt++) {
        await Promise.resolve();
      }

      expect(lsf.setLSFTask).toHaveBeenCalledTimes(1);
      expect(lsf.setLSFTask).toHaveBeenNthCalledWith(1, task, annotation.pk);
      expect(lsf.coordinateManagedNavigation).toHaveBeenCalledWith(expect.any(Function), {
        intentKey: `row:${task.id}:annotation:${annotation.pk}`,
        reason: "row-click",
      });
      expect(store.loadingData).toBe(true);
      expect(settled).toBe(false);

      firstInitialization.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(lsf.setLSFTask).toHaveBeenCalledTimes(2);
      expect(lsf.setLSFTask).toHaveBeenNthCalledWith(2, task, annotation.pk, undefined, false);
      expect(store.loadingData).toBe(true);
      expect(settled).toBe(false);

      selectedInitialization.resolve();
      await navigation;

      expect(store.loadingData).toBe(false);
      expect(settled).toBe(true);
    } finally {
      firstInitialization.resolve();
      selectedInitialization.resolve();
      await navigation;
      destroy(store);
    }
  });

  it.each([
    ["initial task", "firstInitialization", 1],
    ["URL-selected annotation", "selectedInitialization", 2],
  ])("clears task loading when %s initialization rejects", async (_name, rejectedGate, expectedCalls) => {
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const { annotation, editorAnnotationStore, firstInitialization, lsf, selectedInitialization, store, task } =
      makeTaskInitializationStore();
    const failure = new Error(`${rejectedGate} failed`);
    const row = { id: annotation.pk, isSelected: false, task_id: task.id };
    const navigation = store.startLabeling(row, { interface: "annotations:view-all" });
    const outcome = navigation.catch((error) => error);

    try {
      for (let attempt = 0; attempt < 10 && lsf.setLSFTask.mock.calls.length < 1; attempt++) {
        await Promise.resolve();
      }
      if (rejectedGate === "selectedInitialization") {
        firstInitialization.resolve();
        for (let attempt = 0; attempt < 10 && lsf.setLSFTask.mock.calls.length < 2; attempt++) {
          await Promise.resolve();
        }
      }

      const gate = rejectedGate === "firstInitialization" ? firstInitialization : selectedInitialization;

      gate.reject(failure);

      expect(await outcome).toBe(failure);
      expect(lsf.setLSFTask).toHaveBeenCalledTimes(expectedCalls);
      expect(store.loadingData).toBe(false);
      expect(editorAnnotationStore.toggleViewingAllAnnotations).not.toHaveBeenCalled();
    } finally {
      firstInitialization.resolve();
      selectedInitialization.resolve();
      await navigation.catch(() => {});
      destroy(store);
    }
  });

  it("defers editor close until the shared coordinator succeeds", async () => {
    const { gate, lsf, sdk, store } = makeStore();

    const closing = store.closeLabeling();

    expect(lsf.coordinateManagedNavigation).toHaveBeenCalledWith(expect.any(Function), {
      intentKey: "close-labeling",
      reason: "close-labeling",
    });
    expect(sdk.destroyLSF).not.toHaveBeenCalled();

    gate.resolve();
    await closing;

    expect(sdk.setMode).toHaveBeenCalledWith("explorer");
    expect(sdk.destroyLSF).toHaveBeenCalledTimes(1);
    destroy(store);
  });

  it("restores the exact source entry before saving, then replays the exact target once", async () => {
    const { gate, lsf, sdk, store } = makeStore();
    const sourceHref = "http://localhost/projects/3/data?tab=review&filter=source&task=10&annotation=77";
    const sourceState = {
      annotation: "77",
      filter: "source",
      opaque: { owner: "source" },
      tab: "review",
      task: "10",
    };
    const targetHref = "http://localhost/projects/3/data?tab=all&filter=target";
    const targetState = { filter: "target", opaque: { owner: "target" }, tab: "all" };
    const initialHistoryLength = window.history.length;
    const forward = jest.spyOn(window.history, "forward").mockImplementation(() => {});
    const back = jest.spyOn(window.history, "back").mockImplementation(() => {});

    const targetEntry = replaceTrackedEntry(targetState, targetHref);
    const sourceEntry = pushTrackedEntry(sourceState, sourceHref);
    const historyLengthAfterSetup = window.history.length;

    // Browser Back has already made the target entry current when popstate runs.
    replaceEntryWithoutTracking(store, targetEntry.state, targetEntry.href);
    const replay = store.handlePopState({ state: targetEntry.state });

    expect(forward).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    expect(lsf.coordinateManagedNavigation).not.toHaveBeenCalled();
    expect(sdk.destroyLSF).not.toHaveBeenCalled();

    // Suppressed Forward returns to the browser's original source entry. No
    // URL/state fields are synthesized from the target.
    replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
    store.handlePopState({ state: sourceEntry.state });
    expect(lsf.coordinateManagedNavigation).toHaveBeenCalledWith(expect.any(Function), {
      intentKey: `popstate:${targetHref}`,
      reason: "popstate",
    });
    expect(window.location.href).toBe(sourceHref);
    expect(window.history.state).toEqual(sourceEntry.state);

    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(back).toHaveBeenCalledTimes(1);
    expect(store.managedPopstateTransition).toMatchObject({
      phase: "replay-target",
      sourceEntry,
      targetEntry,
    });

    replaceEntryWithoutTracking(store, targetEntry.state, targetEntry.href);
    store.handlePopState({ state: targetEntry.state });
    await replay;

    expect(window.location.href).toBe(targetHref);
    expect(window.history.state).toEqual(targetEntry.state);
    expect(window.history.length).toBe(historyLengthAfterSetup);
    expect(historyLengthAfterSetup).toBe(initialHistoryLength + 1);
    expect(store.managedPopstateTransition).toBeNull();
    expect(sdk.destroyLSF).toHaveBeenCalledTimes(1);
    destroy(store);
  });

  it("keeps the exact source after save failure and reaches the exact target on a second Back", async () => {
    const { store, lsf, sdk } = makeStore();
    const sourceHref = "http://localhost/projects/3/data?tab=review&filter=source&task=10&annotation=77";
    const sourceState = {
      annotation: "77",
      filter: "source",
      opaque: { attempt: 1 },
      tab: "review",
      task: "10",
    };
    const targetHref = "http://localhost/projects/3/data?tab=all&filter=target";
    const targetState = { filter: "target", opaque: { attempt: 2 }, tab: "all" };
    const initialHistoryLength = window.history.length;
    const forward = jest.spyOn(window.history, "forward").mockImplementation(() => {});
    const back = jest.spyOn(window.history, "back").mockImplementation(() => {});

    const targetEntry = replaceTrackedEntry(targetState, targetHref);
    const sourceEntry = pushTrackedEntry(sourceState, sourceHref);
    const historyLengthAfterSetup = window.history.length;

    lsf.coordinateManagedNavigation
      .mockImplementationOnce(() => Promise.resolve(false))
      .mockImplementationOnce((action) => Promise.resolve().then(action));
    replaceEntryWithoutTracking(store, targetEntry.state, targetEntry.href);
    const failed = store.handlePopState({ state: targetEntry.state });

    replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
    store.handlePopState({ state: sourceEntry.state });
    await expect(failed).resolves.toBe(false);

    expect(window.location.href).toBe(sourceHref);
    expect(window.history.state).toEqual(sourceEntry.state);
    expect(window.history.length).toBe(historyLengthAfterSetup);
    expect(historyLengthAfterSetup).toBe(initialHistoryLength + 1);
    expect(store.managedPopstateTransition).toBeNull();
    expect(forward).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    expect(sdk.destroyLSF).not.toHaveBeenCalled();

    replaceEntryWithoutTracking(store, targetEntry.state, targetEntry.href);
    const retry = store.handlePopState({ state: targetEntry.state });
    expect(forward).toHaveBeenCalledTimes(2);

    replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
    store.handlePopState({ state: sourceEntry.state });
    await Promise.resolve();
    await Promise.resolve();
    expect(back).toHaveBeenCalledTimes(1);

    replaceEntryWithoutTracking(store, targetEntry.state, targetEntry.href);
    store.handlePopState({ state: targetEntry.state });
    await retry;

    expect(window.location.href).toBe(targetHref);
    expect(window.history.state).toEqual(targetEntry.state);
    expect(window.history.length).toBe(historyLengthAfterSetup);
    expect(lsf.coordinateManagedNavigation).toHaveBeenCalledTimes(2);
    expect(store.managedPopstateTransition).toBeNull();
    expect(sdk.destroyLSF).toHaveBeenCalledTimes(1);
    destroy(store);
  });

  it("restores the exact source before a dirty Forward and replays the exact target once", async () => {
    const { gate, lsf, sdk, store } = makeStore();
    const sourceHref = "http://localhost/projects/3/data?tab=review&filter=source&task=10&annotation=77";
    const sourceState = {
      annotation: "77",
      filter: "source",
      opaque: { direction: "forward-source" },
      tab: "review",
      task: "10",
    };
    const targetHref = "http://localhost/projects/3/data?tab=all&filter=target";
    const targetState = { filter: "target", opaque: { direction: "forward-target" }, tab: "all" };
    const initialHistoryLength = window.history.length;
    const forward = jest.spyOn(window.history, "forward").mockImplementation(() => {});
    const back = jest.spyOn(window.history, "back").mockImplementation(() => {});
    const sourceEntry = replaceTrackedEntry(sourceState, sourceHref);
    const targetEntry = pushTrackedEntry(targetState, targetHref);
    const historyLengthAfterSetup = window.history.length;

    // Return to source without applying target; this is the entry from which
    // the user will press Forward.
    replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
    store.setManagedHistoryCurrentEntry(sourceEntry);

    replaceEntryWithoutTracking(store, targetEntry.state, targetEntry.href);
    const replay = store.handlePopState({ state: targetEntry.state });

    expect(back).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
    expect(lsf.coordinateManagedNavigation).not.toHaveBeenCalled();

    replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
    store.handlePopState({ state: sourceEntry.state });
    expect(lsf.coordinateManagedNavigation).toHaveBeenCalledWith(expect.any(Function), {
      intentKey: `popstate:${targetHref}`,
      reason: "popstate",
    });
    expect(window.location.href).toBe(sourceHref);
    expect(window.history.state).toEqual(sourceEntry.state);

    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(forward).toHaveBeenCalledTimes(1);
    expect(back).toHaveBeenCalledTimes(1);
    expect(store.managedPopstateTransition).toMatchObject({
      phase: "replay-target",
      replayMethod: "forward",
      restoreMethod: "back",
      sourceEntry,
      targetEntry,
    });

    replaceEntryWithoutTracking(store, targetEntry.state, targetEntry.href);
    store.handlePopState({ state: targetEntry.state });
    await replay;

    expect(window.location.href).toBe(targetHref);
    expect(window.history.state).toEqual(targetEntry.state);
    expect(window.history.length).toBe(historyLengthAfterSetup);
    expect(historyLengthAfterSetup).toBe(initialHistoryLength + 1);
    expect(store.managedPopstateTransition).toBeNull();
    expect(sdk.destroyLSF).toHaveBeenCalledTimes(1);
    destroy(store);
  });

  it("keeps the exact source after dirty Forward save failure and retries to the exact target", async () => {
    const { lsf, sdk, store } = makeStore();
    const sourceHref = "http://localhost/projects/3/data?tab=review&filter=source&task=10&annotation=77";
    const sourceState = {
      annotation: "77",
      filter: "source",
      opaque: { direction: "forward-source" },
      tab: "review",
      task: "10",
    };
    const targetHref = "http://localhost/projects/3/data?tab=all&filter=target";
    const targetState = { filter: "target", opaque: { direction: "forward-target" }, tab: "all" };
    const initialHistoryLength = window.history.length;
    const forward = jest.spyOn(window.history, "forward").mockImplementation(() => {});
    const back = jest.spyOn(window.history, "back").mockImplementation(() => {});
    const sourceEntry = replaceTrackedEntry(sourceState, sourceHref);
    const targetEntry = pushTrackedEntry(targetState, targetHref);
    const historyLengthAfterSetup = window.history.length;

    replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
    store.setManagedHistoryCurrentEntry(sourceEntry);
    lsf.coordinateManagedNavigation
      .mockImplementationOnce(() => Promise.resolve(false))
      .mockImplementationOnce((action) => Promise.resolve().then(action));

    replaceEntryWithoutTracking(store, targetEntry.state, targetEntry.href);
    const failed = store.handlePopState({ state: targetEntry.state });
    replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
    store.handlePopState({ state: sourceEntry.state });
    await expect(failed).resolves.toBe(false);

    expect(window.location.href).toBe(sourceHref);
    expect(window.history.state).toEqual(sourceEntry.state);
    expect(window.history.length).toBe(historyLengthAfterSetup);
    expect(historyLengthAfterSetup).toBe(initialHistoryLength + 1);
    expect(back).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
    expect(sdk.destroyLSF).not.toHaveBeenCalled();

    replaceEntryWithoutTracking(store, targetEntry.state, targetEntry.href);
    const retry = store.handlePopState({ state: targetEntry.state });
    expect(back).toHaveBeenCalledTimes(2);

    replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
    store.handlePopState({ state: sourceEntry.state });
    await Promise.resolve();
    await Promise.resolve();
    expect(forward).toHaveBeenCalledTimes(1);

    replaceEntryWithoutTracking(store, targetEntry.state, targetEntry.href);
    store.handlePopState({ state: targetEntry.state });
    await retry;

    expect(window.location.href).toBe(targetHref);
    expect(window.history.state).toEqual(targetEntry.state);
    expect(window.history.length).toBe(historyLengthAfterSetup);
    expect(lsf.coordinateManagedNavigation).toHaveBeenCalledTimes(2);
    expect(store.managedPopstateTransition).toBeNull();
    expect(sdk.destroyLSF).toHaveBeenCalledTimes(1);
    destroy(store);
  });

  it("recovers an unmarked pre-tracking Forward target before saving and replaying it once", async () => {
    jest.useFakeTimers();
    const setNavigationIndex = mockNavigationIndex(20);
    const { gate, lsf, sdk, store } = makeStore();

    try {
      const sourceHref = "http://localhost/projects/3/data?tab=review&legacy=source&task=10&annotation=77";
      const sourceState = {
        annotation: "77",
        legacy: "source",
        opaque: { generation: "before-tracking" },
        tab: "review",
        task: "10",
      };
      const targetHref = "http://localhost/projects/3/data?tab=all&legacy=target";
      const targetState = {
        legacy: "target",
        opaque: { generation: "before-tracking" },
        tab: "all",
      };
      const initialHistoryLength = window.history.length;
      const forward = jest.spyOn(window.history, "forward").mockImplementation(() => {});
      const back = jest.spyOn(window.history, "back").mockImplementation(() => {});
      const sourceEntry = replaceTrackedEntry(sourceState, sourceHref);
      const targetEntry = { href: targetHref, position: null, state: targetState };

      // The source was marked when tracking was installed, but this target is
      // an older forward entry and therefore has neither a marker nor a side
      // index position.
      expect(sourceEntry.state.__coordexp_refinement_history_v1).toBeDefined();
      expect(targetState.__coordexp_refinement_history_v1).toBeUndefined();
      expect(store.resolveManagedHistoryPosition(targetHref, targetState)).toBeNull();
      setNavigationIndex(21);
      replaceEntryWithoutTracking(store, targetState, targetHref);
      const replay = store.handlePopState({ state: targetState });

      expect(back).toHaveBeenCalledTimes(1);
      expect(forward).not.toHaveBeenCalled();
      expect(lsf.coordinateManagedNavigation).not.toHaveBeenCalled();

      setNavigationIndex(20);
      replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
      store.handlePopState({ state: sourceEntry.state });
      expect(lsf.coordinateManagedNavigation).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe(sourceHref);
      expect(window.history.state).toEqual(sourceEntry.state);

      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(forward).toHaveBeenCalledTimes(1);

      setNavigationIndex(21);
      replaceEntryWithoutTracking(store, targetEntry.state, targetEntry.href);
      store.handlePopState({ state: targetEntry.state });
      await replay;

      expect(window.location.href).toBe(targetHref);
      expect(window.history.state).toEqual(targetState);
      expect(window.history.length).toBe(initialHistoryLength);
      expect(lsf.coordinateManagedNavigation).toHaveBeenCalledTimes(1);
      expect(sdk.destroyLSF).toHaveBeenCalledTimes(1);
      expect(store.managedPopstateTransition).toBeNull();
      expect(store.managedPopstateTimer).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      destroy(store);
      jest.useRealTimers();
    }
  });

  it("uses the browser entry index to recover an unmarked Back target without probing past it", async () => {
    jest.useFakeTimers();
    const setNavigationIndex = mockNavigationIndex(30);
    const { gate, lsf, sdk, store } = makeStore();

    try {
      const sourceHref = "http://localhost/projects/3/data?tab=review&legacy=source&task=10&annotation=77";
      const sourceState = { annotation: "77", legacy: "source", tab: "review", task: "10" };
      const targetHref = "http://localhost/projects/3/data?tab=all&legacy=target";
      const targetState = { legacy: "target", tab: "all" };
      const initialHistoryLength = window.history.length;
      const forward = jest.spyOn(window.history, "forward").mockImplementation(() => {});
      const back = jest.spyOn(window.history, "back").mockImplementation(() => {});
      const sourceEntry = replaceTrackedEntry(sourceState, sourceHref);

      setNavigationIndex(29);
      replaceEntryWithoutTracking(store, targetState, targetHref);
      const replay = store.handlePopState({ state: targetState });
      expect(forward).toHaveBeenCalledTimes(1);
      expect(back).not.toHaveBeenCalled();
      expect(lsf.coordinateManagedNavigation).not.toHaveBeenCalled();

      setNavigationIndex(30);
      replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
      store.handlePopState({ state: sourceEntry.state });
      expect(lsf.coordinateManagedNavigation).toHaveBeenCalledTimes(1);

      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(back).toHaveBeenCalledTimes(1);

      setNavigationIndex(29);
      replaceEntryWithoutTracking(store, targetState, targetHref);
      store.handlePopState({ state: targetState });
      await replay;

      expect(window.location.href).toBe(targetHref);
      expect(window.history.state).toEqual(targetState);
      expect(window.history.length).toBe(initialHistoryLength);
      expect(lsf.coordinateManagedNavigation).toHaveBeenCalledTimes(1);
      expect(sdk.destroyLSF).toHaveBeenCalledTimes(1);
      expect(store.managedPopstateTransition).toBeNull();
      expect(store.managedPopstateTimer).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      destroy(store);
      jest.useRealTimers();
    }
  });

  it("fails closed without traversing an unindexed legacy entry", async () => {
    jest.useFakeTimers();
    const { lsf, sdk, store } = makeStore();

    try {
      const sourceHref = "http://localhost/projects/3/data?tab=review&legacy=source&task=10&annotation=77";
      const sourceState = { annotation: "77", legacy: "source", tab: "review", task: "10" };
      const targetHref = "http://localhost/projects/3/data?tab=all&legacy=target";
      const targetState = { legacy: "target", tab: "all" };
      const initialHistoryLength = window.history.length;
      const info = jest.spyOn(Modal, "info").mockImplementation(() => {});
      const forward = jest.spyOn(window.history, "forward").mockImplementation(() => {});
      const back = jest.spyOn(window.history, "back").mockImplementation(() => {});
      const sourceEntry = replaceTrackedEntry(sourceState, sourceHref);

      replaceEntryWithoutTracking(store, targetState, targetHref);
      let settled = false;
      const recovery = store.handlePopState({ state: targetState }).then((result) => {
        settled = true;
        return result;
      });

      await Promise.resolve();

      await expect(recovery).resolves.toBe(false);
      expect(settled).toBe(true);
      expect(info).toHaveBeenCalledTimes(1);
      expect(back).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
      expect(lsf.coordinateManagedNavigation).not.toHaveBeenCalled();
      expect(sdk.destroyLSF).not.toHaveBeenCalled();
      expect(store.managedHistoryCurrentEntry).toEqual(sourceEntry);
      expect(window.history.length).toBe(initialHistoryLength);
      expect(store.managedPopstateTransition).toBeNull();
      expect(store.managedPopstateTimer).toBeNull();
      expect(store.managedHistoryTraversalQuarantined).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      destroy(store);
      jest.useRealTimers();
    }
  });

  it("settles and clears an armed legacy recovery when the store is destroyed", async () => {
    jest.useFakeTimers();
    const setNavigationIndex = mockNavigationIndex(40);
    const { lsf, sdk, store } = makeStore();
    const sourceHref = "http://localhost/projects/3/data?tab=review&legacy=source&task=10&annotation=77";
    const sourceState = { annotation: "77", legacy: "source", tab: "review", task: "10" };
    const targetHref = "http://localhost/projects/3/data?tab=all&legacy=target";
    const targetState = { legacy: "target", tab: "all" };

    try {
      jest.spyOn(window.history, "back").mockImplementation(() => {});
      replaceTrackedEntry(sourceState, sourceHref);
      setNavigationIndex(41);
      replaceEntryWithoutTracking(store, targetState, targetHref);
      const recovery = store.handlePopState({ state: targetState });

      expect(store.managedPopstateTimer).not.toBeNull();
      destroy(store);

      await expect(recovery).resolves.toBe(false);
      expect(lsf.coordinateManagedNavigation).not.toHaveBeenCalled();
      expect(sdk.destroyLSF).not.toHaveBeenCalled();
      expect(store.managedPopstateTransition).toBeNull();
      expect(store.managedPopstateTimer).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      if (store.managedPopstateTransition !== null) destroy(store);
      jest.useRealTimers();
    }
  });

  it("settles a synchronous coordinator failure after recovering the exact source", async () => {
    jest.useFakeTimers();
    const setNavigationIndex = mockNavigationIndex(50);
    const { lsf, sdk, store } = makeStore();

    try {
      const sourceHref = "http://localhost/projects/3/data?tab=review&legacy=source&task=10&annotation=77";
      const sourceState = { annotation: "77", legacy: "source", tab: "review", task: "10" };
      const targetHref = "http://localhost/projects/3/data?tab=all&legacy=target";
      const targetState = { legacy: "target", tab: "all" };
      const info = jest.spyOn(Modal, "info").mockImplementation(() => {});
      jest.spyOn(window.history, "back").mockImplementation(() => {});
      const sourceEntry = replaceTrackedEntry(sourceState, sourceHref);

      lsf.coordinateManagedNavigation.mockImplementation(() => {
        throw new Error("coordinator unavailable");
      });
      setNavigationIndex(51);
      replaceEntryWithoutTracking(store, targetState, targetHref);
      const recovery = store.handlePopState({ state: targetState });
      setNavigationIndex(50);
      replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
      store.handlePopState({ state: sourceEntry.state });

      await expect(recovery).resolves.toBe(false);
      expect(info).toHaveBeenCalledTimes(1);
      expect(lsf.coordinateManagedNavigation).toHaveBeenCalledTimes(1);
      expect(sdk.destroyLSF).not.toHaveBeenCalled();
      expect(window.location.href).toBe(sourceHref);
      expect(window.history.state).toEqual(sourceEntry.state);
      expect(store.managedPopstateTransition).toBeNull();
      expect(store.managedPopstateTimer).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      destroy(store);
      jest.useRealTimers();
    }
  });

  it("quarantines delayed popstates after a timed-out indexed traversal", async () => {
    jest.useFakeTimers();
    const setNavigationIndex = mockNavigationIndex(60);
    const { lsf, sdk, store } = makeStore();

    try {
      const sourceHref = "http://localhost/projects/3/data?tab=review&late=source&task=10&annotation=77";
      const sourceState = { annotation: "77", late: "source", tab: "review", task: "10" };
      const targetHref = "http://localhost/projects/3/data?tab=all&late=target";
      const targetState = { late: "target", tab: "all" };
      const info = jest.spyOn(Modal, "info").mockImplementation(() => {});
      const forward = jest.spyOn(window.history, "forward").mockImplementation(() => {});
      const back = jest.spyOn(window.history, "back").mockImplementation(() => {});
      const sourceEntry = replaceTrackedEntry(sourceState, sourceHref);

      setNavigationIndex(61);
      replaceEntryWithoutTracking(store, targetState, targetHref);
      const recovery = store.handlePopState({ state: targetState });
      expect(back).toHaveBeenCalledTimes(1);

      jest.runOnlyPendingTimers();
      await expect(recovery).resolves.toBe(false);
      expect(info).toHaveBeenCalledTimes(1);
      expect(store.managedHistoryTraversalQuarantined).toBe(true);
      expect(store.managedPopstateTransition).toBeNull();
      expect(store.managedPopstateTimer).toBeNull();

      // A late event from the timed-out traversal and a later event are both
      // ignored even if a manual/background save made the source clean. A
      // popstate cannot prove it belongs to a newer browser generation.
      lsf.requiresManagedNavigationSave.mockReturnValue(false);
      setNavigationIndex(60);
      replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
      expect(store.handlePopState({ state: sourceEntry.state })).toBe(false);
      setNavigationIndex(61);
      replaceEntryWithoutTracking(store, targetState, targetHref);
      expect(store.handlePopState({ state: targetState })).toBe(false);

      expect(back).toHaveBeenCalledTimes(1);
      expect(forward).not.toHaveBeenCalled();
      expect(lsf.coordinateManagedNavigation).not.toHaveBeenCalled();
      expect(sdk.destroyLSF).not.toHaveBeenCalled();
      expect(store.managedHistoryCurrentEntry).toEqual(sourceEntry);
      expect(store.managedHistoryTraversalQuarantined).toBe(true);
      expect(store.managedPopstateTransition).toBeNull();
      expect(store.managedPopstateTimer).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      destroy(store);
      jest.useRealTimers();
    }
  });

  it("settles a direct history traversal throw without coordinating", async () => {
    jest.useFakeTimers();
    const { lsf, sdk, store } = makeStore();

    try {
      const sourceHref = "http://localhost/projects/3/data?tab=review&throw=source&task=10&annotation=77";
      const sourceState = { annotation: "77", tab: "review", task: "10", throw: "source" };
      const targetHref = "http://localhost/projects/3/data?tab=all&throw=target";
      const targetState = { tab: "all", throw: "target" };
      const info = jest.spyOn(Modal, "info").mockImplementation(() => {});
      const back = jest.spyOn(window.history, "back").mockImplementation(() => {
        throw new Error("history unavailable");
      });
      const forward = jest.spyOn(window.history, "forward").mockImplementation(() => {});
      const sourceEntry = replaceTrackedEntry(sourceState, sourceHref);
      const targetEntry = pushTrackedEntry(targetState, targetHref);
      const historyLength = window.history.length;

      replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
      store.setManagedHistoryCurrentEntry(sourceEntry);
      replaceEntryWithoutTracking(store, targetEntry.state, targetEntry.href);
      const recovery = store.handlePopState({ state: targetEntry.state });

      await expect(recovery).resolves.toBe(false);
      expect(back).toHaveBeenCalledTimes(1);
      expect(forward).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledTimes(1);
      expect(lsf.coordinateManagedNavigation).not.toHaveBeenCalled();
      expect(sdk.destroyLSF).not.toHaveBeenCalled();
      expect(window.history.length).toBe(historyLength);
      expect(store.managedHistoryCurrentEntry).toEqual(sourceEntry);
      expect(store.managedHistoryTraversalQuarantined).toBe(true);
      expect(store.managedPopstateTransition).toBeNull();
      expect(store.managedPopstateTimer).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      destroy(store);
      jest.useRealTimers();
    }
  });

  it("keeps quarantine and the side index when application history writes throw", () => {
    const nativePushState = window.history.pushState;
    const nativeReplaceState = window.history.replaceState;

    jest.spyOn(window.history, "pushState").mockImplementation(function (state, title, url) {
      if (String(url).includes("write-throw")) throw new DOMException("push failed", "SecurityError");
      return nativePushState.call(this, state, title, url);
    });
    jest.spyOn(window.history, "replaceState").mockImplementation(function (state, title, url) {
      if (String(url).includes("write-throw")) throw new DOMException("replace failed", "DataCloneError");
      return nativeReplaceState.call(this, state, title, url);
    });
    const { lsf, sdk, store } = makeStore();
    const sourceHref = "http://localhost/projects/3/data?tab=review&write=source&task=10&annotation=77";
    const sourceState = { annotation: "77", tab: "review", task: "10", write: "source" };
    const targetHref = "http://localhost/projects/3/data?tab=all&write=late-target";
    const targetState = { tab: "all", write: "late-target" };
    const sourceEntry = replaceTrackedEntry(sourceState, sourceHref);
    const entriesBefore = Array.from(store.managedHistoryEntries.entries());
    const historyLength = window.history.length;

    store.quarantineManagedHistoryTraversal();
    expect(() => window.history.pushState({ write: "push" }, "", "/projects/3/data?write-throw=push")).toThrow(
      "push failed",
    );
    expect(() => window.history.replaceState({ write: "replace" }, "", "/projects/3/data?write-throw=replace")).toThrow(
      "replace failed",
    );

    expect(store.managedHistoryTraversalQuarantined).toBe(true);
    expect(Array.from(store.managedHistoryEntries.entries())).toEqual(entriesBefore);
    expect(store.managedHistoryCurrentEntry).toEqual(sourceEntry);
    expect(window.history.length).toBe(historyLength);
    expect(window.location.href).toBe(sourceHref);

    lsf.requiresManagedNavigationSave.mockReturnValue(false);
    replaceEntryWithoutTracking(store, targetState, targetHref);
    expect(store.handlePopState({ state: targetState })).toBe(false);
    expect(lsf.coordinateManagedNavigation).not.toHaveBeenCalled();
    expect(sdk.destroyLSF).not.toHaveBeenCalled();
    expect(store.managedHistoryTraversalQuarantined).toBe(true);
    destroy(store);
  });

  it("does not replace managed null or non-object history state just to add a position marker", () => {
    const { store } = makeStore();

    window.history.replaceState(null, "", "/projects/3/data?task=10");
    expect(window.history.state).toBeNull();

    window.history.replaceState(["opaque", 7], "", "/projects/3/data?task=10&shape=array");
    expect(window.history.state).toEqual(["opaque", 7]);
    expect(window.history.state.__coordexp_refinement_history_v1).toBeUndefined();
    destroy(store);
  });

  it("uses the managed side index to restore a dirty Forward target whose state is null", async () => {
    const { lsf, store } = makeStore();
    const sourceState = { annotation: "77", tab: "review", task: "10" };
    const sourceHref = "http://localhost/projects/3/data?tab=review&task=10&annotation=77";
    const targetHref = "http://localhost/projects/3/data?tab=all&legacy=null";
    const back = jest.spyOn(window.history, "back").mockImplementation(() => {});
    const forward = jest.spyOn(window.history, "forward").mockImplementation(() => {});
    const sourceEntry = replaceTrackedEntry(sourceState, sourceHref);

    window.history.pushState(null, document.title, targetHref);
    const targetEntry = { ...store.managedHistoryCurrentEntry };
    expect(targetEntry).toMatchObject({ href: targetHref, position: sourceEntry.position + 1, state: null });
    expect(window.history.state).toBeNull();

    replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
    store.setManagedHistoryCurrentEntry(sourceEntry);
    lsf.coordinateManagedNavigation.mockResolvedValue(false);

    replaceEntryWithoutTracking(store, null, targetHref);
    const failed = store.handlePopState({ state: null });
    expect(back).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();

    replaceEntryWithoutTracking(store, sourceEntry.state, sourceEntry.href);
    store.handlePopState({ state: sourceEntry.state });
    await expect(failed).resolves.toBe(false);
    expect(window.location.href).toBe(sourceHref);
    expect(window.history.state).toEqual(sourceEntry.state);
    destroy(store);
  });

  it("keeps the exact ordinary null-state branch and closes without consulting URL task params", () => {
    const { lsf, sdk, store } = makeStore({ managed: false });

    window.history.replaceState(null, "", "/projects/3/data?task=10&annotation=77");
    expect(store.handlePopState({ state: null })).toBeUndefined();

    expect(lsf.coordinateManagedNavigation).not.toHaveBeenCalled();
    expect(sdk.setMode).toHaveBeenCalledWith("explorer");
    expect(sdk.destroyLSF).toHaveBeenCalledTimes(1);
    destroy(store);
  });
});

describe("managed history structured-clone identity", () => {
  const href = "http://localhost/projects/3/data?history=structured";
  const resolveAgainst = (store, recorded, candidate) => {
    store.managedHistoryEntries.clear();
    store.setManagedHistoryCurrentEntry({ href, position: 41, state: recorded });
    return store.resolveManagedHistoryPosition(href, candidate);
  };

  const makeEquivalentGraph = ({ reverse = false } = {}) => {
    const buffer = new ArrayBuffer(12);
    new Uint8Array(buffer).set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const shared = { label: "shared" };
    const cyclic = { label: "cycle" };
    const sparse = new Array(4);
    const regexp = /person-(\d+)/gim;

    cyclic.self = cyclic;
    sparse[1] = shared;
    sparse[3] = undefined;
    regexp.lastIndex = 3;
    const mapEntries = [
      [{ id: 1 }, shared],
      [{ id: 2 }, cyclic],
    ];
    const setEntries = [shared, cyclic, "person", Number.NaN];
    const entries = [
      ["arrayBuffer", buffer],
      ["bigint", 9007199254740993n],
      ["cycle", cyclic],
      ["dataView", new DataView(buffer, 2, 6)],
      ["date", new Date("2026-07-15T12:34:56.789Z")],
      ["map", new Map(reverse ? [...mapEntries].reverse() : mapEntries)],
      ["nan", Number.NaN],
      ["negativeZero", -0],
      ["regexp", regexp],
      ["set", new Set(reverse ? [...setEntries].reverse() : setEntries)],
      ["sharedAgain", shared],
      ["sparse", sparse],
      ["typed", new Uint16Array(buffer, 2, 3)],
    ];

    return Object.fromEntries(reverse ? entries.reverse() : entries);
  };

  it("matches equivalent structured-clone graphs independent of object, Map, and Set order", () => {
    const { store } = makeStore();
    const recorded = makeEquivalentGraph();
    const reorderedClone = makeEquivalentGraph({ reverse: true });

    expect(resolveAgainst(store, recorded, reorderedClone)).toBe(41);
    destroy(store);
  });

  it.each([
    ["Map value", () => ({ value: new Map([["person", 1]]) }), () => ({ value: new Map([["person", 2]]) })],
    ["Set member", () => ({ value: new Set(["person", 1]) }), () => ({ value: new Set(["person", 2]) })],
    [
      "ArrayBuffer byte",
      () => ({ value: new Uint8Array([1, 2, 3]).buffer }),
      () => ({ value: new Uint8Array([1, 2, 4]).buffer }),
    ],
    ["typed-array byte", () => ({ value: new Uint16Array([1, 2, 3]) }), () => ({ value: new Uint16Array([1, 2, 4]) })],
    [
      "shared-reference topology",
      () => {
        const shared = { value: 1 };
        return { first: shared, second: shared };
      },
      () => ({ first: { value: 1 }, second: { value: 1 } }),
    ],
    [
      "cycle topology",
      () => {
        const root = {};
        root.link = root;
        return root;
      },
      () => {
        const root = {};
        root.link = { link: root };
        return root;
      },
    ],
    ["signed zero", () => ({ value: -0 }), () => ({ value: 0 })],
    [
      "unsupported opaque class",
      () => ({ value: new (class Opaque {})() }),
      () => ({ value: new (class Opaque {})() }),
    ],
  ])("fails closed for distinct %s state at the same href", (_name, makeRecorded, makeCandidate) => {
    const { store } = makeStore();

    expect(resolveAgainst(store, makeRecorded(), makeCandidate())).toBeNull();
    destroy(store);
  });

  it.each(["Map", "Set"])("bounds ambiguous %s matching and fails closed", (collectionKind) => {
    const { store } = makeStore();
    const makeMember = (value = 1) => ({ nested: { kind: "ambiguous", value } });
    const leftMembers = Array.from({ length: 12 }, () => makeMember());
    const rightMembers = [...Array.from({ length: 11 }, () => makeMember()), makeMember(2)];
    const recorded =
      collectionKind === "Map" ? new Map(leftMembers.map((member) => [{ key: "same" }, member])) : new Set(leftMembers);
    const candidate =
      collectionKind === "Map"
        ? new Map(rightMembers.map((member) => [{ key: "same" }, member]))
        : new Set(rightMembers);
    const startedAt = performance.now();

    expect(resolveAgainst(store, { value: recorded }, { value: candidate })).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(1000);
    destroy(store);
  });
});
