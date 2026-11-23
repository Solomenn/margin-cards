import { Plugin, TFile } from "obsidian";
import { CardPdfView, VIEW_TYPE_CARD_PDF } from "./pdf-view";

export default class MarginCardsPlugin extends Plugin {
  // Obsidian 启动插件时调用，不传参数。
  // 做两件事：
  // 1. 登记"卡片模式 PDF 视图"，之后 Obsidian 才认得 VIEW_TYPE_CARD_PDF 这个视图类型。
  // 2. 在文件列表的右键菜单里，给每个 PDF 文件加一项"用卡片模式打开"。
  async onload() {
    this.registerView(VIEW_TYPE_CARD_PDF, (leaf) => new CardPdfView(leaf));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        // 右键的是不是 PDF 文件？
        //   是 → 加菜单项
        //   不是（文件夹、笔记、图片等）→ 什么也不加，菜单照常显示
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") return;

        menu.addItem((item) =>
          item
            .setTitle("用卡片模式打开")
            .setIcon("layout-grid")
            .onClick(async () => {
              // 例：右键 书库/高等数学.pdf → 在新标签页里打开卡片模式视图，视图读取 state.file 指向的文件
              const leaf = this.app.workspace.getLeaf("tab");
              await leaf.setViewState({
                type: VIEW_TYPE_CARD_PDF,
                active: true,
                state: { file: file.path },
              });
            })
        );
      })
    );
  }
}
