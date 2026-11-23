import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { CardPdfView, VIEW_TYPE_CARD_PDF } from "./pdf-view";
import { PdfRect } from "./coords";
import { CardInfo, colorNumber, ensureBase, parseRect } from "./cards";
import {
  appendCardNode,
  canvasPathOf,
  cardFileAtElement,
  ensureCanvasFile,
  findCanvasLeaf,
  parseCanvas,
  selectCardNode,
  selectedGroupId,
  slotInGroup,
  slotRightOfAll,
  stringifyCanvas,
} from "./canvas";
import { DEFAULT_SETTINGS, MarginCardsSettings, MarginCardsSettingTab } from "./settings";

export default class MarginCardsPlugin extends Plugin {
  settings: MarginCardsSettings = { ...DEFAULT_SETTINGS };
  private cardLeaf: WorkspaceLeaf | null = null;

  // Obsidian 启动插件时调用，不传参数。
  // 1. 读设置，登记设置页。
  // 2. 登记"卡片模式 PDF 视图"，之后 Obsidian 才认得 VIEW_TYPE_CARD_PDF 这个视图类型。
  // 3. 在文件列表的右键菜单里，给每个 PDF 文件加一项"用卡片模式打开"。
  // 4. 登记命令"并排打开 PDF 和脑图"。
  // 5. 监听点击：点卡片笔记里的"回到原文"链接时，用卡片模式 PDF 视图打开；点脑图里的卡片节点时，PDF 跳到出处。
  // 6. 监听笔记属性变化：卡片的颜色变了，脑图里对应节点的颜色跟着改。
  // 7. Obsidian 界面准备好后，卡片文件夹里还没有 错题.base 就生成一个。
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

    this.addCommand({
      id: "open-pdf-and-mindmap",
      name: "并排打开 PDF 和脑图",
      // 当前窗格是卡片模式 PDF 视图 → 命令可用；不是 → 命令不出现在列表里
      checkCallback: (checking) => {
        const path = this.app.workspace.getActiveViewOfType(CardPdfView)?.getFilePath();
        if (!path) return false;
        if (!checking) void this.openSideBySide(path);
        return true;
      },
    });

    this.registerDomEvent(document, "click", (e) => this.onLinkClick(e), true);
    this.registerDomEvent(document, "click", (e) => this.onCanvasClick(e));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => void this.syncNodeColor(file)));
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

  // 全文档的点击事件调用（Obsidian 处理完之后）。参数 e：这次点击。
  // 判断：点到的是不是脑图里的卡片节点？
  //   点到的元素不在脑图的节点里 → 什么也不做
  //   在节点里，但这个节点不是卡片笔记（文字节点、分组框、别的笔记）→ 什么也不做
  //   是卡片节点，并且这本 PDF 已经在卡片模式视图里开着 → PDF 滚到卡片的框并闪一下，不抢走脑图的焦点
  //   是卡片节点，但这本 PDF 没有开着 → 什么也不做
  private onCanvasClick(e: MouseEvent): void {
    const el = e.target as HTMLElement | null;
    if (!el?.closest || !el.closest(".canvas-node")) return;
    const leaf = this.app.workspace.getLeavesOfType("canvas").find((l) => l.view.containerEl.contains(el));
    const file = leaf ? cardFileAtElement(leaf, el) : null;
    if (!file) return;

    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const rect = parseRect(fm?.["rect"]);
    if (!fm || typeof fm["pdf"] !== "string" || typeof fm["page"] !== "number" || !rect) return;
    void this.openPdfAt(fm["pdf"], fm["page"], rect, false);
  }

  // 参数 pdfPath：PDF 在库里的路径；page：页码；rect：要闪的框；activate：要不要把 PDF 的窗格切到最前面，默认要。
  // 这本 PDF 已经有卡片模式视图开着 → 用那个；没有开着：activate 为 true → 新开一个标签页；activate 为 false → 什么也不做。
  // 然后 PDF 滚到 rect 所在的位置，闪一下框。
  async openPdfAt(pdfPath: string, page: number, rect: PdfRect, activate = true): Promise<void> {
    let leaf = this.findPdfLeaf(pdfPath);
    if (!leaf) {
      if (!activate) return;
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_CARD_PDF, active: true, state: { file: pdfPath, page } });
    }
    if (activate) await this.app.workspace.revealLeaf(leaf);
    (leaf.view as CardPdfView).revealRect(page, rect);
  }

  // 参数 pdfPath：PDF 路径。返回正在用卡片模式显示这本 PDF 的窗格；没有 → null。
  private findPdfLeaf(pdfPath: string): WorkspaceLeaf | null {
    return (
      this.app.workspace.getLeavesOfType(VIEW_TYPE_CARD_PDF).find((l) => (l.view as CardPdfView).getFilePath() === pdfPath) ?? null
    );
  }

  // 用户点 PDF 上的卡片框时调用。参数 card：被点的卡片。
  // 这本书的脑图正开着，并且脑图里有这张卡片的节点 → 脑图移到那个节点并选中它
  // 脑图开着，但找不到节点，或 Obsidian 内部对象取不到 → 弹出提示，改为打开卡片笔记
  // 脑图没开着 → 打开卡片笔记
  async onCardBoxClick(card: CardInfo): Promise<void> {
    const canvasLeaf = findCanvasLeaf(this.app, canvasPathOf(this.settings, card.pdf));
    if (canvasLeaf) {
      if (selectCardNode(canvasLeaf, card.file.path)) return;
      new Notice("脑图里没有找到这张卡片，或取不到脑图的内部对象，改为打开卡片笔记");
    }
    await this.openCard(card.file);
  }

  // 用户点 PDF 上的卡片框、但脑图没法定位时调用。参数 file：卡片笔记。
  // 上次打开卡片笔记的那个窗格还在 → 在里面打开；不在（第一次，或被用户关了）→ 把当前窗格向右分出一个新窗格再打开。
  async openCard(file: TFile): Promise<void> {
    if (!this.cardLeaf || !this.app.workspace.getLeavesOfType("markdown").includes(this.cardLeaf)) {
      this.cardLeaf = this.app.workspace.getLeaf("split", "vertical");
    }
    await this.cardLeaf.openFile(file);
  }

  // 命令和工具栏图标调用。参数 pdfPath：要并排打开的 PDF。
  // 脑图文件还没有 → 先建一个空脑图。PDF 的窗格没开 → 先开。脑图的窗格没开 → 从 PDF 窗格分出一个，在里面打开脑图：
  //   窗口宽 ≥ 高（电脑横屏、iPad 横屏）→ PDF 在左，脑图在右
  //   窗口宽 < 高（iPad 竖屏）→ PDF 在上，脑图在下
  // 脑图的窗格已经开着 → 不再另开。
  async openSideBySide(pdfPath: string): Promise<void> {
    const canvasFile = await ensureCanvasFile(this.app, canvasPathOf(this.settings, pdfPath));
    let pdfLeaf = this.findPdfLeaf(pdfPath);
    if (!pdfLeaf) {
      pdfLeaf = this.app.workspace.getLeaf("tab");
      await pdfLeaf.setViewState({ type: VIEW_TYPE_CARD_PDF, active: true, state: { file: pdfPath } });
    }
    if (!findCanvasLeaf(this.app, canvasFile.path)) {
      const portrait = window.innerHeight > window.innerWidth;
      const canvasLeaf = this.app.workspace.createLeafBySplit(pdfLeaf, portrait ? "horizontal" : "vertical");
      await canvasLeaf.openFile(canvasFile);
    }
    await this.app.workspace.revealLeaf(pdfLeaf);
  }

  // 新建完卡片后调用。参数 pdfFile：卡片来自哪本 PDF；cardFile：新卡片笔记；color：卡片的颜色名，没选是 null。
  // 往这本书的 脑图.canvas 末尾追加一个指向卡片笔记的节点，节点颜色按卡片颜色；脑图里原有的节点、分组框、连线一概不动。
  // 新节点放哪里：
  //   设置是"当前分组框"，脑图开着，用户在脑图里选中了一个分组框，分组框里有空位 → 放进空位
  //   同上，但分组框里没有空位 → 放在所有节点右边，并弹出提示
  //   其他情况 → 放在所有节点右边
  async addCardToCanvas(pdfFile: TFile, cardFile: TFile, color: string | null): Promise<void> {
    const path = canvasPathOf(this.settings, pdfFile.path);
    const canvasFile = await ensureCanvasFile(this.app, path);
    const leaf = findCanvasLeaf(this.app, path);
    const groupId = this.settings.placement === "group" && leaf ? selectedGroupId(leaf) : null;

    let groupFull = false;
    await this.app.vault.process(canvasFile, (text) => {
      const data = parseCanvas(text);
      const inGroup = groupId ? slotInGroup(data.nodes, groupId) : null;
      groupFull = groupId !== null && inGroup === null;
      appendCardNode(data, cardFile.path, inGroup ?? slotRightOfAll(data.nodes), colorNumber(color));
      return stringifyCanvas(data);
    });
    if (groupFull) new Notice("分组框里没有空位，卡片放在脑图最右边");
  }

  // 笔记属性变化时调用。参数 file：属性变了的笔记。
  // 判断：这个笔记是不是卡片，并且它所在书的脑图里有它的节点，并且节点颜色和卡片的"颜色"属性不一致？
  //   不是卡片，或脑图不存在，或脑图里没有这个节点 → 什么也不做
  //   节点颜色已经和卡片一致 → 什么也不做（不写文件）
  //   不一致 → 只改这个节点的 color（卡片没有颜色就删掉 color），其他内容不动
  // 例：把卡片颜色从"红"改成"绿" → 节点 color 从 "1" 变成 "4"。
  private async syncNodeColor(file: TFile): Promise<void> {
    if (!file.path.startsWith(this.settings.cardsFolder + "/")) return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || !fm["卡片类型"] || typeof fm["pdf"] !== "string") return;
    const canvasFile = this.app.vault.getAbstractFileByPath(canvasPathOf(this.settings, fm["pdf"]));
    if (!(canvasFile instanceof TFile)) return;

    const want = colorNumber(fm["颜色"] ? String(fm["颜色"]) : null);
    const node = parseCanvas(await this.app.vault.cachedRead(canvasFile)).nodes.find((n) => n.type === "file" && n.file === file.path);
    if (!node || node.color === want) return;

    await this.app.vault.process(canvasFile, (text) => {
      const data = parseCanvas(text);
      const n = data.nodes.find((x) => x.type === "file" && x.file === file.path);
      if (!n) return text;
      if (want) n.color = want;
      else delete n.color;
      return stringifyCanvas(data);
    });
  }
}
