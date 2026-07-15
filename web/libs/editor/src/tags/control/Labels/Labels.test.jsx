import { createHash } from "node:crypto";
import { imageCache } from "@humansignal/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("keymaster", () => {
  const keymaster = () => {};

  keymaster.unbind = () => {};
  keymaster.setScope = () => {};
  return { __esModule: true, default: keymaster };
});

jest.mock("../../../utils/FileLoader", () => ({
  FileLoader: jest.fn().mockImplementation(() => ({
    download: jest.fn(() => Promise.resolve("data:image/png;base64,")),
    isError: jest.fn(() => false),
    isPreloaded: jest.fn(() => false),
    getPreloadedURL: jest.fn(),
  })),
}));

import Tree from "../../../core/Tree";
import "../../object/Image";
import "../../visual/View";
import "../RectangleLabels";
import AppStore from "../../../stores/AppStore";

import {
  COCO80_CANONICAL_NAMES,
  HtxLabels,
  isManagedCoco80Control,
  isManagedCoco80StaticConfig,
  managedTaskIdentity,
  normalizeClassSearchText,
  searchCanonicalCoco80,
} from "./Labels";

jest.spyOn(Tree, "renderChildren").mockImplementation(() => "native label buttons");
const imageCacheGetSpy = jest
  .spyOn(imageCache, "get")
  .mockReturnValue({ blobUrl: "data:image/png;base64,", refCount: 1 });

afterAll(() => imageCacheGetSpy.mockRestore());

const managedTaskData = (overrides = {}) => ({
  image: "/data/local-files/?d=train2017/000000000139.jpg",
  coordexp_task_key: "train:139",
  split: "train",
  image_id: 139,
  source_line: 7,
  ...overrides,
});

const labelColors = [
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
];

const attributesToXml = (attributes) => {
  return Object.entries(attributes)
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
};

const managedLabelConfig = ({ rectangleAttributes = {}, firstLabelAttributes = {} } = {}) => {
  const rectangle = {
    name: "bbox",
    toName: "image",
    canRotate: "false",
    ...rectangleAttributes,
  };
  const labels = COCO80_CANONICAL_NAMES.map((value, index) => {
    const attributes = {
      value,
      background: labelColors[index % labelColors.length],
      ...(index === 0 ? firstLabelAttributes : {}),
    };

    return `    <Label ${attributesToXml(attributes)}/>`;
  }).join("\n");

  return [
    "<View>",
    '  <Image name="image" value="$image" zoom="true" zoomControl="true" rotateControl="false"/>',
    `  <RectangleLabels ${attributesToXml(rectangle)}>`,
    labels,
    "  </RectangleLabels>",
    "</View>",
    "",
  ].join("\n");
};

const createTestEnv = () => ({
  events: {
    hasEvent: jest.fn(() => false),
    invoke: jest.fn(),
    invokeFirst: jest.fn(),
  },
  messages: {},
  settings: {},
  forceAutoAnnotation: false,
  forceAutoAcceptSuggestions: false,
});

const realManagedRectangleItem = ({
  taskData = managedTaskData(),
  config = managedLabelConfig(),
  annotations = [],
} = {}) => {
  const store = AppStore.create(
    {
      config,
      task: { id: 1, data: JSON.stringify(taskData) },
      interfaces: ["basic"],
    },
    createTestEnv(),
  );

  store.initializeStore({ annotations });

  return store.annotationStore.root.children.find((child) => child.type === "rectanglelabels");
};

const managedItem = ({ taskData = managedTaskData(), item = {}, onToggle } = {}) => {
  const config = managedLabelConfig();
  const children = COCO80_CANONICAL_NAMES.map((value, index) => ({
    type: "label",
    value,
    _value: value,
    background: labelColors[index % labelColors.length],
    selected: false,
    initiallySelected: false,
    hotkey: null,
    visible: true,
    isEmpty: false,
    resolver: null,
    alias: null,
    showalias: false,
    html: null,
    hint: null,
    maxusages: null,
    size: "medium",
    selectedcolor: "#ffffff",
    aliasstyle: "opacity: 0.6",
    granularity: null,
    groupcancontain: null,
    toggleSelected: jest.fn(() => onToggle?.(value)),
  }));

  return {
    type: "rectanglelabels",
    name: "bbox",
    toname: "image",
    canrotate: false,
    choice: "single",
    maxusages: null,
    value: "",
    visible: true,
    showinline: true,
    groupdepth: null,
    opacity: "0.2",
    fillcolor: "#f48a42",
    strokewidth: "1",
    strokecolor: "#f48a42",
    fillopacity: null,
    allowempty: false,
    resolver: null,
    snap: "none",
    smart: true,
    smartonly: false,
    isControlTag: true,
    annotation: {},
    store: { config, task: { dataObj: taskData } },
    children,
    ...item,
  };
};

describe("managed COCO-80 class search policy", () => {
  it("freezes the official canonical order and matches the parent golden rankings", () => {
    expect(COCO80_CANONICAL_NAMES).toHaveLength(80);
    expect(createHash("sha256").update(JSON.stringify(COCO80_CANONICAL_NAMES)).digest("hex")).toBe(
      "a2bb9c8218affdef450cc85951e6a5abc5e4d956cd37b1be3d04840ae0120c8e",
    );
    expect(COCO80_CANONICAL_NAMES.slice(0, 12)).toEqual([
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
    ]);
    expect(COCO80_CANONICAL_NAMES.slice(-5)).toEqual(["vase", "scissors", "teddy bear", "hair drier", "toothbrush"]);
    expect(normalizeClassSearchText("  TRAFFIC   light ")).toBe("traffic light");
    expect(searchCanonicalCoco80("car", 5).map(({ canonicalName, matchKind }) => [canonicalName, matchKind])).toEqual([
      ["car", "exact"],
      ["carrot", "prefix"],
      ["cat", "spelling"],
    ]);
    expect(searchCanonicalCoco80("board", 4).map((result) => result.canonicalName)).toEqual([
      "snowboard",
      "skateboard",
      "surfboard",
      "keyboard",
    ]);
    expect(searchCanonicalCoco80("trafik", 2).map((result) => result.canonicalName)).toEqual([
      "traffic light",
      "train",
    ]);
    expect(searchCanonicalCoco80("trafic light", 3).map((result) => result.canonicalName)).toEqual(["traffic light"]);
  });

  it("requires the fixed control, exact task identity semantics, and exact 80-label registry", () => {
    const item = managedItem();
    const missingSourceLine = managedTaskData();

    delete missingSourceLine.source_line;

    expect(managedTaskIdentity(item.store.task.dataObj)).toBe("train:139:7");
    expect(managedTaskIdentity(missingSourceLine)).toBeNull();
    expect(isManagedCoco80Control(item)).toBe(true);
    expect(isManagedCoco80Control({ ...item, name: "objects" })).toBe(false);
    expect(isManagedCoco80Control({ ...item, toname: "photo" })).toBe(false);
    expect(isManagedCoco80Control({ ...item, type: "labels" })).toBe(false);
    expect(isManagedCoco80Control({ ...item, children: item.children.slice(0, 79) })).toBe(false);
    expect(isManagedCoco80Control({ ...item, children: [...item.children].reverse() })).toBe(false);
    expect(isManagedCoco80Control(item, managedTaskData({ coordexp_task_key: "train:140" }))).toBe(false);
    expect(isManagedCoco80Control(item, managedTaskData({ split: "test" }))).toBe(false);
    expect(isManagedCoco80Control(item, managedTaskData({ image_id: "139" }))).toBe(false);
    expect(isManagedCoco80Control(item, managedTaskData({ source_line: 0 }))).toBe(false);
    expect(isManagedCoco80Control(item, managedTaskData({ unexpected: true }))).toBe(false);
    expect(
      isManagedCoco80Control(item, managedTaskData({ image: "/data/local-files/?d=val2017/000000000139.jpg" })),
    ).toBe(false);
  });

  it("accepts the real RectangleLabels model created from the generated static config", () => {
    const item = realManagedRectangleItem();

    expect(item.type).toBe("rectanglelabels");
    expect(item.canrotate).toBe(false);
    expect(item.choice).toBe("single");
    expect(item.children[0].initiallySelected).toBe(false);
    expect({
      maxusages: item.maxusages,
      showinline: item.showinline,
      groupdepth: item.groupdepth,
      opacity: item.opacity,
      fillcolor: item.fillcolor,
      strokewidth: item.strokewidth,
      strokecolor: item.strokecolor,
      fillopacity: item.fillopacity,
      allowempty: item.allowempty,
      value: item.value,
      resolver: item.resolver,
      snap: item.snap,
      smart: item.smart,
      smartonly: item.smartonly,
      isControlTag: item.isControlTag,
      visible: item.visible,
      label: {
        value: item.children[0].value,
        _value: item.children[0]._value,
        background: item.children[0].background,
        visible: item.children[0].visible,
        isEmpty: item.children[0].isEmpty,
        resolver: item.children[0].resolver,
      },
    }).toEqual({
      maxusages: null,
      showinline: true,
      groupdepth: null,
      opacity: "0.2",
      fillcolor: "#f48a42",
      strokewidth: "1",
      strokecolor: "#f48a42",
      fillopacity: null,
      allowempty: false,
      value: "",
      resolver: null,
      snap: "none",
      smart: true,
      smartonly: false,
      isControlTag: true,
      visible: true,
      label: {
        value: "person",
        _value: "person",
        background: "#4C78A8",
        visible: true,
        isEmpty: false,
        resolver: null,
      },
    });
    expect(isManagedCoco80StaticConfig(managedLabelConfig())).toBe(true);
    expect(isManagedCoco80Control(item)).toBe(true);

    render(<HtxLabels item={item} />);
    expect(screen.getByRole("combobox", { name: "Search COCO class" })).toBeInTheDocument();
  });

  it("keeps the guard valid after runtime hotkey assignment and label selection", () => {
    const item = realManagedRectangleItem({ annotations: [{ id: 31, result: [] }] });

    expect(item.children[0].hotkey).not.toBeNull();
    item.children[0].setSelected(true);
    expect(item.children[0].selected).toBe(true);
    expect(item.children[0].initiallySelected).toBe(false);
    expect(isManagedCoco80Control(item)).toBe(true);
  });

  it("leaves ordinary projects on the original native label-button render", () => {
    const ordinary = managedItem({
      taskData: { image: "https://example.test/cat.jpg" },
      item: { name: "ordinary-labels" },
    });

    render(<HtxLabels item={ordinary} />);

    expect(screen.queryByRole("combobox", { name: "Search COCO class" })).not.toBeInTheDocument();
    expect(screen.getByText("native label buttons")).toBeInTheDocument();
  });

  it.each([
    [
      "canRotate=true",
      () =>
        realManagedRectangleItem({
          config: managedLabelConfig({ rectangleAttributes: { canRotate: "true" } }),
        }),
    ],
    [
      "choice=multiple",
      () =>
        realManagedRectangleItem({
          config: managedLabelConfig({ rectangleAttributes: { choice: "multiple" } }),
        }),
    ],
    [
      "configured Label hotkey",
      () =>
        realManagedRectangleItem({
          config: managedLabelConfig({ firstLabelAttributes: { hotkey: "1" } }),
        }),
    ],
    [
      "configured Label selected",
      () =>
        realManagedRectangleItem({
          config: managedLabelConfig({ firstLabelAttributes: { selected: "true" } }),
        }),
    ],
    ["extra task field", () => managedItem({ taskData: managedTaskData({ unexpected: true }) })],
    ["dynamic canonical runtime children", () => managedItem({ item: { value: "$labels" } })],
    [
      "label alias",
      () => {
        const item = managedItem();

        item.children[0].alias = "human";
        return item;
      },
    ],
    [
      "showAlias",
      () => {
        const item = managedItem();

        item.children[0].showalias = true;
        return item;
      },
    ],
    [
      "custom html",
      () => {
        const item = managedItem();

        item.children[0].html = "<b>person</b>";
        return item;
      },
    ],
  ])("renders only the unchanged native controls for %s", (_name, makeItem) => {
    render(<HtxLabels item={makeItem()} />);

    expect(screen.queryByRole("combobox", { name: "Search COCO class" })).not.toBeInTheDocument();
    expect(screen.getByText("native label buttons")).toBeInTheDocument();
  });

  it("selects only the target native Label for new-box selection or native region relabel", async () => {
    const user = userEvent.setup();
    const toggles = [];
    const item = managedItem({ onToggle: (value) => toggles.push(value) });

    render(<HtxLabels item={item} />);
    const input = screen.getByRole("combobox", { name: "Search COCO class" });

    await user.type(input, "car");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["car", "carrot", "cat"]);
    await user.keyboard("{Enter}");

    expect(toggles).toEqual(["car"]);
    expect(item.children.find((label) => label.value === "car").toggleSelected).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
  });

  it("supports deterministic ArrowUp/ArrowDown traversal and pointer selection", async () => {
    const user = userEvent.setup();
    const toggles = [];
    const item = managedItem({ onToggle: (value) => toggles.push(value) });

    render(<HtxLabels item={item} />);
    const input = screen.getByRole("combobox", { name: "Search COCO class" });

    await user.type(input, "board");
    expect(screen.getByRole("option", { name: "snowboard" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "skateboard" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: "snowboard" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(toggles).toEqual(["skateboard"]);

    await user.type(input, "trafik");
    await user.click(screen.getByRole("option", { name: "traffic light" }));
    expect(toggles).toEqual(["skateboard", "traffic light"]);
  });

  it("never offers aliases, translations, free text, or an empty-query value", async () => {
    const user = userEvent.setup();
    const item = managedItem();

    render(<HtxLabels item={item} />);
    const input = screen.getByRole("combobox", { name: "Search COCO class" });

    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    await user.type(input, "automobile");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "交通灯");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(item.children.every((label) => COCO80_CANONICAL_NAMES.includes(label.value))).toBe(true);
    expect(item.children.every((label) => !label.toggleSelected.mock.calls.length)).toBe(true);
  });

  it("Escape cancels and task identity changes discard the transient query", async () => {
    const user = userEvent.setup();
    const first = managedItem();
    const rendered = render(<HtxLabels item={first} />);
    const input = screen.getByRole("combobox", { name: "Search COCO class" });

    await user.type(input, "car");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();

    await user.type(input, "person");
    await user.tab();
    expect(input).toHaveValue("");

    input.focus();
    await user.type(input, "person");
    const second = managedItem({
      taskData: managedTaskData({
        image: "/data/local-files/?d=train2017/000000000285.jpg",
        coordexp_task_key: "train:285",
        image_id: 285,
        source_line: 8,
      }),
    });
    rendered.rerender(<HtxLabels item={second} />);
    expect(screen.getByRole("combobox", { name: "Search COCO class" })).toHaveValue("");
  });
});
