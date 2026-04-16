import { observer } from "mobx-react";
import { types } from "mobx-state-tree";

import BaseTool from "./Base";
import ToolMixin from "../mixins/Tool";
import { Tool } from "../components/Toolbar/Tool";
import { IconRotateLeftTool, IconRotateRightTool } from "@humansignal/icons";

const ToolView = observer(({ item }) => {
  return (
    <>
      <Tool
        active={item.selected}
        icon={<IconRotateLeftTool />}
        ariaLabel="rotate-left"
        label="Rotate Left"
        shortcut="tool:rotate-left"
        onClick={() => {
          item.rotate(-90);
        }}
      />
      <Tool
        active={item.selected}
        icon={<IconRotateRightTool />}
        ariaLabel="rotate-right"
        label="Rotate Right"
        shortcut="tool:rotate-right"
        onClick={() => {
          item.rotate(90);
        }}
      />
    </>
  );
});

const _Tool = types
  .model("RotateTool", {
    group: "control",
  })
  .views((self) => ({
    get viewClass() {
      return () => <ToolView item={self} />;
    },
  }))
  .actions((self) => ({
    rotate(degree) {
      const regionCount = self.obj?.annotation?.areas?.size ?? 0;

      if (regionCount > 0) {
        window.alert("当前图片已存在标注对象。请先清空当前标注，再进行图片旋转。");
        return;
      }

      self.obj.rotate(degree);
    },
  }));

const Rotate = types.compose(_Tool.name, ToolMixin, BaseTool, _Tool);

export { Rotate };
