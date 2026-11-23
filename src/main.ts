import { Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { CardPdfView, VIEW_TYPE_CARD_PDF } from "./pdf-view";
import { PdfRect } from "./coords";
import { ensureBase, parseRect } from "./cards";
import { DEFAULT_SETTINGS, MarginCardsSettings, MarginCardsSettingTab } from "./settings";

export default class MarginCardsPlugin extends Plugin {
  settings: MarginCardsSettings = { ...DEFAULT_SETTINGS };
  private cardLeaf: WorkspaceLeaf | null = null;

  // Obsidian 启动插件时调用，不传参数。
  // 1. 读设置，登记设置页。
  // 2. 登记"卡片模式 PDF 视图"，之后 Obsidian 才认得 VIEW_TYPE_CARD_PDF 这个视图类型。
  // 3. 在文件列表的右键菜单里，给每个 PDF 文件加一项"用卡片模式打开"。
  // 4. 监听点击：点卡片笔记里的"回到原文"链接时，用卡片模式 PDF 视图打开，而不是 Obsidian 自带的 PDF 查看器。
  // 5. Obsidian 界面准备好后，卡片文件夹里还没有 错题.base 就生成一个。
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new MarginCardsSettingTab(this));
    this.registerView(VIEW_TYPE_CARD_PDF, (leaf) => new CardPdfView(leaf, this));

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

    this.registerDomEvent(document, "click", (e) => this.onLinkClick(e), true);
    this.app.workspace.onLayoutReady(() => void ensureBase(this.app, this.settings));
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // 全文档的点击事件调用（先于 Obsidian 自己的处理）。参数 e：这次点击。
  // 判断：点到的是不是"回到原文"这种链接？条件是同时满足三条：
  //   1. 点到的元素带 data-href，内容形如 书库/高等数学.pdf#page=3&rect=72,540,520,610
  //   2. 当前打开的笔记在卡片文件夹里
  //   3. 链接指向的 PDF 能在库里找到
  //   三条都满足 → 阻止默认行为，用卡片模式 PDF 视图打开并闪出那个框
  //   有一条不满足 → 什么也不做，链接照常打开（装了 PDF++ 时它的链接不受影响）
  private onLinkClick(e: MouseEvent): void {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-href]");
    const href = el?.getAttribute("data-href");
    const source = this.app.workspace.getActiveFile();
    if (!href || !source || !source.path.startsWith(this.settings.cardsFolder + "/")) return;

    const m = /^(.+\.pdf)#page=(\d+)&rect=([-\d.,]+)$/i.exec(href);
    const rect = m ? parseRect(m[3]) : null;
    const pdf = m ? this.app.metadataCache.getFirstLinkpathDest(m[1], source.path) : null;
    if (!m || !rect || !pdf) return;

    e.preventDefault();
    e.stopPropagation();
    void this.openPdfAt(pdf.path, Number(m[2]), rect);
  }

  // 参数 pdfPath：PDF 在库里的路径；page：页码；rect：要闪的框。
  // 这本 PDF 已经有卡片模式视图开着 → 切到那个标签页；没有 → 新开一个标签页。
  // 然后 PDF 滚到 rect 所在的位置，闪一下框。
  async openPdfAt(pdfPath: string, page: number, rect: PdfRect): Promise<void> {
    let leaf = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_CARD_PDF)
      .find((l) => (l.view as CardPdfView).getFilePath() === pdfPath);
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_CARD_PDF, active: true, state: { file: pdfPath, page } });
    }
    await this.app.workspace.revealLeaf(leaf);
    (leaf.view as CardPdfView).revealRect(page, rect);
  }

  // 用户点 PDF 上的卡片框时调用。参数 file：卡片笔记。
  // 上次打开卡片笔记的那个窗格还在 → 在里面打开；不在（第一次，或被用户关了）→ 把当前窗格向右分出一个新窗格再打开。
  async openCard(file: TFile): Promise<void> {
    if (!this.cardLeaf || !this.app.workspace.getLeavesOfType("markdown").includes(this.cardLeaf)) {
      this.cardLeaf = this.app.workspace.getLeaf("split", "vertical");
    }
    await this.cardLeaf.openFile(file);
  }
}
