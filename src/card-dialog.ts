import { App, Modal, setIcon } from "obsidian";
import { COLORS, CardChoice } from "./cards";

// 用户框选完一块区域后弹出的小窗：选卡片类型、选颜色、选或输入分类，点确定。
export class CardDialog extends Modal {
  private choice: CardChoice = { type: "摘录", color: null, category: "" };
  private submitted = false;

  // 参数 categories：库里已有的分类，做输入框的候选；
  // onSubmit：用户点确定（或在分类框按回车）时调用，参数是用户选的内容；
  // onDone：小窗关闭时调用一次，不管是确定还是取消，用来收起 PDF 上的临时选框。
  constructor(app: App, private categories: string[], private onSubmit: (c: CardChoice) => void, private onDone: () => void) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mc-dialog");
    this.titleEl.setText("");

    // 第一行：卡片类型，点哪个哪个高亮
    const typeRow = this.contentEl.createDiv({ cls: "mc-dialog-row" });
    const typeBtns = (["摘录", "错题"] as const).map((t) => {
      const b = typeRow.createEl("button", { text: t });
      b.addEventListener("click", () => {
        this.choice.type = t;
        typeBtns.forEach((x) => x.toggleClass("mod-cta", x === b));
      });
      return b;
    });
    typeBtns[0].addClass("mod-cta");

    // 第二行：6 个色块，点一下选中，再点一下取消选中
    const colorRow = this.contentEl.createDiv({ cls: "mc-dialog-row" });
    const swatches = COLORS.map((c) => {
      const s = colorRow.createDiv({ cls: "mc-swatch" });
      s.style.background = c.hex;
      s.setAttribute("aria-label", c.name);
      s.addEventListener("click", () => {
        this.choice.color = this.choice.color === c.name ? null : c.name;
        swatches.forEach((x, i) => x.toggleClass("is-selected", COLORS[i].name === this.choice.color));
      });
      return s;
    });

    // 第三行：分类输入框（候选来自库里已有的分类），回车等于点确定
    const input = this.contentEl.createEl("input", { type: "text", cls: "mc-dialog-input" });
    input.setAttribute("list", "mc-categories");
    input.placeholder = "分类";
    const list = this.contentEl.createEl("datalist", { attr: { id: "mc-categories" } });
    this.categories.forEach((c) => list.createEl("option", { value: c }));
    input.addEventListener("input", () => (this.choice.category = input.value.trim()));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submit();
    });

    // 第四行：确定按钮
    const ok = this.contentEl.createEl("button", { cls: "mod-cta mc-dialog-ok" });
    setIcon(ok, "check");
    ok.addEventListener("click", () => this.submit());

    input.focus();
  }

  // 确定按钮或回车调用。把用户选的内容交给 onSubmit，然后关闭小窗。
  private submit(): void {
    if (this.submitted) return;
    this.submitted = true;
    this.onSubmit({ ...this.choice });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.onDone();
  }
}
