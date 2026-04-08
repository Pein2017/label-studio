import { IconPlus, IconTrash } from "@humansignal/icons";
import { Button } from "@humansignal/ui";
import { observer } from "mobx-react";
import { type CSSProperties, type FC, useCallback, useMemo } from "react";
import { cn } from "../../../utils/bem";
import {
  formatPairGroupLabel,
  getPairGroupKind,
  getPairRegionColor,
  getPairRegionLabel,
  getPairGroupValidation,
  PAIR_GROUP_KIND,
} from "../../../utils/pairGroups";
import { EmptyState } from "../Components/EmptyState";
import { RegionItem } from "./RegionItem";
import "./Relations.prefix.css";

interface GroupsProps {
  relationStore: any;
  selection?: any;
  regionStore?: any;
  store?: any;
}

const getShortcutLabel = () => {
  if (typeof navigator === "undefined") return "Ctrl";

  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";

  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
};

const getSelectionStateCopy = (selectedRegions: any[], validation: any, shortcutLabel: string) => {
  if (selectedRegions.length === 0) {
    return `先点击一个端口，再按住 ${shortcutLabel} 点击一个尾纤连接处。`;
  }

  if (selectedRegions.length === 1) {
    return `已选 1/2，再按住 ${shortcutLabel} 点击另一个对象。`;
  }

  if (selectedRegions.length > 2) {
    return `当前已选 ${selectedRegions.length} 个对象，请只保留一个端口和一个尾纤连接处。`;
  }

  if (validation.ok && validation.members) {
    return `已就绪：${formatPairGroupLabel(validation.members)}`;
  }

  return validation.reason;
};

const getSelectionChipLabel = (region: any) => {
  return getPairRegionLabel(region) ?? (getPairGroupKind(region) === PAIR_GROUP_KIND.LINE ? "尾纤连接处" : "对象");
};

const GroupsComponent: FC<GroupsProps> = observer(function GroupsComponent({ relationStore, selection, regionStore }) {
  const selectedRegions = selection?.list?.filter((region: any) => !region.classification) ?? [];
  const validation = getPairGroupValidation(selectedRegions, relationStore);
  const groups = relationStore?.pairRelations ?? [];
  const shortcutLabel = useMemo(() => getShortcutLabel(), []);
  const selectionStateCopy = getSelectionStateCopy(selectedRegions, validation, shortcutLabel);

  const createGroup = useCallback(() => {
    const members = validation.members ?? getPairGroupValidation(selectedRegions, relationStore).members;
    if (!members) return;

    relationStore.addPair(members[0], members[1]);
    regionStore?.unselectAll?.();
  }, [relationStore, regionStore, selectedRegions, validation.members]);

  return (
    <div className={cn("relations").toClassName()}>
      <div className={cn("relations").elem("composer").toClassName()}>
        <div className={cn("relations").elem("composer-copy").toClassName()}>
          <div className={cn("relations").elem("composer-title").toClassName()}>成组</div>
          <div className={cn("relations").elem("composer-description").toClassName()}>
            先点一个端口，再按住 {shortcutLabel} 点击一个尾纤连接处，然后点击成组。
          </div>
          <div
            className={cn("relations")
              .elem("selection-state")
              .mod({ ready: validation.ok, error: !!selectedRegions.length && !validation.ok })
              .toClassName()}
          >
            {selectionStateCopy}
          </div>
          {!!selectedRegions.length && (
            <div className={cn("relations").elem("selection-items").toClassName()}>
              {selectedRegions.map((region: any) => (
                <div
                  key={region.id}
                  className={cn("relations").elem("selection-chip").toClassName()}
                  style={
                    getPairRegionColor(region)
                      ? ({
                          "--chip-accent": getPairRegionColor(region),
                        } as CSSProperties)
                      : undefined
                  }
                >
                  <span className={cn("relations").elem("selection-chip-kind").toClassName()}>
                    {getSelectionChipLabel(region)}
                  </span>
                  <span className={cn("relations").elem("selection-chip-index").toClassName()}>
                    #{region.region_index ?? "?"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <Button
          variant="primary"
          look="filled"
          size="small"
          disabled={!validation.ok}
          onClick={createGroup}
          aria-label="成组"
          tooltip={
            validation.ok
              ? `成组 ${formatPairGroupLabel(validation.members)}`
              : validation.reason || "请选择一个端口和一个尾纤连接处"
          }
        >
          成组
        </Button>
      </div>

      {groups.length ? (
        <div className={cn("relations").elem("group-list").toClassName()}>
          {groups.map((relation: any) => (
            <GroupItem key={relation.id} relation={relation} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<IconPlus width={24} height={24} />}
          header="暂无组"
          description="组会以 group=[1,2] 的形式保留在导出结果中。"
        />
      )}
    </div>
  );
});

const GroupItem: FC<{ relation: any }> = observer(({ relation }) => {
  const label = formatPairGroupLabel([relation.node1, relation.node2]);
  const boxColor = getPairRegionColor(relation.node1);
  const lineColor = getPairRegionColor(relation.node2);

  return (
    <div
      className={cn("relations").elem("group-item").toClassName()}
      style={
        {
          "--group-box-accent": boxColor ?? "var(--color-positive)",
          "--group-line-accent": lineColor ?? "var(--color-warning)",
        } as CSSProperties
      }
    >
      <div className={cn("relations").elem("group-item-head").toClassName()}>
        <div className={cn("relations").elem("group-label").toClassName()}>
          <span>{label}</span>
        </div>
        <Button
          variant="negative"
          look="string"
          size="small"
          aria-label="删除组"
          tooltip="删除组"
          onClick={() => relation.parent.deleteRelation(relation)}
        >
          <IconTrash />
        </Button>
      </div>

      <div className={cn("relations").elem("content").toClassName()}>
        <div className={cn("relations").elem("group-badges").toClassName()}>
          <div
            className={cn("relations").elem("group-badge").mod({ kind: "box" }).toClassName()}
            style={{ "--badge-accent": boxColor ?? "var(--color-positive)" } as CSSProperties}
          >
            {getPairRegionLabel(relation.node1) ?? "端口"} #{relation.node1?.region_index ?? "?"}
          </div>
          <div
            className={cn("relations").elem("group-badge").mod({ kind: "line" }).toClassName()}
            style={{ "--badge-accent": lineColor ?? "var(--color-warning)" } as CSSProperties}
          >
            {getPairRegionLabel(relation.node2) ?? "尾纤连接处"} #{relation.node2?.region_index ?? "?"}
          </div>
        </div>
        <div className={cn("relations").elem("nodes").toClassName()}>
          <div className={cn("relations").elem("node-card").mod({ kind: "box" }).toClassName()}>
            <RegionItem compact withActions={false} withIds={false} region={relation.node1} />
          </div>
          <div className={cn("relations").elem("node-card").mod({ kind: "line" }).toClassName()}>
            <RegionItem compact withActions={false} withIds={false} region={relation.node2} />
          </div>
        </div>
      </div>
    </div>
  );
});

export const Groups = GroupsComponent;
export const Relations = GroupsComponent;
