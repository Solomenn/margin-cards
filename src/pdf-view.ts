import { ItemView, Notice, TFile, ViewStateResult, WorkspaceLeaf, loadPdfJs, setIcon } from "obsidian";

export const VIEW_TYPE_CARD_PDF = "margin-cards-pdf";

// 缩放范围。scale 的意思是：PDF 的 1 个点在屏幕上占多少个 CSS 像素（1 点 = 1/72 英寸）。
const MIN_SCALE = 0.3;
const MAX_SCALE = 5;
// 一张画布最多允许的物理像素数。iPad 的 Safari 超过约 1600 万像素就画不出来，取一半留余量。
const MAX_CANVAS_PIXELS = 8_000_000;
// 一次并行读取多少页的尺寸。
const SIZE_BATCH = 40;

// 一页 PDF 在视图里占的一格。
interface PageSlot {
  index: number; // 页码，从 1 开始
  width: number; // 这一页的宽，单位是 PDF 点
  height: number; // 这一页的高，单位是 PDF 点
  el: HTMLDivElement; // 这一页的容器，大小由 CSS 变量 --pw、--ph 和 --mc-scale 决定
  canvas: HTMLCanvasElement | null; // 已经画好的画布；没画或已经释放时是 null
  canvasScale: number; // 这张画布是按哪个 scale 画的
  renderTask: any; // pdf.js 正在进行的绘制任务；没有任务时是 null
  token: number; // 每次开始新绘制加 1，用来丢弃过期的绘制结果
}

// 目录条目（pdf.js getOutline 的返回格式）。
interface OutlineItem {
  title: string;
  dest: any;
  items: OutlineItem[];
}

export class CardPdfView extends ItemView {
  private filePath: string | null = null;
  private pdfDoc: any = null;
  private slots: PageSlot[] = [];
  private scale = 1.33;
  private loadToken = 0;

  private visible = new Set<number>(); // 现在在屏幕附近的页码
  private observer: IntersectionObserver | null = null;
  private currentPage = 1;
  private outline: OutlineItem[] | null = null;

  private scrollerEl!: HTMLDivElement;
  private pagesEl!: HTMLDivElement;
  private pageInputEl!: HTMLInputElement;
  private totalEl!: HTMLSpanElement;
  private tocBtnEl!: HTMLButtonElement;
  private tocPanelEl!: HTMLDivElement;
  private scaleLabelEl!: HTMLSpanElement;

  private refreshTimer: number | null = null;
  private saveTimer: number | null = null;
  private scrollQueued = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CARD_PDF;
  }

  getDisplayText(): string {
    return this.filePath ? this.filePath.split("/").pop()!.replace(/\.pdf$/i, "") : "卡片模式 PDF";
  }

  getIcon(): string {
    return "layout-grid";
  }

  // Obsidian 保存工作区布局时调用，返回要存下来的内容。
  // 例：{ file: "书库/高等数学.pdf", page: 42, scale: 1.6 }；下次打开 Obsidian 时 setState 会收到同样的内容。
  getState(): Record<string, unknown> {
    return { file: this.filePath, page: this.currentPage, scale: this.scale };
  }

  // Obsidian 打开视图或恢复工作区时调用。
  // 参数 state：getState 存下来的内容，或右键菜单传进来的 { file }。
  // 判断：state.file 和现在打开的文件是不是同一个？
  //   不是 → 读取新文件，显示到 state.page，缩放用 state.scale（没给就按窗口宽度适配）
  //   是 → 不重新读取
  async setState(state: any, result: ViewStateResult): Promise<void> {
    if (state && typeof state.file === "string" && state.file !== this.filePath) {
      await this.loadFile(state.file, state.page ?? 1, state.scale);
    }
    await super.setState(state, result);
  }

  // Obsidian 打开视图时调用，不传参数。
  // 建好工具栏（页码、缩放、目录）和滚动区，装上滚动、Ctrl+滚轮、双指捏合三种事件。
  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("mc-pdf-root");

    const bar = root.createDiv({ cls: "mc-pdf-toolbar" });

    this.tocBtnEl = this.makeButton(bar, "list", "目录");
    this.tocBtnEl.addEventListener("click", () => this.toggleToc());

    bar.createDiv({ cls: "mc-pdf-spacer" });

    this.pageInputEl = bar.createEl("input", { cls: "mc-pdf-page-input", type: "text" });
    this.pageInputEl.inputMode = "numeric";
    this.pageInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.scrollToPage(parseInt(this.pageInputEl.value, 10));
        this.pageInputEl.blur();
      }
    });
    this.pageInputEl.addEventListener("blur", () => this.showCurrentPage());
    this.totalEl = bar.createEl("span", { cls: "mc-pdf-total" });

    bar.createDiv({ cls: "mc-pdf-spacer" });

    this.makeButton(bar, "zoom-out", "缩小").addEventListener("click", () => this.setScale(this.scale / 1.15));
    this.scaleLabelEl = bar.createEl("span", { cls: "mc-pdf-scale" });
    this.makeButton(bar, "zoom-in", "放大").addEventListener("click", () => this.setScale(this.scale * 1.15));
    this.makeButton(bar, "move-horizontal", "适应宽度").addEventListener("click", () => this.fitWidth());

    this.tocPanelEl = root.createDiv({ cls: "mc-pdf-toc mc-hidden" });

    this.scrollerEl = root.createDiv({ cls: "mc-pdf-scroller" });
    this.pagesEl = this.scrollerEl.createDiv({ cls: "mc-pdf-pages" });
    this.pagesEl.style.setProperty("--mc-scale", String(this.scale));

    this.scrollerEl.addEventListener("scroll", () => this.onScroll());
    this.scrollerEl.addEventListener(
      "wheel",
      (e) => {
        // 按住 Ctrl 滚滚轮 → 缩放（并阻止浏览器缩放整个界面）；不按 → 照常滚动
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.setScale(this.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      },
      { passive: false }
    );
    this.installPinch();

    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: this.scrollerEl,
      rootMargin: "100% 0px", // 屏幕上下各多算一个屏幕高度，约前后一两页提前画好
    });

    this.showCurrentPage();
  }

  async onClose(): Promise<void> {
    this.loadToken++;
    this.observer?.disconnect();
    this.observer = null;
    this.releaseAll();
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    await this.pdfDoc?.destroy?.();
    this.pdfDoc = null;
  }

  // onOpen 调用。参数 parent：放按钮的工具栏；icon：Obsidian 图标名；label：鼠标悬停时显示的提示。返回新建的按钮。
  private makeButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const btn = parent.createEl("button", { cls: "clickable-icon mc-pdf-btn" });
    btn.setAttribute("aria-label", label);
    setIcon(btn, icon);
    return btn;
  }

  // setState 调用。参数 path：PDF 文件在库里的路径；page：要显示的页码；scale：缩放，没有就按窗口宽度适配。
  // 读取文件 → 用 Obsidian 自带的 pdf.js 打开 → 读出每一页的尺寸 → 摆好每一页的空格 → 滚到 page。
  // 读取失败（文件不存在、不是有效 PDF）→ 弹出提示，视图保持空白。
  private async loadFile(path: string, page: number, scale?: number): Promise<void> {
    const token = ++this.loadToken;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`找不到文件：${path}`);
      return;
    }

    let doc: any;
    try {
      const data = await this.app.vault.readBinary(file);
      const pdfjs = await loadPdfJs();
      doc = await pdfjs.getDocument({ data }).promise;
    } catch (err) {
      new Notice(`打不开这个 PDF：${path}`);
      console.error("margin-cards: 打开 PDF 失败", err);
      return;
    }
    if (token !== this.loadToken) {
      await doc.destroy();
      return;
    }

    // 换文件：先清掉上一个文件留下的页格、画布、目录
    this.releaseAll();
    this.visible.clear();
    this.observer?.disconnect();
    this.pagesEl.empty();
    this.slots = [];
    await this.pdfDoc?.destroy?.();
    this.pdfDoc = doc;
    this.filePath = path;

    const sizes = await this.readPageSizes(doc, token);
    if (!sizes) return;

    sizes.forEach((size, i) => {
      const el = this.pagesEl.createDiv({ cls: "mc-pdf-page" });
      el.style.setProperty("--pw", String(size.width));
      el.style.setProperty("--ph", String(size.height));
      const slot: PageSlot = { index: i + 1, width: size.width, height: size.height, el, canvas: null, canvasScale: 0, renderTask: null, token: 0 };
      this.slots.push(slot);
      el.dataset.index = String(slot.index);
    });

    this.totalEl.setText(`/ ${this.slots.length}`);
    this.pageInputEl.style.width = `${String(this.slots.length).length + 2}ch`;

    this.scale = scale && scale > 0 ? this.clampScale(scale) : this.fitWidthScale(page);
    this.applyScale();
    this.slots.forEach((s) => this.observer?.observe(s.el));
    this.scrollToPage(page);

    // 目录：读取失败或没有目录 → 目录按钮变灰
    try {
      this.outline = (await doc.getOutline()) ?? null;
    } catch {
      this.outline = null;
    }
    this.tocBtnEl.toggleClass("mc-disabled", !this.outline || this.outline.length === 0);
    this.tocPanelEl.addClass("mc-hidden");

    // 视图顶部标题和标签页标题都要从"卡片模式 PDF"改成文件名。
    // .view-header-title 是视图顶部标题的元素；updateHeader 刷新标签页标题，类型声明里没有，但 Obsidian 运行时有。
    this.containerEl.querySelector(".view-header-title")?.setText(this.getDisplayText());
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
  }

  // loadFile 调用。参数 doc：已打开的 pdf.js 文档；token：loadFile 的编号，编号过期说明用户已经换了文件。
  // 每 SIZE_BATCH 页一组，并行读出每一页的宽和高（单位是 PDF 点，已经算上页面自带的旋转）。
  // 返回按页码排列的 [{ width, height }, ...]；中途被换文件时返回 null。
  private async readPageSizes(doc: any, token: number): Promise<{ width: number; height: number }[] | null> {
    const n: number = doc.numPages;
    const sizes: { width: number; height: number }[] = new Array(n);
    for (let start = 1; start <= n; start += SIZE_BATCH) {
      const end = Math.min(n, start + SIZE_BATCH - 1);
      const jobs: Promise<void>[] = [];
      for (let i = start; i <= end; i++) {
        jobs.push(
          doc.getPage(i).then((p: any) => {
            const v = p.getViewport({ scale: 1 });
            sizes[i - 1] = { width: v.width, height: v.height };
            p.cleanup();
          })
        );
      }
      await Promise.all(jobs);
      if (token !== this.loadToken) return null;
    }
    return sizes;
  }

  // IntersectionObserver 调用。参数 entries：这次进入或离开"屏幕附近"的页格。
  // 判断：这一页进入了屏幕附近吗？
  //   进入 → 记入 visible，开始画
  //   离开 → 从 visible 去掉，释放画布
  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const slot = this.slots[Number((e.target as HTMLElement).dataset.index) - 1];
      if (!slot) continue;
      if (e.isIntersecting) {
        this.visible.add(slot.index);
        void this.renderSlot(slot);
      } else {
        this.visible.delete(slot.index);
        this.releaseSlot(slot);
      }
    }
  }

  // 把一页画到画布上。参数 slot：要画的页格。
  // 判断：这一页已经有按当前 scale 画好的画布吗？
  //   有 → 什么也不做
  //   没有 → 按 scale × 屏幕像素比 画一张新画布；画完才换掉旧画布（旧画布先被浏览器拉伸顶着，不闪白）
  // 例：scale 1.33、屏幕像素比 2 → 一页 612×792 点的 PDF 画成 1628×2107 的画布。
  private async renderSlot(slot: PageSlot): Promise<void> {
    if (!this.pdfDoc || (slot.canvas && slot.canvasScale === this.scale)) return;
    slot.renderTask?.cancel();
    const myToken = ++slot.token;
    const doc = this.pdfDoc;

    try {
      const page = await doc.getPage(slot.index);
      if (myToken !== slot.token) return;

      let outScale = this.scale * (window.devicePixelRatio || 1);
      const pixels = slot.width * outScale * slot.height * outScale;
      // 画布像素超过上限时，等比例降低清晰度，保证 iPad 上画得出来
      if (pixels > MAX_CANVAS_PIXELS) outScale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);

      const viewport = page.getViewport({ scale: outScale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d")!;

      const task = page.render({ canvasContext: ctx, canvas, viewport });
      slot.renderTask = task;
      await task.promise;
      if (myToken !== slot.token) {
        canvas.width = canvas.height = 0;
        return;
      }

      slot.renderTask = null;
      this.dropCanvas(slot);
      slot.canvas = canvas;
      slot.canvasScale = this.scale;
      slot.el.appendChild(canvas);
      page.cleanup();
    } catch (err: any) {
      // 被取消的绘制（滚出屏幕或缩放变了）是正常情况，不报错
      if (err?.name !== "RenderingCancelledException") console.error("margin-cards: 画页失败", slot.index, err);
    }
  }

  // 滚出屏幕附近的页调用。参数 slot：要释放的页格。取消正在进行的绘制，把画布清空并移除。
  private releaseSlot(slot: PageSlot): void {
    slot.token++;
    slot.renderTask?.cancel();
    slot.renderTask = null;
    this.dropCanvas(slot);
  }

  // 参数 slot：要清掉画布的页格。把画布尺寸设成 0（Safari 靠这一步才真正释放内存），再从页面上移除。
  private dropCanvas(slot: PageSlot): void {
    if (!slot.canvas) return;
    slot.canvas.width = slot.canvas.height = 0;
    slot.canvas.remove();
    slot.canvas = null;
  }

  private releaseAll(): void {
    this.slots.forEach((s) => this.releaseSlot(s));
  }

  // 缩放或换文件之后调用，不传参数。把 visible 里每一页按新的 scale 重画。
  private refreshVisible(): void {
    this.visible.forEach((i) => {
      const slot = this.slots[i - 1];
      if (slot) void this.renderSlot(slot);
    });
  }

  private clampScale(s: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  // 参数 page：以哪一页的宽度为准。返回刚好让这一页铺满滚动区宽度的 scale。滚动区还没有宽度时返回默认 1.33。
  private fitWidthScale(page: number): number {
    const slot = this.slots[Math.min(Math.max(page, 1), this.slots.length) - 1];
    const w = this.scrollerEl.clientWidth;
    if (!slot || w <= 0) return 1.33;
    return this.clampScale((w - 24) / slot.width);
  }

  private fitWidth(): void {
    this.setScale(this.fitWidthScale(this.currentPage));
  }

  // 工具栏、滚轮、捏合调用。参数 next：新的 scale。
  // 按 next 缩放，并让缩放前屏幕顶部对着的那一页位置不变。
  // 例：正在看第 42 页中间 → 放大 → 仍然看着第 42 页中间。
  private setScale(next: number): void {
    next = this.clampScale(next);
    if (!this.slots.length || Math.abs(next - this.scale) < 0.001) return;

    const slot = this.slots[this.currentPage - 1];
    const top = this.slotTop(slot);
    const frac = (this.scrollerEl.scrollTop - top) / (slot.height * this.scale);

    this.scale = next;
    this.applyScale();
    this.scrollerEl.scrollTop = this.slotTop(slot) + frac * slot.height * this.scale;

    // 拖动捏合时会连续调用本函数，停下 120 毫秒后才重画一次
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refreshVisible(), 120);
    this.requestSave();
  }

  // 把 this.scale 写成 CSS 变量 --mc-scale，所有页格的大小立刻跟着变；同时更新工具栏的百分比。
  private applyScale(): void {
    this.pagesEl.style.setProperty("--mc-scale", String(this.scale));
    this.scaleLabelEl.setText(`${Math.round(this.scale * 75)}%`);
  }

  // 参数 slot：页格。返回这一页的上边缘到滚动区内容顶部的距离，单位是 CSS 像素。
  private slotTop(slot: PageSlot): number {
    return this.pagesEl.offsetTop + slot.el.offsetTop;
  }

  // 参数 page：页码（从 1 数）。超出范围时取最近的一页。把这一页的上边缘滚到屏幕顶部。
  private scrollToPage(page: number): void {
    if (!this.slots.length || !Number.isFinite(page)) {
      this.showCurrentPage();
      return;
    }
    page = Math.min(Math.max(page, 1), this.slots.length);
    this.scrollerEl.scrollTop = this.slotTop(this.slots[page - 1]) - 8;
    this.currentPage = page;
    this.showCurrentPage();
    this.requestSave();
  }

  // 滚动区每次滚动时调用。同一帧里多次滚动只处理一次。
  private onScroll(): void {
    if (this.scrollQueued) return;
    this.scrollQueued = true;
    requestAnimationFrame(() => {
      this.scrollQueued = false;
      this.updateCurrentPage();
    });
  }

  // 找出屏幕上方三分之一处对着哪一页：从前往后找上边缘不低于这条线的最后一页（二分查找），记为 currentPage。
  private updateCurrentPage(): void {
    if (!this.slots.length) return;
    const line = this.scrollerEl.scrollTop + this.scrollerEl.clientHeight / 3;
    let lo = 0;
    let hi = this.slots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.slotTop(this.slots[mid]) <= line) lo = mid;
      else hi = mid - 1;
    }
    if (this.slots[lo].index !== this.currentPage) {
      this.currentPage = this.slots[lo].index;
      this.showCurrentPage();
      this.requestSave();
    }
  }

  // 把 currentPage 写进页码输入框。输入框正被用户编辑时不改，避免打断输入。
  private showCurrentPage(): void {
    if (!this.pageInputEl || document.activeElement === this.pageInputEl) return;
    this.pageInputEl.value = String(this.currentPage);
  }

  // 页码或缩放变了以后调用。停止变化 500 毫秒后，让 Obsidian 保存一次工作区布局（getState 的内容随之存下）。
  private requestSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.app.workspace.requestSaveLayout(), 500);
  }

  // onOpen 调用。装上双指捏合缩放：两根手指之间的距离变成原来的几倍，scale 就变成原来的几倍。
  // 例：开始时两指相距 100 像素，scale 是 1.2；两指分开到 150 像素 → scale 变成 1.8。
  private installPinch(): void {
    let startDist = 0;
    let startScale = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    this.scrollerEl.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) {
          startDist = dist(e.touches);
          startScale = this.scale;
        }
      },
      { passive: true }
    );
    this.scrollerEl.addEventListener(
      "touchmove",
      (e) => {
        // 两根手指 → 缩放；一根手指 → 照常滚动
        if (e.touches.length !== 2 || startDist === 0) return;
        e.preventDefault();
        this.setScale((startScale * dist(e.touches)) / startDist);
      },
      { passive: false }
    );
    this.scrollerEl.addEventListener("touchend", () => (startDist = 0), { passive: true });
  }

  // 目录按钮调用。目录面板显示着 → 收起；收起着 → 展开并重新列出目录。没有目录时什么也不做。
  private toggleToc(): void {
    if (!this.outline || this.outline.length === 0) return;
    if (!this.tocPanelEl.hasClass("mc-hidden")) {
      this.tocPanelEl.addClass("mc-hidden");
      return;
    }
    this.tocPanelEl.empty();
    this.renderOutline(this.tocPanelEl, this.outline, 0);
    this.tocPanelEl.removeClass("mc-hidden");
  }

  // 参数 parent：放条目的容器；items：这一层的目录条目；depth：缩进层数（最外层是 0）。
  // 每个条目画成一行，点击后跳到它指向的页，并收起面板；有子条目就接着画下一层。
  private renderOutline(parent: HTMLElement, items: OutlineItem[], depth: number): void {
    for (const item of items) {
      const row = parent.createDiv({ cls: "mc-pdf-toc-item", text: item.title });
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.addEventListener("click", async () => {
        const page = await this.resolveDest(item.dest);
        if (page !== null) {
          this.scrollToPage(page);
          this.tocPanelEl.addClass("mc-hidden");
        }
      });
      if (item.items?.length) this.renderOutline(parent, item.items, depth + 1);
    }
  }

  // 参数 dest：目录条目指向的位置，可能是名字（字符串）或位置数组（第一项是页的引用）。
  // 返回页码（从 1 数）；解析不出来（比如目录条目指向外部链接）时返回 null。
  private async resolveDest(dest: any): Promise<number | null> {
    try {
      const arr = typeof dest === "string" ? await this.pdfDoc.getDestination(dest) : dest;
      if (!Array.isArray(arr)) return null;
      const ref = arr[0];
      const index = typeof ref === "number" ? ref : await this.pdfDoc.getPageIndex(ref);
      return index + 1;
    } catch {
      return null;
    }
  }
}
