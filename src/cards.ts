import { App, TFile, normalizePath } from "obsidian";
import { PdfRect, pdfRectToCssRect } from "./coords";
import type { MarginCardsSettings } from "./settings";

// 卡片可选的 6 种颜色。name 写进卡片笔记的"颜色"属性；hex 是 PDF 上框和选色块的显示色。
// 6 种和 Obsidian Canvas 的预设色 1～6（红、橙、黄、绿、青、紫）一一对应，阶段 3 脑图节点直接用同一顺序。
export const COLORS = [
  { name: "红", hex: "#e5484d" },
  { name: "橙", hex: "#f76b15" },
  { name: "黄", hex: "#e5b800" },
  { name: "绿", hex: "#30a46c" },
  { name: "青", hex: "#12a594" },
  { name: "紫", hex: "#8e4ec6" },
];

const NO_COLOR_HEX = "#8a8a8a";

// 参数 name：卡片的颜色名，没选颜色是 null。返回对应的 Canvas 预设色编号 "1"～"6"；没有颜色或不认识 → undefined。
// 例："红" → "1"，"绿" → "4"。
export function colorNumber(name?: string | null): string | undefined {
  const i = COLORS.findIndex((c) => c.name === name);
  return i >= 0 ? String(i + 1) : undefined;
}

// 参数 name：卡片的"颜色"属性值，可能是 undefined。返回对应的显示色；没有颜色或不认识时返回灰色。
export function colorOf(name?: string): string {
  return COLORS.find((c) => c.name === name)?.hex ?? NO_COLOR_HEX;
}

// 用户在框选小窗里选的内容。
export interface CardChoice {
  type: "摘录" | "错题";
  color: string | null; // 没选颜色是 null
  category: string; // 没填分类是空字符串
}

// 从卡片笔记的属性里读出来的一张卡片。
export interface CardInfo {
  file: TFile;
  type: string;
  pdf: string;
  page: number;
  rect: PdfRect;
  color?: string;
  category?: string;
}

// 一张框选图片渲染成的倍数：屏幕 100% 显示大小（1 点 = 96/72 像素）的 2 倍。
const IMAGE_SCALE = 2 * (96 / 72);

// 参数 value：卡片笔记里 rect 属性的原文，例如 "72,540,520,610"。
// 返回 [x1, y1, x2, y2]；格式不对（不是 4 个数字）时返回 null。
export function parseRect(value: unknown): PdfRect | null {
  if (typeof value !== "string") return null;
  const nums = value.split(",").map((s) => Number(s.trim()));
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null;
  return nums as PdfRect;
}

// 参数 app、settings；pdfPath：只要这本 PDF 的卡片（库里的完整路径），不传就是所有卡片。
// 读取卡片文件夹下每个笔记的属性，属性不全的笔记跳过。返回卡片列表。
export function listCards(app: App, settings: MarginCardsSettings, pdfPath?: string): CardInfo[] {
  const prefix = settings.cardsFolder + "/";
  const cards: CardInfo[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(prefix)) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || !fm["卡片类型"] || typeof fm["pdf"] !== "string" || typeof fm["page"] !== "number") continue;
    const rect = parseRect(fm["rect"]);
    if (!rect || (pdfPath && fm["pdf"] !== pdfPath)) continue;
    cards.push({
      file,
      type: String(fm["卡片类型"]),
      pdf: fm["pdf"],
      page: fm["page"],
      rect,
      color: fm["颜色"] ? String(fm["颜色"]) : undefined,
      category: fm["分类"] ? String(fm["分类"]) : undefined,
    });
  }
  return cards;
}

// 返回库里所有卡片出现过的分类（去重，按字符顺序排序），框选小窗用它做候选。
export function listCategories(app: App, settings: MarginCardsSettings): string[] {
  const set = new Set<string>();
  listCards(app, settings).forEach((c) => c.category && set.add(c.category));
  return [...set].sort();
}

// 参数 path：库里的文件夹路径，例如 "卡片/高等数学/图片"。
// 从最外层开始逐层检查：这一层存在 → 跳过；不存在 → 新建。全部建好后返回。
export async function ensureFolder(app: App, path: string): Promise<void> {
  let current = "";
  for (const part of normalizePath(path).split("/")) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
}

// 参数 app。生成新卡片的 id，格式是 c + 日期 + - + 当天序号。
// 例：今天是 2026-11-22，库里已有 c20261122-0001 和 c20261122-0002 → 返回 c20261122-0003。
export function nextCardId(app: App): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const re = new RegExp(`^c${date}-(\\d{4})$`);
  let max = 0;
  for (const f of app.vault.getFiles()) {
    const m = re.exec(f.basename);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${date}-${String(max + 1).padStart(4, "0")}`;
}

// 参数 value：要写进属性值的文本。含冒号、井号等会被 YAML 误读的字符时，加上双引号写；否则原样写。
function yamlText(value: string): string {
  return /[:#\[\]{}&*!|>'"%@`,]|^\s|\s$|^[-?]/.test(value) ? JSON.stringify(value) : value;
}

// 参数 doc：已打开的 pdf.js 文档；pageNo：页码（从 1 数）；rect：要截的框（PDF 点）。
// 把框里的内容按 IMAGE_SCALE 倍画成 PNG，白底。返回 PNG 的二进制内容。
async function renderRectPng(doc: any, pageNo: number, rect: PdfRect): Promise<ArrayBuffer> {
  const page = await doc.getPage(pageNo);
  const css = pdfRectToCssRect(page.getViewport({ scale: 1 }), rect, IMAGE_SCALE);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(css.width));
  canvas.height = Math.max(1, Math.round(css.height));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 视图整体向左上平移 (left, top)，框的左上角就落在画布的 (0, 0)
  const viewport = page.getViewport({ scale: IMAGE_SCALE, offsetX: -css.left, offsetY: -css.top });
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;

  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  canvas.width = canvas.height = 0;
  page.cleanup();
  if (!blob) throw new Error("框选图片生成失败");
  return blob.arrayBuffer();
}

// 用户在框选小窗点确定后调用。
// 参数 pdfFile：这本 PDF；doc：它已打开的 pdf.js 文档；page：页码；rect：框；choice：小窗里选的内容。
// 先写图片 卡片/<PDF 名>/图片/<id>.png，再写卡片笔记 卡片/<PDF 名>/<id>.md。返回新建的卡片笔记。
// 例：框选《高等数学.pdf》第 3 页，选"错题"、红色、分类"不等式" → 新建 卡片/高等数学/c20261122-0001.md。
export async function createCard(
  app: App,
  settings: MarginCardsSettings,
  pdfFile: TFile,
  doc: any,
  page: number,
  rect: PdfRect,
  choice: CardChoice
): Promise<TFile> {
  const dir = normalizePath(`${settings.cardsFolder}/${pdfFile.basename}`);
  await ensureFolder(app, `${dir}/图片`);

  const id = nextCardId(app);
  const imagePath = `${dir}/图片/${id}.png`;
  await app.vault.createBinary(imagePath, await renderRectPng(doc, page, rect));

  const d = new Date();
  const created = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const rectText = rect.join(",");

  const lines = ["---", `卡片类型: ${choice.type}`, `pdf: ${yamlText(pdfFile.path)}`, `page: ${page}`, `rect: ${rectText}`];
  if (choice.color) lines.push(`颜色: ${choice.color}`);
  if (choice.category) lines.push(`分类: ${yamlText(choice.category)}`);
  lines.push(
    `创建时间: ${created}`,
    "---",
    "",
    `![[${imagePath}]]`,
    "",
    `[[${pdfFile.path}#page=${page}&rect=${rectText}|回到原文]]`,
    "",
    "## 背面",
    "",
    ""
  );
  return app.vault.create(`${dir}/${id}.md`, lines.join("\n"));
}

// 插件启动后调用一次。卡片文件夹下没有 错题.base → 新建；已经有 → 不动（之后归用户改）。
// 写法见 Obsidian 帮助的 Bases 语法页。在 Obsidian 里实测：筛选条件里属性名含中文时写成 note["属性名"] 有效；
// 列（order）里写成 note["属性名"] 会显示成空列，要写成 note.属性名。
export async function ensureBase(app: App, settings: MarginCardsSettings): Promise<void> {
  const path = normalizePath(`${settings.cardsFolder}/错题.base`);
  if (app.vault.getAbstractFileByPath(path)) return;
  await ensureFolder(app, settings.cardsFolder);
  await app.vault.create(
    path,
    [
      "filters:",
      "  and:",
      `    - 'note["卡片类型"] == "错题"'`,
      "views:",
      "  - type: table",
      '    name: "全部错题"',
      "    order:",
      "      - file.name",
      "      - note.颜色",
      "      - note.分类",
      "      - note.page",
      "",
    ].join("\n")
  );
}
