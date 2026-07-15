import { observer } from "mobx-react";
import { cast, getRoot, types } from "mobx-state-tree";
import { useId, useMemo, useRef, useState } from "react";

import { defaultStyle } from "../../../core/Constants";
import { customTypes } from "../../../core/CustomTypes";
import { guidGenerator } from "../../../core/Helpers";
import Registry from "../../../core/Registry";
import Tree from "../../../core/Tree";
import Types from "../../../core/Types";
import { AnnotationMixin } from "../../../mixins/AnnotationMixin";
import DynamicChildrenMixin from "../../../mixins/DynamicChildrenMixin";
import LabelMixin from "../../../mixins/LabelMixin";
import SelectedModelMixin from "../../../mixins/SelectedModel";
import { cn } from "../../../utils/bem";
import ControlBase from "../Base";
import "../Label";
import "./Labels.prefix.css";

/**
 * Frozen in the official COCO category order.  This is intentionally a list of
 * canonical English values rather than aliases or the evaluator's contiguous
 * category IDs.  The managed quick search is enabled only when the actual
 * Label children match this entire registry exactly.
 */
const COCO80_CANONICAL_NAMES = Object.freeze([
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "airplane",
  "bus",
  "train",
  "truck",
  "boat",
  "traffic light",
  "fire hydrant",
  "stop sign",
  "parking meter",
  "bench",
  "bird",
  "cat",
  "dog",
  "horse",
  "sheep",
  "cow",
  "elephant",
  "bear",
  "zebra",
  "giraffe",
  "backpack",
  "umbrella",
  "handbag",
  "tie",
  "suitcase",
  "frisbee",
  "skis",
  "snowboard",
  "sports ball",
  "kite",
  "baseball bat",
  "baseball glove",
  "skateboard",
  "surfboard",
  "tennis racket",
  "bottle",
  "wine glass",
  "cup",
  "fork",
  "knife",
  "spoon",
  "bowl",
  "banana",
  "apple",
  "sandwich",
  "orange",
  "broccoli",
  "carrot",
  "hot dog",
  "pizza",
  "donut",
  "cake",
  "chair",
  "couch",
  "potted plant",
  "bed",
  "dining table",
  "toilet",
  "tv",
  "laptop",
  "mouse",
  "remote",
  "keyboard",
  "cell phone",
  "microwave",
  "oven",
  "toaster",
  "sink",
  "refrigerator",
  "book",
  "clock",
  "vase",
  "scissors",
  "teddy bear",
  "hair drier",
  "toothbrush",
]);

const SEARCH_RESULT_LIMIT = 8;
const COCO80_LABEL_COLORS = Object.freeze([
  "#4C78A8",
  "#F58518",
  "#54A24B",
  "#E45756",
  "#72B7B2",
  "#B279A2",
  "#FF9DA6",
  "#9D755D",
  "#BAB0AC",
  "#5F9ED1",
]);
const MANAGED_TASK_DATA_FIELDS = Object.freeze(["coordexp_task_key", "image", "image_id", "source_line", "split"]);
const MANAGED_IMAGE_ATTRIBUTES = Object.freeze({
  name: "image",
  value: "$image",
  zoom: "true",
  zoomControl: "true",
  rotateControl: "false",
});
const MANAGED_RECTANGLE_LABELS_ATTRIBUTES = Object.freeze({
  name: "bbox",
  toName: "image",
  canRotate: "false",
});

let lastManagedConfigXml = null;
let lastManagedConfigResult = false;

const normalizeClassSearchText = (value) => {
  return typeof value === "string" ? value.toLocaleLowerCase("en-US").trim().replace(/\s+/g, " ") : "";
};

const boundedLevenshteinDistance = (left, right, limit) => {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  if (left.length > right.length) return boundedLevenshteinDistance(right, left, limit);

  let previous = Array.from({ length: left.length + 1 }, (_, index) => index);

  for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
    const current = [rightIndex];

    for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
      current.push(
        Math.min(
          current[current.length - 1] + 1,
          previous[leftIndex] + 1,
          previous[leftIndex - 1] + Number(left[leftIndex - 1] !== right[rightIndex - 1]),
        ),
      );
    }
    previous = current;
  }
  return previous[previous.length - 1];
};

const commonPrefixLength = (left, right) => {
  const limit = Math.min(left.length, right.length);

  for (let index = 0; index < limit; index++) {
    if (left[index] !== right[index]) return index;
  }
  return limit;
};

const spellingScore = (query, candidate, threshold) => {
  const queryWords = query.split(" ");
  const candidateWords = candidate.split(" ");
  const comparisons = [candidate];

  if (queryWords.length <= candidateWords.length) {
    for (let index = 0; index <= candidateWords.length - queryWords.length; index++) {
      comparisons.push(candidateWords.slice(index, index + queryWords.length).join(" "));
    }
  }

  return comparisons.reduce(
    (best, value) => {
      const score = [boundedLevenshteinDistance(query, value, threshold), -commonPrefixLength(query, value)];

      return score[0] < best[0] || (score[0] === best[0] && score[1] < best[1]) ? score : best;
    },
    [Number.POSITIVE_INFINITY, 0],
  );
};

const spellingThreshold = (query) => {
  const compactLength = query.replace(/ /g, "").length;

  return compactLength === 0 ? 0 : Math.min(3, Math.max(1, Math.ceil(compactLength / 3)));
};

/**
 * Return only canonical registry entries. Ranking is kept byte-for-byte
 * deterministic by using the frozen registry index as the final tie breaker.
 */
const searchCanonicalCoco80 = (rawQuery, limit = SEARCH_RESULT_LIMIT) => {
  const query = normalizeClassSearchText(rawQuery);

  if (!query) return [];

  const threshold = spellingThreshold(query);
  const matches = [];

  COCO80_CANONICAL_NAMES.forEach((canonicalName, registryIndex) => {
    let priority;
    let matchKind;
    let distance = 0;
    let negativePrefix = 0;

    if (canonicalName === query) {
      priority = 0;
      matchKind = "exact";
    } else if (canonicalName.startsWith(query)) {
      priority = 1;
      matchKind = "prefix";
    } else if (canonicalName.includes(query)) {
      priority = 2;
      matchKind = "substring";
    } else {
      [distance, negativePrefix] = spellingScore(query, canonicalName, threshold);
      if (distance > threshold) return;
      priority = 3;
      matchKind = "spelling";
    }

    matches.push({ canonicalName, registryIndex, priority, distance, negativePrefix, matchKind });
  });

  matches.sort((left, right) => {
    return (
      left.priority - right.priority ||
      left.distance - right.distance ||
      left.negativePrefix - right.negativePrefix ||
      left.registryIndex - right.registryIndex
    );
  });

  return matches.slice(0, limit).map(({ canonicalName, registryIndex, matchKind, distance }) => ({
    canonicalName,
    registryIndex,
    matchKind,
    spellingDistance: matchKind === "spelling" ? distance : null,
  }));
};

const managedTaskIdentity = (taskData) => {
  if (!taskData || typeof taskData !== "object" || Array.isArray(taskData)) return null;
  const fields = Object.keys(taskData).sort();

  if (
    fields.length !== MANAGED_TASK_DATA_FIELDS.length ||
    fields.some((field, index) => field !== MANAGED_TASK_DATA_FIELDS[index])
  ) {
    return null;
  }

  const { coordexp_task_key: taskKey, split, image_id: imageId, source_line: sourceLine, image } = taskData;
  if (split !== "train" && split !== "val") return null;
  if (!Number.isInteger(imageId) || imageId < 0) return null;
  if (!Number.isInteger(sourceLine) || sourceLine < 1) return null;
  if (taskKey !== `${split}:${imageId}`) return null;

  const expectedImage = `/data/local-files/?d=${split}2017/${String(imageId).padStart(12, "0")}.jpg`;

  if (image !== expectedImage) return null;
  return `${taskKey}:${sourceLine}`;
};

const hasExactAttributes = (element, expected) => {
  const attributes = Array.from(element?.attributes ?? []);
  const expectedEntries = Object.entries(expected);

  return (
    attributes.length === expectedEntries.length &&
    expectedEntries.every(([name, value]) => element.getAttribute(name) === value)
  );
};

const hasOnlyExpectedMarkup = (element) => {
  return Array.from(element?.childNodes ?? []).every((node) => {
    return node.nodeType === 1 || (node.nodeType === 3 && !node.textContent?.trim());
  });
};

/**
 * Attest the original XML rather than mutable Label model state. Label Studio
 * assigns `hotkey` at runtime and changes `selected` during normal labeling,
 * so their current values cannot distinguish configured attributes from user
 * interaction. The generated XML is immutable in the root AppStore and keeps
 * that distinction exact.
 */
const isManagedCoco80StaticConfig = (configXml) => {
  if (configXml === lastManagedConfigXml) return lastManagedConfigResult;

  lastManagedConfigXml = configXml;
  lastManagedConfigResult = false;
  if (typeof configXml !== "string" || typeof DOMParser === "undefined") return false;

  try {
    const document = new DOMParser().parseFromString(configXml, "application/xml");

    if (document.getElementsByTagName("parsererror").length) return false;

    const view = document.documentElement;
    const viewChildren = Array.from(view?.children ?? []);

    if (
      view?.tagName !== "View" ||
      !hasExactAttributes(view, {}) ||
      !hasOnlyExpectedMarkup(view) ||
      viewChildren.length !== 2 ||
      viewChildren[0].tagName !== "Image" ||
      viewChildren[1].tagName !== "RectangleLabels"
    ) {
      return false;
    }

    const [image, rectangleLabels] = viewChildren;
    const labels = Array.from(rectangleLabels.children ?? []);

    if (
      !hasExactAttributes(image, MANAGED_IMAGE_ATTRIBUTES) ||
      !hasOnlyExpectedMarkup(image) ||
      image.children.length !== 0 ||
      !hasExactAttributes(rectangleLabels, MANAGED_RECTANGLE_LABELS_ATTRIBUTES) ||
      !hasOnlyExpectedMarkup(rectangleLabels) ||
      labels.length !== COCO80_CANONICAL_NAMES.length
    ) {
      return false;
    }

    lastManagedConfigResult = labels.every((label, index) => {
      return (
        label.tagName === "Label" &&
        hasExactAttributes(label, {
          value: COCO80_CANONICAL_NAMES[index],
          background: COCO80_LABEL_COLORS[index % COCO80_LABEL_COLORS.length],
        }) &&
        hasOnlyExpectedMarkup(label) &&
        label.children.length === 0
      );
    });
  } catch {
    lastManagedConfigResult = false;
  }

  return lastManagedConfigResult;
};

const taskDataForControl = (item) => {
  const directlyAttachedTaskData = item?.store?.task?.dataObj;

  if (directlyAttachedTaskData) return directlyAttachedTaskData;
  try {
    return getRoot(item)?.task?.dataObj ?? null;
  } catch {
    return null;
  }
};

const configForControl = (item) => {
  const directlyAttachedConfig = item?.store?.config;

  if (typeof directlyAttachedConfig === "string") return directlyAttachedConfig;
  try {
    const rootConfig = getRoot(item)?.config;

    return typeof rootConfig === "string" ? rootConfig : null;
  } catch {
    return null;
  }
};

const isManagedCoco80Control = (item, taskData = taskDataForControl(item), configXml = configForControl(item)) => {
  if (
    item?.type !== "rectanglelabels" ||
    item?.name !== "bbox" ||
    item?.toname !== "image" ||
    item?.canrotate !== false ||
    item?.choice !== "single" ||
    item?.maxusages != null ||
    item?.showinline !== true ||
    item?.groupdepth != null ||
    item?.opacity !== "0.2" ||
    item?.fillcolor !== "#f48a42" ||
    item?.strokewidth !== "1" ||
    item?.strokecolor !== "#f48a42" ||
    item?.fillopacity != null ||
    item?.allowempty !== false ||
    item?.value !== "" ||
    item?.resolver != null ||
    item?.snap !== "none" ||
    item?.smart !== true ||
    item?.smartonly !== false ||
    item?.isControlTag !== true ||
    item?.visible !== true ||
    !isManagedCoco80StaticConfig(configXml) ||
    !managedTaskIdentity(taskData) ||
    !Array.isArray(item?.children) ||
    item.children.length !== COCO80_CANONICAL_NAMES.length
  ) {
    return false;
  }

  return item.children.every((label, index) => {
    const canonicalName = COCO80_CANONICAL_NAMES[index];

    return (
      label?.type === "label" &&
      label?.value === canonicalName &&
      label?._value === canonicalName &&
      label?.background === COCO80_LABEL_COLORS[index % COCO80_LABEL_COLORS.length] &&
      label?.initiallySelected === false &&
      label?.visible === true &&
      label?.isEmpty === false &&
      label?.resolver == null &&
      label?.alias == null &&
      label?.showalias === false &&
      label?.html == null &&
      label?.hint == null &&
      label?.maxusages == null &&
      label?.size === "medium" &&
      label?.selectedcolor === "#ffffff" &&
      label?.aliasstyle === "opacity: 0.6" &&
      label?.granularity == null &&
      label?.groupcancontain == null
    );
  });
};

/**
 * The `Labels` tag provides a set of labels for labeling regions in tasks for machine learning and data science projects. Use the `Labels` tag to create a set of labels that can be assigned to identified region and specify the values of labels to assign to regions.
 *
 * All types of Labels can have dynamic value to load labels from task. This task data should contain a list of options to create underlying `<Label>`s. All the parameters from options will be transferred to corresponding tags.
 *
 * The Labels tag can be used with audio and text data types. Other data types have type-specific Labels tags.
 * @example
 * <!--Basic labeling configuration to apply labels to a passage of text -->
 * <View>
 *   <Labels name="type" toName="txt-1">
 *     <Label alias="B" value="Brand" />
 *     <Label alias="P" value="Product" />
 *   </Labels>
 *   <Text name="txt-1" value="$text" />
 * </View>
 *
 * @example <caption>This part of config with dynamic labels</caption>
 * <Labels name="product" toName="shelf" value="$brands" />
 * <!-- {
 *   "data": {
 *     "brands": [
 *       { "value": "Big brand" },
 *       { "value": "Another brand", "background": "orange" },
 *       { "value": "Local brand" },
 *       { "value": "Green brand", "alias": "Eco", showalias: true }
 *     ]
 *   }
 * } -->
 * @example <caption>is equivalent to this config</caption>
 * <Labels name="product" toName="shelf">
 *   <Label value="Big brand" />
 *   <Label value="Another brand" background="orange" />
 *   <Label value="Local brand" />
 *   <Label value="Green brand" alias="Eco" showAlias="true" />
 * </Labels>
 * @name Labels
 * @meta_title Labels Tag for Labeling Regions
 * @meta_description Customize Label Studio by using the Labels tag to provide a set of labels for labeling regions in tasks for machine learning and data science projects.
 * @param {string} name                      - Name of the element
 * @param {string} toName                    - Name of the element that you want to label
 * @param {single|multiple=} [choice=single] - Configure whether you can select one or multiple labels for a region
 * @param {number} [maxUsages]               - Maximum number of times a label can be used per task
 * @param {boolean} [showInline=true]        - Whether to show labels in the same visual line
 * @param {float=} [opacity=0.6]             - Opacity of rectangle highlighting the label
 * @param {string=} [fillColor]              - Rectangle fill color in hexadecimal
 * @param {string=} [strokeColor=#f48a42]    - Stroke color in hexadecimal
 * @param {number=} [strokeWidth=1]          - Width of the stroke
 * @param {string} [value]                   - Task data field containing a list of dynamically loaded labels (see example below)
 */
const TagAttrs = types.model({
  toname: types.maybeNull(types.string),

  choice: types.optional(types.enumeration(["single", "multiple"]), "single"),
  maxusages: types.maybeNull(types.string),
  showinline: types.optional(types.boolean, true),

  // TODO this will move away from here
  groupdepth: types.maybeNull(types.string),

  opacity: types.optional(customTypes.range(), "0.2"),
  fillcolor: types.optional(customTypes.color, "#f48a42"),

  strokewidth: types.optional(types.string, "1"),
  strokecolor: types.optional(customTypes.color, "#f48a42"),
  fillopacity: types.maybeNull(customTypes.range()),
  allowempty: types.optional(types.boolean, false),

  value: types.optional(types.string, ""),
});

/**
 * @param {boolean} showinline
 * @param {identifier} id
 * @param {string} pid
 */
const ModelAttrs = types.model({
  pid: types.optional(types.string, guidGenerator),
  type: "labels",
  children: Types.unionArray(["label", "header", "view", "text", "hypertext", "richtext"]),

  visible: types.optional(types.boolean, true),
});

const Model = LabelMixin.views((self) => ({
  get shouldBeUnselected() {
    return self.choice === "single";
  },
  get defaultChildType() {
    return "label";
  },
  get isLabeling() {
    return true;
  },
})).actions((self) => ({
  afterCreate() {
    if (self.allowempty) {
      let empty = self.findLabel(null);

      if (!empty) {
        const emptyParams = {
          value: null,
          type: "label",
          background: defaultStyle.fillcolor,
        };

        if (self.children) {
          self.children.unshift(emptyParams);
        } else {
          self.children = cast([emptyParams]);
        }
        empty = self.children[0];
      }
      empty.setEmpty();
    }
  },
}));

const LabelsModel = types.compose(
  "LabelsModel",
  ControlBase,
  ModelAttrs,
  TagAttrs,
  AnnotationMixin,
  DynamicChildrenMixin,
  Model,
  SelectedModelMixin.props({ _child: "LabelModel" }),
);

const ManagedCocoClassSearch = ({ labels }) => {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const listboxId = useId();
  const results = useMemo(() => searchCanonicalCoco80(query), [query]);
  const activeResult = results[activeIndex] ?? results[0] ?? null;

  const chooseResult = (result) => {
    const label = result ? labels[result.registryIndex] : null;

    if (!label || label.value !== result.canonicalName || typeof label.toggleSelected !== "function") return;
    label.toggleSelected();
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      setActiveIndex(0);
      return;
    }
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex((current) => (current + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex((current) => (current - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      chooseResult(activeResult);
    }
  };

  const inputClass = cn("labels").elem("coco-search-input").toClassName();
  const listClass = cn("labels").elem("coco-search-results").toClassName();

  return (
    <div className={cn("labels").elem("coco-search").toClassName()} data-testid="coco-class-search">
      <input
        ref={inputRef}
        className={inputClass}
        type="text"
        value={query}
        placeholder="Search COCO class"
        aria-label="Search COCO class"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={results.length > 0}
        aria-controls={results.length ? listboxId : undefined}
        aria-activedescendant={activeResult ? `${listboxId}-${activeResult.registryIndex}` : undefined}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setQuery("");
          setActiveIndex(0);
        }}
      />
      {results.length > 0 && (
        <div id={listboxId} className={listClass} role="listbox" aria-label="COCO class matches">
          {results.map((result, index) => (
            <button
              id={`${listboxId}-${result.registryIndex}`}
              key={result.canonicalName}
              className={cn("labels")
                .elem("coco-search-result")
                .mod({ active: index === activeIndex })
                .toClassName()}
              type="button"
              tabIndex={-1}
              role="option"
              aria-selected={index === activeIndex}
              data-match-kind={result.matchKind}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseResult(result)}
            >
              {result.canonicalName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const HtxLabels = observer(({ item }) => {
  const taskData = taskDataForControl(item);
  const taskIdentity = managedTaskIdentity(taskData);
  const showCocoSearch = taskIdentity && isManagedCoco80Control(item, taskData);

  return (
    <div className={cn("labels").mod({ hidden: !item.visible, inline: item.showinline }).toClassName()}>
      {showCocoSearch && <ManagedCocoClassSearch key={taskIdentity} labels={item.children} />}
      {Tree.renderChildren(item, item.annotation)}
    </div>
  );
});

Registry.addTag("labels", LabelsModel, HtxLabels);

export {
  COCO80_CANONICAL_NAMES,
  HtxLabels,
  LabelsModel,
  ManagedCocoClassSearch,
  isManagedCoco80Control,
  isManagedCoco80StaticConfig,
  managedTaskIdentity,
  normalizeClassSearchText,
  searchCanonicalCoco80,
};
