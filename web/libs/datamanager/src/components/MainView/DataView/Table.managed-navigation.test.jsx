let startLabelingFromRow;

beforeAll(() => {
  window.APP_SETTINGS = { hostname: "http://localhost" };
  ({ startLabelingFromRow } = require("./Table"));
});

describe("Data Manager row navigation", () => {
  it("uses managed navigation as the only Draft-save owner", () => {
    const item = { id: 11 };
    const lsf = { isManagedRefinementProject: true, saveDraft: jest.fn() };
    const storeRoot = { startLabeling: jest.fn(() => "managed-navigation") };

    expect(startLabelingFromRow(lsf, storeRoot, item)).toBe("managed-navigation");
    expect(lsf.saveDraft).not.toHaveBeenCalled();
    expect(storeRoot.startLabeling).toHaveBeenCalledWith(item);
  });

  it("preserves the native pre-save for ordinary projects", () => {
    const item = { id: 11 };
    const lsf = { isManagedRefinementProject: false, saveDraft: jest.fn() };
    const storeRoot = { startLabeling: jest.fn() };

    startLabelingFromRow(lsf, storeRoot, item);

    expect(lsf.saveDraft).toHaveBeenCalledTimes(1);
    expect(storeRoot.startLabeling).toHaveBeenCalledWith(item);
    expect(lsf.saveDraft.mock.invocationCallOrder[0]).toBeLessThan(storeRoot.startLabeling.mock.invocationCallOrder[0]);
  });
});
