import { destroy, flow, types } from "mobx-state-tree";
import { runInAction } from "mobx";
import { Modal } from "../components/Common/Modal/Modal";
import { FF_DEV_2887, FF_DISABLE_GLOBAL_USER_FETCHING, FF_LOPS_E_3, isFF } from "../utils/feature-flags";
import { History } from "../utils/history";
import { isDefined } from "../utils/utils";
import { Action } from "./Action";
import * as DataStores from "./DataStores";
import { registerModel } from "./DynamicModel";
import { TabStore } from "./Tabs";
import { CustomJSON } from "./types";
import { User } from "./Users";
import { ActivityObserver } from "../utils/ActivityObserver";

/**
 * @type {ActivityObserver | null}
 */
let networkActivity = null;

const PROJECTS_FETCH_PERIOD = 20 * 1000; // interaction timer for 20 sec fetch period for project api
const COORDEXP_MANAGED_PROJECT_PREFIX = "coordexp-refinement-project-identity:";
const COORDEXP_HISTORY_STATE_KEY = "__coordexp_refinement_history_v1";
const MANAGED_HISTORY_TRAVERSAL_TIMEOUT_MS = 1000;
const STRUCTURED_HISTORY_COMPARISON_BUDGET = 10_000;
let managedHistorySessionSequence = 0;

const isPlainHistoryState = (state) => {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return false;
  const prototype = Object.getPrototypeOf(state);

  return prototype === Object.prototype || prototype === null;
};

const managedHistoryStateMarker = (state) => {
  const marker = isPlainHistoryState(state) ? state[COORDEXP_HISTORY_STATE_KEY] : null;

  return typeof marker?.session_id === "string" && Number.isSafeInteger(marker?.position) ? marker : null;
};

const managedHistoryMarker = (state, sessionId) => {
  const marker = managedHistoryStateMarker(state);

  return marker?.session_id === sessionId ? marker : null;
};

const structuredHistoryKind = (value) => {
  if (Array.isArray(value)) return "array";
  if (isPlainHistoryState(value)) return "object";
  if (ArrayBuffer.isView(value)) {
    return Object.prototype.toString.call(value) === "[object DataView]" ? "data-view" : "typed-array";
  }

  switch (Object.prototype.toString.call(value)) {
    case "[object ArrayBuffer]":
      return "array-buffer";
    case "[object Date]":
      return "date";
    case "[object Map]":
      return "map";
    case "[object RegExp]":
      return "regexp";
    case "[object Set]":
      return "set";
    default:
      return null;
  }
};

const withStructuredHistoryPair = (context, left, right) => ({
  budget: context.budget,
  leftToRight: new Map(context.leftToRight).set(left, right),
  rightToLeft: new Map(context.rightToLeft).set(right, left),
});

const structuredHistoryBytesEqual = (left, right) => {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);

  return leftBytes.every((byte, index) => byte === rightBytes[index]);
};

const compareStructuredHistoryUnordered = (
  leftItems,
  rightItems,
  context,
  compareItem,
  index = 0,
  used = new Set(),
) => {
  if (index === leftItems.length) return context;

  for (let rightIndex = 0; rightIndex < rightItems.length; rightIndex++) {
    if (used.has(rightIndex)) continue;
    const compared = compareItem(leftItems[index], rightItems[rightIndex], context);

    if (!compared) continue;
    const nextUsed = new Set(used).add(rightIndex);
    const complete = compareStructuredHistoryUnordered(
      leftItems,
      rightItems,
      compared,
      compareItem,
      index + 1,
      nextUsed,
    );

    if (complete) return complete;
  }
  return null;
};

const compareStructuredHistoryValue = (left, right, context) => {
  if (context.budget.remaining <= 0) return null;
  context.budget.remaining -= 1;
  const leftIsObject = left !== null && (typeof left === "object" || typeof left === "function");
  const rightIsObject = right !== null && (typeof right === "object" || typeof right === "function");

  if (!leftIsObject || !rightIsObject)
    return !leftIsObject && !rightIsObject && Object.is(left, right) ? context : null;

  const leftKind = structuredHistoryKind(left);
  const rightKind = structuredHistoryKind(right);

  // History state is structured-cloned by the browser. Unknown class
  // instances and opaque platform objects fail closed instead of comparing as
  // empty JSON objects.
  if (!leftKind || leftKind !== rightKind) return null;
  if (context.leftToRight.has(left)) return context.leftToRight.get(left) === right ? context : null;
  if (context.rightToLeft.has(right)) return null;

  let compared = withStructuredHistoryPair(context, left, right);

  if (leftKind === "array-buffer") return structuredHistoryBytesEqual(left, right) ? compared : null;
  if (leftKind === "date") return Object.is(left.getTime(), right.getTime()) ? compared : null;
  if (leftKind === "regexp") {
    return left.source === right.source && left.flags === right.flags && left.lastIndex === right.lastIndex
      ? compared
      : null;
  }
  if (leftKind === "data-view") {
    if (left.byteOffset !== right.byteOffset || left.byteLength !== right.byteLength) return null;
    return compareStructuredHistoryValue(left.buffer, right.buffer, compared);
  }
  if (leftKind === "typed-array") {
    if (
      Object.prototype.toString.call(left) !== Object.prototype.toString.call(right) ||
      left.byteOffset !== right.byteOffset ||
      left.byteLength !== right.byteLength ||
      left.length !== right.length
    ) {
      return null;
    }
    return compareStructuredHistoryValue(left.buffer, right.buffer, compared);
  }
  if (leftKind === "map") {
    if (left.size !== right.size) return null;
    return compareStructuredHistoryUnordered(
      Array.from(left.entries()),
      Array.from(right.entries()),
      compared,
      ([leftKey, leftValue], [rightKey, rightValue], branch) => {
        const keyCompared = compareStructuredHistoryValue(leftKey, rightKey, branch);

        return keyCompared ? compareStructuredHistoryValue(leftValue, rightValue, keyCompared) : null;
      },
    );
  }
  if (leftKind === "set") {
    if (left.size !== right.size) return null;
    return compareStructuredHistoryUnordered(
      Array.from(left.values()),
      Array.from(right.values()),
      compared,
      compareStructuredHistoryValue,
    );
  }

  if (leftKind === "array" && left.length !== right.length) return null;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return null;
  for (const key of leftKeys) {
    compared = compareStructuredHistoryValue(left[key], right[key], compared);
    if (!compared) return null;
  }
  return compared;
};

const historyStatesEqual = (left, right) => {
  try {
    return Boolean(
      compareStructuredHistoryValue(left, right, {
        budget: { remaining: STRUCTURED_HISTORY_COMPARISON_BUDGET },
        leftToRight: new Map(),
        rightToLeft: new Map(),
      }),
    );
  } catch {
    return false;
  }
};

const managedHistoryBrowserIndex = () => {
  try {
    const index = window.navigation?.currentEntry?.index;

    return Number.isSafeInteger(index) ? index : null;
  } catch {
    return null;
  }
};

const historyEntryMatches = (entry, href = window.location.href, state = window.history.state) =>
  entry?.href === href &&
  historyStatesEqual(entry.state, state) &&
  (!Number.isSafeInteger(entry.browserIndex) || entry.browserIndex === managedHistoryBrowserIndex());

export const AppStore = types
  .model("AppStore", {
    mode: types.optional(types.enumeration(["explorer", "labelstream", "labeling"]), "explorer"),

    viewsStore: types.optional(TabStore, {
      views: [],
    }),

    project: types.optional(CustomJSON, {}),

    loading: types.optional(types.boolean, false),

    loadingData: false,

    users: types.optional(types.array(User), []),

    availableActions: types.optional(types.array(Action), []),

    serverError: types.map(CustomJSON),

    crashed: false,

    interfaces: types.map(types.boolean),

    toolbar: types.string,
  })
  .views((self) => ({
    /** @returns {import("../sdk/dm-sdk").DataManager} */
    get SDK() {
      return self._sdk;
    },

    /** @returns {import("../sdk/lsf-sdk").LSFWrapper} */
    get LSF() {
      return self.SDK.lsf;
    },

    /** @returns {import("../utils/api-proxy").APIProxy} */
    get API() {
      return self.SDK.api;
    },

    get apiVersion() {
      return self.SDK.apiVersion;
    },

    get isLabeling() {
      return !!self.dataStore?.selected || self.isLabelStreamMode || self.mode === "labeling";
    },

    get isLabelStreamMode() {
      return self.mode === "labelstream";
    },

    get isExplorerMode() {
      return self.mode === "explorer" || self.mode === "labeling";
    },

    get currentView() {
      return self.viewsStore.selected;
    },

    get dataStore() {
      switch (self.target) {
        case "tasks":
          return self.taskStore;
        case "annotations":
          return self.annotationStore;
        default:
          return null;
      }
    },

    get target() {
      return self.viewsStore.selected?.target ?? "tasks";
    },

    get labelingIsConfigured() {
      return self.project?.config_has_control_tags === true;
    },

    get labelingConfig() {
      return self.project.label_config_line ?? self.project.label_config;
    },

    get showPreviews() {
      return self.SDK.showPreviews;
    },

    get currentSelection() {
      return self.currentView.selected.snapshot;
    },

    get currentFilter() {
      return self.currentView.filterSnapshot;
    },

    get usersMap() {
      return new Map(self.users.map((user) => [user.id, user]));
    },
  }))
  .volatile(() => ({
    needsDataFetch: false,
    projectFetch: false,
    requestsInFlight: new Map(),
    managedPopstateTransition: null,
    managedHistoryCurrentEntry: null,
    managedHistoryEntries: new Map(),
    managedHistoryInstalled: false,
    managedHistoryOriginalPushState: null,
    managedHistoryOriginalReplaceState: null,
    managedHistoryPosition: 0,
    managedHistoryPushStateWrapper: null,
    managedHistoryReplaceStateWrapper: null,
    managedHistorySessionId: null,
    managedHistoryTraversalQuarantined: false,
    managedPopstateTimer: null,
  }))
  .actions((self) => ({
    startPolling() {
      if (self._poll) return;
      if (self.SDK.polling === false) return;

      const poll = async (self) => {
        if (networkActivity.active) await self.fetchProject({ interaction: "timer" });
        self._poll = setTimeout(() => poll(self), PROJECTS_FETCH_PERIOD);
      };

      poll(self);
    },

    afterCreate() {
      networkActivity?.destroy();
      networkActivity = new ActivityObserver();
    },

    beforeDestroy() {
      clearTimeout(self._poll);
      self.cancelManagedPopstateTransition();
      window.removeEventListener("popstate", self.handlePopState);
      self.uninstallManagedHistoryTracking();
      networkActivity.destroy();
    },

    isManagedHistoryProject() {
      return (
        typeof self.project?.description === "string" &&
        self.project.description.startsWith(COORDEXP_MANAGED_PROJECT_PREFIX)
      );
    },

    setManagedHistoryCurrentEntry(entry) {
      self.managedHistoryCurrentEntry = entry;
      if (Number.isSafeInteger(entry?.position)) {
        self.managedHistoryPosition = entry.position;
        self.managedHistoryEntries.set(entry.position, entry);
      }
    },

    resetManagedHistoryTraversalQuarantine() {
      self.managedHistoryTraversalQuarantined = false;
    },

    quarantineManagedHistoryTraversal() {
      self.managedHistoryTraversalQuarantined = true;
    },

    resolveManagedHistoryPosition(href, state) {
      const candidates = Array.from(self.managedHistoryEntries.entries()).filter(
        ([, entry]) => entry.href === href && historyStatesEqual(entry.state, state),
      );

      return candidates.length === 1 ? candidates[0][0] : null;
    },

    truncateManagedHistoryAfter(position) {
      for (const knownPosition of self.managedHistoryEntries.keys()) {
        if (knownPosition > position) self.managedHistoryEntries.delete(knownPosition);
      }
    },

    recordManagedHistoryCurrentEntry(position = null) {
      const marker = managedHistoryMarker(window.history.state, self.managedHistorySessionId);
      const resolvedPosition = Number.isSafeInteger(position)
        ? position
        : (marker?.position ?? self.managedHistoryPosition);

      self.setManagedHistoryCurrentEntry({
        browserIndex: managedHistoryBrowserIndex(),
        href: window.location.href,
        position: resolvedPosition,
        state: window.history.state,
      });
      return self.managedHistoryCurrentEntry;
    },

    installManagedHistoryTracking() {
      if (self.managedHistoryInstalled || !self.isManagedHistoryProject()) return;

      const history = window.history;
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      const existingMarker = managedHistoryStateMarker(history.state);

      self.managedHistorySessionId =
        existingMarker?.session_id ?? `coordexp-${Date.now()}-${++managedHistorySessionSequence}`;
      self.managedHistoryTraversalQuarantined = false;
      self.managedHistoryPosition = existingMarker?.position ?? 0;
      self.managedHistoryOriginalPushState = originalPushState;
      self.managedHistoryOriginalReplaceState = originalReplaceState;

      const withMarker = (state, position) => {
        if (!isPlainHistoryState(state)) return state;
        return {
          ...state,
          [COORDEXP_HISTORY_STATE_KEY]: {
            position,
            session_id: self.managedHistorySessionId,
          },
        };
      };

      self.managedHistoryPushStateWrapper = function (state, title, url) {
        if (!self.isManagedHistoryProject()) return originalPushState.call(history, state, title, url);

        const position = self.managedHistoryPosition + 1;
        const result = originalPushState.call(history, withMarker(state, position), title, url);

        // Only a successful application-owned write is an explicit generation
        // reset. A throwing native write must leave both quarantine and the
        // forward side-index untouched.
        self.truncateManagedHistoryAfter(self.managedHistoryPosition);
        self.resetManagedHistoryTraversalQuarantine();
        self.recordManagedHistoryCurrentEntry(position);
        return result;
      };
      self.managedHistoryReplaceStateWrapper = function (state, title, url) {
        if (!self.isManagedHistoryProject()) return originalReplaceState.call(history, state, title, url);

        const result = originalReplaceState.call(history, withMarker(state, self.managedHistoryPosition), title, url);

        self.resetManagedHistoryTraversalQuarantine();
        self.recordManagedHistoryCurrentEntry(self.managedHistoryPosition);
        return result;
      };

      history.pushState = self.managedHistoryPushStateWrapper;
      history.replaceState = self.managedHistoryReplaceStateWrapper;
      self.managedHistoryInstalled = true;

      if (isPlainHistoryState(history.state)) {
        history.replaceState(history.state, document.title, window.location.href);
      } else {
        self.recordManagedHistoryCurrentEntry(0);
      }
    },

    uninstallManagedHistoryTracking() {
      if (!self.managedHistoryInstalled) return;

      self.clearManagedPopstateTimer();
      const history = window.history;

      history.pushState = self.managedHistoryOriginalPushState;
      history.replaceState = self.managedHistoryOriginalReplaceState;
      self.managedHistoryInstalled = false;
      self.managedHistoryOriginalPushState = null;
      self.managedHistoryOriginalReplaceState = null;
      self.managedHistoryPushStateWrapper = null;
      self.managedHistoryReplaceStateWrapper = null;
      self.managedHistoryTraversalQuarantined = false;
    },

    setMode(mode) {
      self.mode = mode;
    },

    setActions(actions) {
      if (!Array.isArray(actions)) throw new Error("Actions must be an array");
      self.availableActions = actions;
    },

    removeAction(id) {
      const action = self.availableActions.find((action) => action.id === id);

      if (action) destroy(action);
    },

    interfaceEnabled(name) {
      return self.interfaces.get(name) === true;
    },

    enableInterface(name) {
      if (!self.interfaces.has(name)) {
        console.warn(`Unknown interface ${name}`);
      } else {
        self.interfaces.set(name, true);
      }
    },

    disableInterface(name) {
      if (!self.interfaces.has(name)) {
        console.warn(`Unknown interface ${name}`);
      } else {
        self.interfaces.set(name, false);
      }
    },

    setToolbar(toolbarString) {
      self.toolbar = toolbarString;
    },

    setTask: flow(function* ({ taskID, annotationID, pushState, interface: interfaceOption }) {
      if (pushState !== false) {
        History.navigate({
          task: taskID,
          annotation: annotationID ?? null,
          interaction: null,
          region: null,
        });
      } else {
        const { task, region, annotation } = History.getParams();
        History.navigate(
          {
            task,
            region,
            annotation,
          },
          true,
        );
      }

      if (!isDefined(taskID)) return;

      self.setLoadingData(true);

      // Yield to browser so loading indicator paints before heavy store operations
      yield new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      if (self.mode === "labelstream") {
        yield self.taskStore.loadNextTask({
          select: !!taskID && !!annotationID,
        });
      }

      runInAction(() => {
        if (annotationID !== undefined) {
          self.annotationStore.setSelected(annotationID);
        } else {
          self.taskStore.setSelected(taskID);
        }
      });

      const taskPromise = self.taskStore.loadTask(taskID, {
        select: !!taskID && !!annotationID,
      });

      // wait for the task to be loaded and LSF to be initialized
      yield taskPromise.then(async () => {
        // wait for self.LSF to be initialized with currentAnnotation
        let maxWait = 1000;
        while (!self.LSF?.currentAnnotation && maxWait > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          maxWait -= 1;
        }

        if (self.LSF) {
          const annotation = self.LSF?.currentAnnotation;
          const id = annotation?.pk ?? annotation?.id;

          self.LSF?.setLSFTask(self.taskStore.selected, id);

          const { annotation: annIDFromUrl, region: regionIDFromUrl } = History.getParams();
          const annotationStore = self.LSF?.lsf?.annotationStore;

          if (annIDFromUrl && annotationStore) {
            const lsfAnnotation = [...annotationStore.annotations, ...annotationStore.predictions].find((a) => {
              return a.pk === annIDFromUrl || a.id === annIDFromUrl;
            });

            if (lsfAnnotation) {
              const annID = lsfAnnotation.pk ?? lsfAnnotation.id;
              self.LSF?.setLSFTask(self.taskStore.selected, annID, undefined, lsfAnnotation.type === "prediction");
            }
          }
          if (regionIDFromUrl) {
            const currentAnn = self.LSF?.currentAnnotation;
            // Focus on the region by hiding all other regions
            currentAnn?.regionStore?.setRegionVisible(regionIDFromUrl);
            // Select the region so outliner details are visible
            currentAnn?.regionStore?.selectRegionByID(regionIDFromUrl);
          }

          // Enable viewingAll mode if interface option is "annotations:view-all"
          if (interfaceOption === "annotations:view-all" && annotationStore) {
            if (!annotationStore.viewingAll) {
              annotationStore.toggleViewingAllAnnotations();
            }
            // Don't set the tab - let it use whatever was last selected
          }
        } else {
          console.error("LSF not initialized properly");
        }

        self.setLoadingData(false);
      });
    }),

    setLoadingData(value) {
      self.loadingData = value;
    },

    unsetTask(options) {
      try {
        self.annotationStore.unset();
        self.taskStore.unset();
      } catch (_e) {
        /* Something weird */
      }

      if (options?.pushState !== false) {
        History.navigate({ task: null, annotation: null });
      }
    },

    unsetSelection() {
      self.annotationStore.unset({ withHightlight: true });
      self.taskStore.unset({ withHightlight: true });
    },

    createDataStores() {
      const grouppedColumns = self.viewsStore.columns.reduce((res, column) => {
        res.set(column.target, res.get(column.target) ?? []);
        res.get(column.target).push(column);
        return res;
      }, new Map());

      grouppedColumns.forEach((columns, target) => {
        const dataStore = DataStores[target].create?.(columns);

        if (dataStore) registerModel(`${target}Store`, dataStore);
      });
    },

    startLabelStream(options = {}) {
      if (!self.confirmLabelingConfigured()) return;

      const nextAction = () => {
        self.SDK.setMode("labelstream");

        if (options?.pushState !== false) {
          History.navigate({ labeling: 1 });
        }
      };
      const runNextAction = () => {
        if (self.LSF?.isManagedRefinementProject && options.managedCoordinated !== true) {
          return self.LSF.coordinateManagedNavigation(nextAction, {
            intentKey: "start-label-stream",
            reason: "start-label-stream",
          });
        }

        return nextAction();
      };

      if (isFF(FF_DEV_2887) && self.LSF?.lsf?.annotationStore?.selected?.commentStore?.hasUnsaved) {
        Modal.confirm({
          title: "You have unsaved changes",
          body: "There are comments which are not persisted. Please submit the annotation. Continuing will discard these comments.",
          onOk() {
            runNextAction();
          },
          okText: "Discard and continue",
        });
        return;
      }

      return runNextAction();
    },

    startLabeling(item, options = {}) {
      if (!self.confirmLabelingConfigured()) return;

      if (self.dataStore.loadingItem) return;

      const nextAction = () => {
        self.SDK.setMode("labeling");

        if (item?.id && !item.isSelected) {
          const labelingParams = {
            pushState: options?.pushState,
            interface: options?.interface,
          };

          if (isDefined(item.task_id)) {
            Object.assign(labelingParams, {
              annotationID: item.id,
              taskID: item.task_id,
            });
          } else {
            Object.assign(labelingParams, {
              taskID: item.id,
            });
          }

          return self.setTask(labelingParams);
        }

        return self.closeLabeling({ managedCoordinated: true });
      };
      const runNextAction = () => {
        if (self.LSF?.isManagedRefinementProject && options.managedCoordinated !== true) {
          const taskId = item?.task_id ?? item?.id ?? "close";
          const annotationId = isDefined(item?.task_id) ? item.id : "auto";

          return self.LSF.coordinateManagedNavigation(nextAction, {
            intentKey: `row:${taskId}:annotation:${annotationId}`,
            reason: "row-click",
          });
        }

        return nextAction();
      };

      if (isFF(FF_DEV_2887) && self.LSF?.lsf?.annotationStore?.selected?.commentStore?.hasUnsaved) {
        Modal.confirm({
          title: "You have unsaved changes",
          body: "There are comments which are not persisted. Please submit the annotation. Continuing will discard these comments.",
          onOk() {
            runNextAction();
          },
          okText: "Discard and continue",
        });
        return;
      }

      return runNextAction();
    },

    confirmLabelingConfigured() {
      if (!self.labelingIsConfigured) {
        Modal.confirm({
          title: "You're almost there!",
          body: "Before you can annotate the data, set up labeling configuration",
          onOk() {
            self.SDK.invoke("settingsClicked");
          },
          okText: "Go to setup",
        });
        return false;
      }
      return true;
    },

    closeLabeling(options) {
      const { SDK } = self;

      if (self.LSF?.isManagedRefinementProject && options?.managedCoordinated !== true) {
        return self.LSF.coordinateManagedNavigation(
          () => self.closeLabeling({ ...options, managedCoordinated: true }),
          { intentKey: "close-labeling", reason: "close-labeling" },
        );
      }

      self.unsetTask(options);

      let viewId;
      const tabFromURL = History.getParams().tab;

      if (isDefined(self.currentView)) {
        viewId = self.currentView.tabKey;
      } else if (isDefined(tabFromURL)) {
        viewId = tabFromURL;
      } else if (isDefined(self.viewsStore)) {
        viewId = self.viewsStore.views[0]?.tabKey;
      }

      if (isDefined(viewId) && options?.preserveHistoryEntry !== true) {
        History.forceNavigate({ tab: viewId });
      }

      SDK.setMode("explorer");
      SDK.destroyLSF();
    },

    setManagedPopstateTransition(transition) {
      self.managedPopstateTransition = transition;
    },

    clearManagedPopstateTimer() {
      if (self.managedPopstateTimer !== null) {
        clearTimeout(self.managedPopstateTimer);
        self.managedPopstateTimer = null;
      }
    },

    takeManagedPopstateTransition() {
      const transition = self.managedPopstateTransition;

      self.clearManagedPopstateTimer();
      self.managedPopstateTransition = null;
      return transition;
    },

    cancelManagedPopstateTransition() {
      const transition = self.takeManagedPopstateTransition();

      if (!transition) return;
      transition.resolveReplay?.(false);
      transition.resolve?.(false);
    },

    failManagedPopstateTransition(transition) {
      if (self.managedPopstateTransition?.promise !== transition.promise) return false;

      const failedTransition = self.takeManagedPopstateTransition();

      self.quarantineManagedHistoryTraversal();
      if (failedTransition.phase === "replay-target") {
        failedTransition.resolveReplay(false);
      } else {
        failedTransition.resolve(false);
      }
      Modal.info({
        title: "Browser navigation was paused",
        body: "The previous page could not be restored safely. Your unsaved annotation is still open; save it before trying browser navigation again.",
      });
      return false;
    },

    coordinateManagedPopstateTransition(transition, sourceEntry, replayMethod = transition.replayMethod) {
      self.clearManagedPopstateTimer();
      self.setManagedHistoryCurrentEntry(sourceEntry);
      const coordinatingTransition = {
        ...transition,
        phase: "coordinating",
        replayMethod,
        sourceEntry,
      };

      self.setManagedPopstateTransition(coordinatingTransition);
      let navigation;

      try {
        navigation = self.LSF.coordinateManagedNavigation(
          () => {
            if (self.managedPopstateTransition?.promise !== transition.promise) return false;
            return new Promise((resolveReplay, rejectReplay) => {
              self.startManagedHistoryTraversal(
                {
                  ...coordinatingTransition,
                  phase: "replay-target",
                  rejectReplay,
                  resolveReplay,
                },
                replayMethod,
              );
            });
          },
          { intentKey: `popstate:${transition.targetEntry.href}`, reason: "popstate" },
        );
      } catch {
        self.failManagedPopstateTransition(coordinatingTransition);
        return transition.promise;
      }

      Promise.resolve(navigation)
        .then(transition.resolve, transition.reject)
        .finally(() => {
          if (self.managedPopstateTransition?.promise === transition.promise) {
            self.takeManagedPopstateTransition();
          }
        });
      return transition.promise;
    },

    handleManagedHistoryTraversalTimeout(expectedTransition) {
      const transition = self.managedPopstateTransition;

      if (
        transition?.promise !== expectedTransition.promise ||
        transition.phase !== expectedTransition.phase ||
        transition.recoveryStep !== expectedTransition.recoveryStep
      ) {
        return;
      }

      self.managedPopstateTimer = null;
      if (transition.phase === "restore-source" && historyEntryMatches(transition.sourceEntry)) {
        return self.coordinateManagedPopstateTransition(transition, transition.sourceEntry);
      }
      return self.failManagedPopstateTransition(transition);
    },

    startManagedHistoryTraversal(transition, method) {
      self.clearManagedPopstateTimer();
      self.setManagedPopstateTransition(transition);
      self.managedPopstateTimer = setTimeout(
        () => self.handleManagedHistoryTraversalTimeout(transition),
        MANAGED_HISTORY_TRAVERSAL_TIMEOUT_MS,
      );
      try {
        window.history[method]();
      } catch {
        self.failManagedPopstateTransition(transition);
      }
      return transition.promise;
    },

    handlePopState: (({ state }) => {
      const lsf = self.LSF;

      // Keep the upstream branch byte-for-byte in behavior for ordinary
      // projects. Managed replay must not make a null history state consult URL
      // parameters or change the native close/start routing semantics.
      if (!lsf?.isManagedRefinementProject) {
        const { tab, task, annotation, labeling, region } = state ?? {};

        if (tab) {
          const tabId = Number.parseInt(tab);

          self.viewsStore.setSelected(Number.isNaN(tabId) ? tab : tabId, {
            pushState: false,
            createDefault: false,
          });
        }

        if (task) {
          const params = {};

          if (annotation) {
            params.task_id = Number.parseInt(task);
            params.id = Number.parseInt(annotation);
          } else {
            params.id = Number.parseInt(task);
          }
          if (region) {
            params.region = region;
          } else {
            delete params.region;
          }

          self.startLabeling(params, { pushState: false });
        } else if (labeling) {
          self.startLabelStream({ pushState: false });
        } else {
          self.closeLabeling({ pushState: false });
        }
        return;
      }

      const targetHref = window.location.href;
      const targetState = state ?? null;
      const applyPopState = (resolvedState = targetState) => {
        const { tab, task, annotation, labeling, region } = resolvedState ?? {};

        if (tab) {
          const tabId = Number.parseInt(tab);

          self.viewsStore.setSelected(Number.isNaN(tabId) ? tab : tabId, {
            pushState: false,
            createDefault: false,
          });
        }

        if (task) {
          const params = {};

          if (annotation) {
            params.task_id = Number.parseInt(task);
            params.id = Number.parseInt(annotation);
          } else {
            params.id = Number.parseInt(task);
          }
          if (region) {
            params.region = region;
          } else {
            delete params.region;
          }

          return self.startLabeling(params, { pushState: false, managedCoordinated: true });
        }
        if (labeling) {
          return self.startLabelStream({ pushState: false, managedCoordinated: true });
        }
        return self.closeLabeling({
          pushState: false,
          managedCoordinated: true,
          preserveHistoryEntry: true,
        });
      };

      const navigationWasBlocked = lsf.requiresManagedNavigationSave();
      const transition = self.managedPopstateTransition;

      if (self.managedHistoryTraversalQuarantined) return false;

      if (transition?.phase === "restore-source") {
        self.clearManagedPopstateTimer();
        if (!historyEntryMatches(transition.sourceEntry, targetHref, targetState)) {
          return self.failManagedPopstateTransition(transition);
        }
        const sourceEntry = {
          browserIndex: managedHistoryBrowserIndex(),
          href: targetHref,
          position: transition.sourceEntry.position,
          state: targetState,
        };

        return self.coordinateManagedPopstateTransition(transition, sourceEntry);
      }

      if (transition?.phase === "replay-target") {
        self.clearManagedPopstateTimer();
        if (!historyEntryMatches(transition.targetEntry, targetHref, targetState)) {
          return self.failManagedPopstateTransition(transition);
        }
        self.takeManagedPopstateTransition();
        self.setManagedHistoryCurrentEntry(transition.targetEntry);
        try {
          const result = applyPopState(transition.targetEntry.state);

          Promise.resolve(result).then(transition.resolveReplay, transition.rejectReplay);
          return result;
        } catch (error) {
          transition.rejectReplay(error);
          throw error;
        }
      }

      if (transition) return transition.promise;
      const targetMarker = managedHistoryMarker(state, self.managedHistorySessionId);
      const targetPosition = targetMarker?.position ?? self.resolveManagedHistoryPosition(targetHref, targetState);
      const targetEntry = {
        browserIndex: managedHistoryBrowserIndex(),
        href: targetHref,
        position: targetPosition,
        state: targetState,
      };

      if (!navigationWasBlocked) {
        self.setManagedHistoryCurrentEntry(targetEntry);
        return applyPopState();
      }

      const sourceEntry = self.managedHistoryCurrentEntry;
      const positionsKnown = Number.isSafeInteger(sourceEntry?.position) && Number.isSafeInteger(targetEntry.position);
      const browserIndexesKnown =
        Number.isSafeInteger(sourceEntry?.browserIndex) && Number.isSafeInteger(targetEntry.browserIndex);

      let resolve;
      let reject;
      const promise = new Promise((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
      });

      const baseTransition = {
        promise,
        reject,
        resolve,
        sourceEntry,
        targetEntry,
      };

      let popDirection = null;

      if (positionsKnown && targetEntry.position !== sourceEntry.position) {
        popDirection = targetEntry.position > sourceEntry.position ? "forward" : "back";
      } else if (browserIndexesKnown && targetEntry.browserIndex !== sourceEntry.browserIndex) {
        popDirection = targetEntry.browserIndex > sourceEntry.browserIndex ? "forward" : "back";
      }
      if (!popDirection) {
        const unsupportedTransition = { ...baseTransition, phase: "unsupported-direction" };

        self.setManagedPopstateTransition(unsupportedTransition);
        self.failManagedPopstateTransition(unsupportedTransition);
        return promise;
      }
      const restoreMethod = popDirection === "forward" ? "back" : "forward";
      const replayMethod = popDirection === "forward" ? "forward" : "back";

      return self.startManagedHistoryTraversal(
        {
          ...baseTransition,
          phase: "restore-source",
          replayMethod,
          restoreMethod,
        },
        restoreMethod,
      );
    }).bind(self),

    resolveURLParams() {
      self.installManagedHistoryTracking();
      window.addEventListener("popstate", self.handlePopState);
    },

    setLoading(value) {
      self.loading = value;
    },

    fetchProject: flow(function* (options = {}) {
      self.projectFetch = options.force === true;

      const isTimer = options.interaction === "timer";
      const params =
        options && options.interaction
          ? {
              interaction: options.interaction,
              ...(isTimer
                ? {
                    include: [
                      "task_count",
                      "task_number",
                      "annotation_count",
                      "num_tasks_with_annotations",
                      "queue_total",
                    ].join(","),
                  }
                : null),
            }
          : null;

      try {
        const newProject = yield self.apiCall("project", params);
        const hasExistingProjectData = Object.entries(self.project ?? {}).length > 0;
        const hasNewProjectData = Object.entries(newProject ?? {}).length > 0;

        self.needsDataFetch =
          options.force !== true && hasExistingProjectData && hasNewProjectData
            ? self.project.task_count !== newProject.task_count ||
              self.project.task_number !== newProject.task_number ||
              self.project.annotation_count !== newProject.annotation_count ||
              self.project.num_tasks_with_annotations !== newProject.num_tasks_with_annotations
            : false;

        if (options.interaction === "timer") {
          self.project = Object.assign(self.project ?? {}, newProject ?? {});
        } else if (JSON.stringify(newProject ?? {}) !== JSON.stringify(self.project ?? {})) {
          self.project = newProject;
        }
        if (isFF(FF_LOPS_E_3)) {
          const itemType = self.SDK.type === "DE" ? "dataset" : "project";

          self.SDK.invoke(`${itemType}Updated`, self.project);
        }
      } catch {
        // When in timer (polling project counts) mode, we can still continue
        // but we need to crash for non-polling interactions
        // because we can't display the app without the project itself and will need to redirect
        if (options.interaction !== "timer") {
          self.crash({
            error: `Project ID: ${self.SDK.projectId} does not exist or is no longer available`,
            redirect: true,
          });
        }
        return false;
      }
      self.projectFetch = false;
      return true;
    }),

    /**
     * @deprecated Use the useActions hook instead for better caching and performance
     * This method is kept for backward compatibility but is no longer actively used
     */
    fetchActions: flow(function* () {
      try {
        const serverActions = yield self.apiCall("actions");

        const actions = (serverActions ?? []).map((action) => {
          return [action, undefined];
        });

        self.SDK.updateActions(actions);
      } catch (error) {
        console.error("Error fetching actions:", error);
      }
    }),

    fetchActionForm: flow(function* (actionId) {
      const form = yield self.apiCall("actionForm", { actionId });
      return form;
    }),

    fetchUsers: flow(function* () {
      const list = yield self.apiCall("users", {
        __useQueryCache: {
          prefixKey: "organizationMembers",
          staleTime: 60 * 1000,
        },
      });

      self.users.push(...list);
    }),

    fetchData: flow(function* ({ isLabelStream } = {}) {
      self.setLoading(true);

      const { tab, task, labeling, query } = History.getParams();

      self.viewsStore.fetchColumns();

      const requests = [self.fetchProject()];

      // Only fetch all users if not disabled globally
      if (!isFF(FF_DISABLE_GLOBAL_USER_FETCHING)) {
        requests.push(self.fetchUsers());
      }

      if (!isLabelStream || (self.project?.show_annotation_history && task)) {
        if (self.SDK.settings?.onlyVirtualTabs && self.project?.show_annotation_history && !task) {
          requests.push(
            self.viewsStore.addView(
              {
                virtual: true,
                projectId: self.SDK.projectId,
                tab,
              },
              { autosave: false, reload: false },
            ),
          );
        } else if (self.SDK.type === "labelops") {
          requests.push(
            self.viewsStore.addView(
              {
                virtual: false,
                projectId: self.SDK.projectId,
                tab,
              },
              { autosave: false, autoSelect: true, reload: true },
            ),
          );
        } else {
          requests.push(self.viewsStore.fetchTabs(tab, task, labeling));
        }
      } else if (isLabelStream && !!tab) {
        const { selectedItems } = JSON.parse(decodeURIComponent(query ?? "{}"));

        requests.push(self.viewsStore.fetchSingleTab(tab, selectedItems ?? {}));
      }

      const [projectFetched] = yield Promise.all(requests);

      if (projectFetched) {
        self.resolveURLParams();

        self.setLoading(false);

        self.startPolling();
      }
    }),

    /**
     * Main API calls provider for the whole application.
     * `params` are used both for var substitution and query params if var is unknown:
     * `{ project: 123, order: "desc" }` for method `"tasks": "/project/:pk/tasks"`
     * will produce `/project/123/tasks?order=desc` url
     * @param {string} methodName one of the methods in api-config
     * @param {object} params url vars and query string params
     * @param {object} body for POST/PATCH requests
     * @param {{ errorHandler?: fn, headers?: object, allowToCancel?: boolean }} [options] additional options like errorHandler
     */
    apiCall: flow(function* (methodName, params, body, options) {
      const isAllowCancel = options?.allowToCancel;
      const controller = new AbortController();
      const signal = controller.signal;
      const apiTransform = self.SDK.apiTransform?.[methodName];
      const requestParams = apiTransform?.params?.(params) ?? params ?? {};
      const requestBody = apiTransform?.body?.(body) ?? body ?? {};
      const requestHeaders = apiTransform?.headers?.(options?.headers) ?? options?.headers ?? {};
      const requestKey = `${methodName}_${JSON.stringify(params || {})}`;

      if (isAllowCancel) {
        requestHeaders.signal = signal;
        if (self.requestsInFlight.has(requestKey)) {
          /* if already in flight cancel the first in favor of new one */
          self.requestsInFlight.get(requestKey).abort();
          console.log(`Request ${requestKey} canceled`);
        }
        self.requestsInFlight.set(requestKey, controller);
      }
      const result = yield self.API[methodName](requestParams, {
        headers: requestHeaders,
        body: requestBody.body ?? requestBody,
        options,
      });

      if (isAllowCancel) {
        result.isCanceled = signal.aborted;
        self.requestsInFlight.delete(requestKey);
      }
      // We don't want to show errors when loading data in polling mode
      // we will just allow it to try again later
      const resultStatusCode =
        result?.status ?? result?.$meta?.status ?? result?.response?.status ?? result?.response?.status_code;
      if (result.error && resultStatusCode !== 404 && !signal.aborted && params.interaction !== "timer") {
        if (options?.errorHandler?.(result)) {
          return result;
        }

        if (result.response) {
          try {
            self.serverError.set(methodName, {
              error: "Something went wrong",
              response: result.response,
            });
          } catch {
            // ignore
          }
        }

        console.warn({
          message: "Error occurred when loading data",
          description: result?.response?.detail ?? result.error,
        });

        self.SDK.invoke("error", result);

        // notification.error({
        //   message: "Error occurred when loading data",
        //   description: result?.response?.detail ?? result.error,
        // });
      } else {
        try {
          self.serverError.delete(methodName);
        } catch {
          // ignore
        }
      }

      return result;
    }),

    invokeAction: flow(function* (actionId, options = {}) {
      const view = self.currentView ?? {};
      const viewReloaded = view;
      let projectFetched = self.project;

      const needsLock = self.availableActions.findIndex((a) => a.id === actionId) >= 0;

      const { selected } = view;
      const actionCallback = self.SDK.getAction(actionId);

      if (view && needsLock && !actionCallback) view.lock();

      const labelStreamMode = localStorage.getItem("dm:labelstream:mode");

      // @todo this is dirty way to sync across nested apps
      // don't apply filters for "all" on "next_task"
      const actionParams = {
        ordering: view.ordering,
        selectedItems: selected?.snapshot ?? { all: false, included: [] },
        filters: {
          conjunction: view.conjunction ?? "and",
          items: view.serializedFilters ?? [],
        },
      };

      if (actionId === "next_task") {
        const isSelectAll = actionParams.selectedItems.all === true;
        const isAllLabelStreamMode = labelStreamMode === "all";
        const isFilteredLabelStreamMode = labelStreamMode === "filtered";
        if (isAllLabelStreamMode && !isSelectAll) {
          delete actionParams.filters;

          if (actionParams.selectedItems.all === false && actionParams.selectedItems.included.length === 0) {
            delete actionParams.selectedItems;
            delete actionParams.ordering;
          }
        } else if (isFilteredLabelStreamMode) {
          delete actionParams.selectedItems;
        }
      }

      if (actionCallback instanceof Function) {
        const result = actionCallback(actionParams, view);
        self.SDK.invoke("actionDialogOkComplete", actionId, {
          result,
          view: viewReloaded,
          project: projectFetched,
        });
        return result;
      }

      const requestParams = {
        id: actionId,
      };

      if (isDefined(view.id) && !view?.virtual) {
        requestParams.tabID = view.id;
      }

      if (options.body) {
        Object.assign(actionParams, options.body);
      }

      const result = yield self.apiCall("invokeAction", requestParams, {
        body: actionParams,
      });

      if (result.async) {
        self.SDK.invoke("toast", { message: "Your action is being processed in the background.", type: "info" });
      }

      if (result.reload) {
        self.SDK.reload();
        self.SDK.invoke("actionDialogOkComplete", actionId, {
          result,
          view: viewReloaded,
          project: projectFetched,
        });
        return;
      }

      if (options.reload !== false) {
        yield view.reload();
        yield self.fetchProject();
        projectFetched = self.project;
        view.clearSelection();
      }

      view?.unlock?.();

      self.SDK.invoke("actionDialogOkComplete", actionId, {
        result,
        view: viewReloaded,
        project: projectFetched,
      });
      return result;
    }),

    crash(options = {}) {
      if (options.redirect !== true) {
        self.destroy();
        self.crashed = true;
      }
      self.SDK.invoke("crash", options);
    },

    destroy() {
      if (self.taskStore) {
        self.taskStore?.clear();
        self.taskStore = undefined;
      }

      if (self.annotationStore) {
        self.annotationStore?.clear();
        self.annotationStore = undefined;
      }

      clearTimeout(self._poll);
    },
  }));
