import { act, render, screen } from "@testing-library/react";

import {
  DATA_MANAGER_READY_EVENT,
  initializeOwnedDataManager,
  resolveOwnedDataManagerProject,
  useReadyDataManager,
} from "./data-manager-ready";

const resolver = (store, candidate) => (candidate?.store === store ? candidate : null);
const manager = (store, id, projectId = 7) => ({ id, store, lsf: { project: { id: projectId } } });

const ownedManager = (editorStore, projectId = 7) => {
  const project = { id: projectId };
  const ownerStore = { project };
  const candidate = {
    projectId,
    store: ownerStore,
    lsf: {
      datamanager: null,
      store: ownerStore,
      project,
      lsfInstance: { store: editorStore },
      isManagedRefinementProject: true,
    },
  };

  candidate.lsf.datamanager = candidate;
  return candidate;
};

const Harness = ({ store, candidate }) => {
  const dataManager = useReadyDataManager(store, candidate, resolver);

  return dataManager ? <div data-testid="manager">{dataManager.id}</div> : null;
};

const publish = (value, detail = value) => {
  window.dataManager = value;
  window.dispatchEvent(new CustomEvent(DATA_MANAGER_READY_EVENT, { detail }));
};

const deferred = () => {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });

  return { promise, resolve };
};

describe("initializeOwnedDataManager", () => {
  afterEach(() => {
    delete window.dataManager;
  });

  it("does not create or publish after unmount while ML backends are delayed", async () => {
    const mlBackends = deferred();
    const create = jest.fn();
    const publishOwned = jest.fn((dataManager) => publish(dataManager));
    let mounted = true;
    const operation = initializeOwnedDataManager({
      load: () => mlBackends.promise,
      create,
      isOwner: () => mounted,
      publish: publishOwned,
    });

    mounted = false;
    mlBackends.resolve([]);

    await expect(operation).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(publishOwned).not.toHaveBeenCalled();
    expect(window.dataManager).toBeUndefined();
  });

  it("publishes only B when project B ML backends resolve before project A", async () => {
    const mlBackendsA = deferred();
    const mlBackendsB = deferred();
    const managerA = { id: "A", destroy: jest.fn() };
    const managerB = { id: "B", destroy: jest.fn() };
    const createA = jest.fn(async () => managerA);
    const ready = [];
    const listener = (event) => ready.push(event.detail);
    let generation = 1;

    window.addEventListener(DATA_MANAGER_READY_EVENT, listener);
    try {
      const operationA = initializeOwnedDataManager({
        load: () => mlBackendsA.promise,
        create: createA,
        isOwner: () => generation === 1,
        publish,
      });

      generation = 2;
      const operationB = initializeOwnedDataManager({
        load: () => mlBackendsB.promise,
        create: async () => managerB,
        isOwner: () => generation === 2,
        publish,
      });

      mlBackendsB.resolve([]);
      await expect(operationB).resolves.toBe(managerB);
      mlBackendsA.resolve([]);
      await expect(operationA).resolves.toBeNull();

      expect(createA).not.toHaveBeenCalled();
      expect(managerA.destroy).not.toHaveBeenCalled();
      expect(managerB.destroy).not.toHaveBeenCalled();
      expect(window.dataManager).toBe(managerB);
      expect(ready).toEqual([managerB]);
    } finally {
      window.removeEventListener(DATA_MANAGER_READY_EVENT, listener);
    }
  });

  it("publishes only B when A and B creation resolve in reverse order and destroys the loser", async () => {
    const aCreation = deferred();
    const managerA = { id: "A", destroy: jest.fn() };
    const managerB = { id: "B", destroy: jest.fn() };
    const ready = [];
    const listener = (event) => ready.push(event.detail);
    let generation = 1;
    const publishOwned = (dataManager) => publish(dataManager);

    window.addEventListener(DATA_MANAGER_READY_EVENT, listener);
    try {
      const operationA = initializeOwnedDataManager({
        load: async () => [],
        create: () => aCreation.promise,
        isOwner: () => generation === 1,
        publish: publishOwned,
      });

      await Promise.resolve();
      generation = 2;
      const operationB = initializeOwnedDataManager({
        load: async () => [],
        create: async () => managerB,
        isOwner: () => generation === 2,
        publish: publishOwned,
      });

      await expect(operationB).resolves.toBe(managerB);
      aCreation.resolve(managerA);
      await expect(operationA).resolves.toBeNull();

      expect(managerA.destroy).toHaveBeenCalledTimes(1);
      expect(managerB.destroy).not.toHaveBeenCalled();
      expect(window.dataManager).toBe(managerB);
      expect(ready).toEqual([managerB]);
    } finally {
      window.removeEventListener(DATA_MANAGER_READY_EVENT, listener);
    }
  });
});

describe("resolveOwnedDataManagerProject", () => {
  it("returns the exact owning project when the editor store has no project", () => {
    const editorStore = { project: null };
    const candidate = ownedManager(editorStore);

    expect(resolveOwnedDataManagerProject(editorStore, candidate)).toBe(candidate.store.project);
  });

  it.each([
    ["candidate back-reference", (candidate) => (candidate.lsf.datamanager = {})],
    ["owner-store back-reference", (candidate) => (candidate.lsf.store = { project: candidate.lsf.project })],
    ["editor-store identity", (candidate) => (candidate.lsf.lsfInstance.store = { project: null })],
    ["canonical project object", (candidate) => (candidate.lsf.project = { id: 7 })],
    ["managed marker", (candidate) => (candidate.lsf.isManagedRefinementProject = false)],
    ["candidate project id", (candidate) => (candidate.projectId = 8)],
    [
      "positive project id",
      (candidate) => {
        candidate.projectId = 0;
        candidate.store.project.id = 0;
      },
    ],
    [
      "safe project id",
      (candidate) => {
        candidate.projectId = Number.MAX_SAFE_INTEGER + 1;
        candidate.store.project.id = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
  ])("rejects a mismatched %s", (_name, mutate) => {
    const editorStore = { project: null };
    const candidate = ownedManager(editorStore);

    mutate(candidate);

    expect(resolveOwnedDataManagerProject(editorStore, candidate)).toBeNull();
  });
});

describe("useReadyDataManager", () => {
  afterEach(() => {
    delete window.dataManager;
    jest.restoreAllMocks();
  });

  it("seeds from an event published before mount and reacts after an initial null render", () => {
    const store = { project: null };
    const first = manager(store, "first");

    publish(first);
    const { unmount } = render(<Harness store={store} />);

    expect(screen.getByTestId("manager")).toHaveTextContent("first");
    unmount();

    publish(null);
    render(<Harness store={store} />);
    expect(screen.queryByTestId("manager")).not.toBeInTheDocument();

    act(() => publish(manager(store, "later")));
    expect(screen.getByTestId("manager")).toHaveTextContent("later");
  });

  it("ignores malformed, stale, and other-store events", () => {
    const store = { project: null };
    const otherStore = { project: null };

    publish(null);
    render(<Harness store={store} />);

    act(() => publish(manager(otherStore, "other")));
    expect(screen.queryByTestId("manager")).not.toBeInTheDocument();

    const current = manager(store, "current");

    act(() => publish(current, { malformed: true }));
    expect(screen.queryByTestId("manager")).not.toBeInTheDocument();

    act(() => publish(current));
    expect(screen.getByTestId("manager")).toHaveTextContent("current");

    act(() => window.dispatchEvent(new CustomEvent(DATA_MANAGER_READY_EVENT, { detail: null })));
    expect(screen.getByTestId("manager")).toHaveTextContent("current");
  });

  it("preserves explicit candidate precedence without subscribing to global readiness", () => {
    const store = { project: null };
    const explicit = manager(store, "explicit");
    const addEventListener = jest.spyOn(window, "addEventListener");

    publish(manager(store, "global"));
    render(<Harness store={store} candidate={explicit} />);
    expect(screen.getByTestId("manager")).toHaveTextContent("explicit");

    act(() => publish(manager(store, "replacement")));
    expect(screen.getByTestId("manager")).toHaveTextContent("explicit");
    expect(addEventListener).not.toHaveBeenCalledWith(DATA_MANAGER_READY_EVENT, expect.any(Function));
  });

  it("removes the exact readiness listener on unmount", () => {
    const store = { project: null };
    const addEventListener = jest.spyOn(window, "addEventListener");
    const removeEventListener = jest.spyOn(window, "removeEventListener");
    const { unmount } = render(<Harness store={store} />);
    const listener = addEventListener.mock.calls.find(([name]) => name === DATA_MANAGER_READY_EVENT)?.[1];

    expect(listener).toEqual(expect.any(Function));
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith(DATA_MANAGER_READY_EVENT, listener);
  });

  it("replaces a manager and resets across store and project transitions", () => {
    const storeA = { project: null };
    const storeB = { project: null };

    publish(null);
    const { rerender } = render(<Harness store={storeA} />);

    act(() => publish(manager(storeA, "a1")));
    expect(screen.getByTestId("manager")).toHaveTextContent("a1");

    act(() => publish(manager(storeA, "a2")));
    expect(screen.getByTestId("manager")).toHaveTextContent("a2");

    rerender(<Harness store={storeB} />);
    expect(screen.queryByTestId("manager")).not.toBeInTheDocument();

    act(() => publish(manager(storeB, "b", 8)));
    expect(screen.getByTestId("manager")).toHaveTextContent("b");
  });

  it("replaces the exact-store manager when the owning candidate project changes", () => {
    const store = { project: null };

    publish(manager(store, "project-7", 7));
    render(<Harness store={store} />);
    expect(screen.getByTestId("manager")).toHaveTextContent("project-7");

    act(() => publish(manager(store, "project-8", 8)));
    expect(screen.getByTestId("manager")).toHaveTextContent("project-8");
  });
});
