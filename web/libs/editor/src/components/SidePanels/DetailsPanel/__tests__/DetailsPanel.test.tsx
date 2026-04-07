import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Relations, Info } from "../DetailsPanel";

// Mock the dependencies
jest.mock("../../../../utils/bem", () => ({
  cn: (block: string) => ({
    elem: (elem: string) => ({
      toClassName: () => `dm-${block}__${elem}`,
      mod: (mods: any) => ({
        toClassName: () => `dm-${block}__${elem}`,
      }),
    }),
    mod: (mods: any) => ({
      toClassName: () => `dm-${block}`,
      mix: (...args: any[]) => ({
        toClassName: () => `dm-${block}`,
      }),
    }),
    toClassName: () => `dm-${block}`,
    mix: (...args: any[]) => ({
      toClassName: () => `dm-${block}`,
    }),
  }),
}));

jest.mock("../../../Comments/Comments", () => ({
  Comments: (props: any) => <div data-testid="comments-component" {...props} />,
}));

jest.mock("../../../CurrentEntity/AnnotationHistory", () => ({
  AnnotationHistory: (props: any) => <div data-testid="annotation-history" {...props} />,
}));

jest.mock("../RegionDetails", () => ({
  RegionDetailsMain: (props: any) => <div data-testid="region-details-main" {...props} />,
  RegionDetailsMeta: (props: any) => <div data-testid="region-details-meta" {...props} />,
}));

jest.mock("../RegionItem", () => ({
  RegionItem: ({ region, mainDetails, metaDetails }: any) => (
    <div data-testid="detailed-region">
      <div data-testid="region-id">{region.id}</div>
      {mainDetails && <div data-testid="main-details">Main Details</div>}
      {metaDetails && <div data-testid="meta-details">Meta Details</div>}
    </div>
  ),
}));

jest.mock("../Relations", () => ({
  Groups: (props: any) => <div data-testid="groups-component" {...props} />,
  Relations: (props: any) => <div data-testid="relations-component" {...props} />,
}));

jest.mock("../RelationsControls", () => ({
  RelationsControls: (props: any) => <div data-testid="relations-controls" {...props} />,
}));

jest.mock("../../Components/EmptyState", () => ({
  EmptyState: ({ icon, header, description, learnMore }: any) => (
    <div data-testid="empty-state">
      <div data-testid="empty-state-icon">{icon}</div>
      <div data-testid="empty-state-header">{header}</div>
      <div data-testid="empty-state-description">{description}</div>
      {learnMore && (
        <a href={learnMore.href} data-testid={learnMore.testId} target="_blank" rel="noopener noreferrer">
          {learnMore.text}
        </a>
      )}
    </div>
  ),
}));

jest.mock("@humansignal/icons", () => ({
  IconCursor: ({ width, height }: { width: number; height: number }) => (
    <svg data-testid="icon-cursor" width={width} height={height} />
  ),
  IconPlus: ({ width, height }: { width: number; height: number }) => (
    <svg data-testid="icon-plus" width={width} height={height} />
  ),
  IconRelationLink: ({ width, height }: { width: number; height: number }) => (
    <svg data-testid="icon-relation-link" width={width} height={height} />
  ),
}));

jest.mock("../../../../utils/docs", () => ({
  getDocsUrl: (path: string) => `https://docs.example.com/${path}`,
}));

// Mock observer and inject
jest.mock("mobx-react", () => ({
  observer: (component: any) => component,
  inject: (storeName: string) => (component: any) => component,
}));

describe("DetailsPanel", () => {
  describe("RelationsTab", () => {
    const mockCurrentEntityWithRelations = {
      relationStore: {
        size: 3,
        pairRelations: [
          {
            id: "group-1",
            node1: { id: "region1", cleanId: "r1", region_index: 1, type: "rectangleregion" },
            node2: { id: "region2", cleanId: "r2", region_index: 2, type: "vectorregion" },
            parent: {
              deleteRelation: jest.fn(),
            },
          },
        ],
        addPair: jest.fn(),
      },
      regionStore: {
        unselectAll: jest.fn(),
        selection: {
          list: [],
          size: 0,
        },
      },
    };

    const mockCurrentEntityWithoutRelations = {
      relationStore: {
        size: 0,
        pairRelations: [],
        addPair: jest.fn(),
      },
      regionStore: {
        unselectAll: jest.fn(),
        selection: {
          list: [],
          size: 0,
        },
      },
    };

    describe("when hasRelations is false", () => {
      it("renders empty state with correct icon", () => {
        render(<Relations currentEntity={mockCurrentEntityWithoutRelations} />);

        expect(screen.getByTestId("groups-component")).toBeInTheDocument();
      });

      it("renders empty state with correct header", () => {
        render(<Relations currentEntity={mockCurrentEntityWithoutRelations} />);

        expect(screen.queryByTestId("empty-state-header")).not.toBeInTheDocument();
      });

      it("renders empty state with correct description", () => {
        render(<Relations currentEntity={mockCurrentEntityWithoutRelations} />);

        expect(screen.queryByTestId("empty-state-description")).not.toBeInTheDocument();
      });

      it("does not render pair list when no groups exist", () => {
        render(<Relations currentEntity={mockCurrentEntityWithoutRelations} />);

        expect(screen.queryByText("group=[1,2]")).not.toBeInTheDocument();
      });

      it("renders group count header when no relations exist", () => {
        render(<Relations currentEntity={mockCurrentEntityWithoutRelations} />);

        expect(screen.getByText("组 (0)")).toBeInTheDocument();
      });
    });

    describe("when hasRelations is true", () => {
      it("does not render empty state when relations exist", () => {
        render(<Relations currentEntity={mockCurrentEntityWithRelations} />);

        expect(screen.getByTestId("groups-component")).toBeInTheDocument();
      });

      it("renders group list when relations exist", () => {
        render(<Relations currentEntity={mockCurrentEntityWithRelations} />);

        expect(screen.getByTestId("groups-component")).toBeInTheDocument();
      });

      it("renders group count in header when relations exist", () => {
        render(<Relations currentEntity={mockCurrentEntityWithRelations} />);

        expect(screen.getByText("组 (1)")).toBeInTheDocument();
      });
    });
  });

  describe("Info", () => {
    const mockSelectionWithRegions = {
      size: 2,
      list: [
        { id: "region1", type: "rectangle" },
        { id: "region2", type: "polygon" },
      ],
    };

    const mockSelectionEmpty = {
      size: 0,
      list: [],
    };

    describe("when nothingSelected is true", () => {
      it("renders empty state with correct icon when no selection", () => {
        render(<Info selection={mockSelectionEmpty} />);

        const emptyState = screen.getByTestId("empty-state");
        expect(emptyState).toBeInTheDocument();

        const icon = screen.getByTestId("icon-cursor");
        expect(icon).toBeInTheDocument();
        expect(icon).toHaveAttribute("width", "24");
        expect(icon).toHaveAttribute("height", "24");
      });

      it("renders empty state with correct header when no selection", () => {
        render(<Info selection={mockSelectionEmpty} />);

        const header = screen.getByTestId("empty-state-header");
        expect(header).toBeInTheDocument();
        expect(header).toHaveTextContent("View region details");
      });

      it("renders empty state with correct description when no selection", () => {
        render(<Info selection={mockSelectionEmpty} />);

        const description = screen.getByTestId("empty-state-description");
        expect(description).toBeInTheDocument();
        expect(description).toHaveTextContent("Select a region to view its properties, metadata and available actions");
      });

      it("does not render region details on info panel when no selection", () => {
        render(<Info selection={mockSelectionEmpty} />);

        const detailedRegions = screen.queryAllByTestId("detailed-region");
        expect(detailedRegions).toHaveLength(0);
      });

      it("does not render info panel when no selection", () => {
        render(<Info selection={mockSelectionEmpty} />);

        const detailedRegions = screen.queryAllByTestId("detailed-region");
        expect(detailedRegions).toHaveLength(0);
      });

      it("renders empty state when selection is null", () => {
        render(<Info selection={null} />);

        const emptyState = screen.getByTestId("empty-state");
        expect(emptyState).toBeInTheDocument();
      });

      it("renders empty state when selection is undefined", () => {
        render(<Info selection={undefined} />);

        const emptyState = screen.getByTestId("empty-state");
        expect(emptyState).toBeInTheDocument();
      });
    });

    describe("when nothingSelected is false", () => {
      it("does not render empty state when regions are selected", () => {
        render(<Info selection={mockSelectionWithRegions} />);

        expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument();
      });

      it("renders selection details when regions are selected", () => {
        render(<Info selection={mockSelectionWithRegions} />);

        const detailedRegions = screen.getAllByTestId("detailed-region");
        expect(detailedRegions).toHaveLength(2);
      });

      it("renders region info with specific regions selected", () => {
        render(<Info selection={mockSelectionWithRegions} />);

        const detailedRegions = screen.getAllByTestId("detailed-region");
        expect(detailedRegions).toHaveLength(2);

        // Check that specific regions are rendered
        expect(screen.getByText("region1")).toBeInTheDocument();
        expect(screen.getByText("region2")).toBeInTheDocument();
      });

      it("renders main and meta details for each region", () => {
        render(<Info selection={mockSelectionWithRegions} />);

        const mainDetails = screen.getAllByTestId("main-details");
        const metaDetails = screen.getAllByTestId("meta-details");

        expect(mainDetails).toHaveLength(2);
        expect(metaDetails).toHaveLength(2);
      });
    });

    describe("edge cases", () => {
      it("handles selection with size 0 but non-empty list", () => {
        const edgeCaseSelection = {
          size: 0,
          list: [{ id: "region1", type: "rectangle" }], // Inconsistent state
        };

        render(<Info selection={edgeCaseSelection} />);

        // Should render empty state based on size property
        const emptyState = screen.getByTestId("empty-state");
        expect(emptyState).toBeInTheDocument();
      });

      it("handles selection with positive size but empty list", () => {
        const edgeCaseSelection = {
          size: 1,
          list: [], // Inconsistent state
        };

        render(<Info selection={edgeCaseSelection} />);

        // Should not render empty state based on size property
        expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument();

        // But also won't render region items since list is empty
        const detailedRegions = screen.queryAllByTestId("detailed-region");
        expect(detailedRegions).toHaveLength(0);
      });
    });
  });
});
