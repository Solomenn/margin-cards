import { App, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import type { MarginCardsSettings } from "./settings";

// JSON Canvas 1.0 的节点（只列出这里用到的字段；其他字段原样保留，不读不改）。
export interface CanvasNode {
  id: string;
  type: string; // "file"、"group"、"text" 等
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  file?: string; // type 是 "file" 时，指向的笔记路径
  [key: string]: unknown;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: unknown[];
  [key: string]: unknown;
}

// 新卡片节点的大小和节点之间的空隙，单位和 Canvas 一样。
const NODE_W = 360;
const NODE_H = 260;
const GAP = 40;
// 分组框内部：左右下留白 20，上方留 60（标题占的位置）。
const GROUP_PAD = 20;
const GROUP_TOP = 60;

// 参数 settings；pdfPath：PDF 在库里的路径，例如 "书库/高等数学.pdf"。
// 返回这本书的脑图文件路径，例如 "卡片/高等数学/脑图.canvas"。
export function canvasPathOf(settings: MarginCardsSettings, pdfPath: string): string {
  const base = (pdfPath.split("/").pop() ?? pdfPath).replace(/\.pdf$/i, "");
  return normalizePath(`${settings.cardsFolder}/${base}/脑图.canvas`);
}

// 参数 text：脑图文件的内容。返回解析后的数据；内容为空或不是 JSON 时，返回一个空脑图。
export function parseCanvas(text: string): CanvasData {
  try {
    const data = JSON.parse(text);
    if (data && Array.isArray(data.nodes)) {
      if (!Array.isArray(data.edges)) data.edges = [];
      return data;
    }
  } catch {
    // 空文件或格式错误：当作空脑图
  }
  return { nodes: [], edges: [] };
}

// 参数 data：脑图数据。返回写回文件用的文本（制表符缩进，和 Obsidian 自己保存的格式一致）。
export function stringifyCanvas(data: CanvasData): string {
  return JSON.stringify(data, null, "\t");
}

// 返回 16 位十六进制随机字符串，做新节点的 id（Canvas 自己生成的 id 也是这个格式）。
export function newNodeId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

// 参数 a、b：两个矩形。返回它们有没有重叠（只贴着边不算）。
function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// 参数 outer、inner：两个矩形。返回 outer 是否把 inner 整个包住。
function contains(outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }): boolean {
  return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}

// 参数 nodes：脑图里现有的全部节点。
// 返回一个放在所有节点右边的位置：x 在最右边那个节点的右边空 GAP 处，y 和最上面那个节点对齐；脑图是空的就返回 (0, 0)。
// 例：现有节点最右边到 x=800、最上面在 y=-100 → 返回 (840, -100)。
export function slotRightOfAll(nodes: CanvasNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 };
  const right = Math.max(...nodes.map((n) => n.x + n.width));
  const top = Math.min(...nodes.map((n) => n.y));
  return { x: right + GAP, y: top };
}

// 参数 nodes：现有的全部节点；groupId：要放进哪个分组框。
// 在分组框里从左到右、从上到下逐格找第一个空位，空位的意思是：和任何节点都不重叠。
// 判断每个现有节点 n（不含这个分组框自己）：
//   n 把候选位置整个包住（n 是外层的大分组框）→ 不算障碍
//   n 和候选位置有重叠 → 是障碍，换下一格
//   其他 → 不影响
// 找到 → 返回位置；整个分组框都没有空位，或 groupId 找不到，或分组框比一张卡片还小 → 返回 null。
export function slotInGroup(nodes: CanvasNode[], groupId: string): { x: number; y: number } | null {
  const group = nodes.find((n) => n.id === groupId && n.type === "group");
  if (!group) return null;
  for (let y = group.y + GROUP_TOP; y + NODE_H <= group.y + group.height - GROUP_PAD; y += NODE_H + GAP) {
    for (let x = group.x + GROUP_PAD; x + NODE_W <= group.x + group.width - GROUP_PAD; x += NODE_W + GAP) {
      const cand = { x, y, width: NODE_W, height: NODE_H };
      const blocked = nodes.some((n) => n.id !== group.id && !contains(n, cand) && overlaps(n, cand));
      if (!blocked) return { x, y };
    }
  }
  return null;
}

// 参数 data：脑图数据；file：卡片笔记路径；slot：位置；color：Canvas 预设色编号 "1"～"6"，没有颜色是 undefined。
// 往 data.nodes 末尾追加一个 file 节点；已有的节点、分组框、连线一概不动。返回新节点。
export function appendCardNode(data: CanvasData, file: string, slot: { x: number; y: number }, color?: string): CanvasNode {
  const node: CanvasNode = { id: newNodeId(), type: "file", file, x: slot.x, y: slot.y, width: NODE_W, height: NODE_H };
  if (color) node.color = color;
  data.nodes.push(node);
  return node;
}

// 参数 app；path：脑图文件路径。脑图文件已经有 → 返回它；没有 → 新建一个空脑图再返回。
export async function ensureCanvasFile(app: App, path: string): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) return existing;
  const folder = path.split("/").slice(0, -1).join("/");
  let current = "";
  for (const part of folder.split("/")) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
  return app.vault.create(path, stringifyCanvas({ nodes: [], edges: [] }));
}

// --- 下面几个函数读 Canvas 视图的内部对象。Obsidian 没有公开这些接口，不同版本可能不一样，
// --- 所以每个函数都先检查要用的方法在不在；不在就返回 false 或 null，由调用方退回别的做法。

// 参数 app；path：脑图文件路径。返回正显示这个脑图的窗格；没有打开 → null。
export function findCanvasLeaf(app: App, path: string): WorkspaceLeaf | null {
  return app.workspace.getLeavesOfType("canvas").find((l) => (l.view as any).file?.path === path) ?? null;
}

// 参数 leaf：Canvas 窗格。返回 Canvas 的内部对象；取不到 → null。
function canvasOf(leaf: WorkspaceLeaf): any | null {
  const canvas = (leaf.view as any).canvas;
  return canvas && canvas.nodes && typeof canvas.nodes.values === "function" ? canvas : null;
}

// 参数 leaf：Canvas 窗格；filePath：卡片笔记路径。
// 在脑图里找到指向这个笔记的节点，选中它，并把画面移过去。
// 找到并且需要的内部方法都在 → 返回 true；节点不存在，或内部方法取不到 → 返回 false。
export function selectCardNode(leaf: WorkspaceLeaf, filePath: string): boolean {
  const canvas = canvasOf(leaf);
  if (!canvas || typeof canvas.selectOnly !== "function" || typeof canvas.zoomToSelection !== "function") return false;
  const node = [...canvas.nodes.values()].find((n: any) => n.file?.path === filePath);
  if (!node) return false;
  canvas.selectOnly(node);
  canvas.zoomToSelection();
  return true;
}

// 参数 leaf：Canvas 窗格；el：用户点到的 DOM 元素。
// 返回这个元素所在节点指向的笔记；点到的不是文件节点，或内部对象取不到 → null。
export function cardFileAtElement(leaf: WorkspaceLeaf, el: HTMLElement): TFile | null {
  const canvas = canvasOf(leaf);
  if (!canvas) return null;
  const nodeEl = el.closest(".canvas-node");
  const node = [...canvas.nodes.values()].find((n: any) => n.nodeEl === nodeEl);
  return node?.file instanceof TFile ? node.file : null;
}

// 参数 leaf：Canvas 窗格。返回用户当前选中的分组框的 id；没有选中分组框，或内部对象取不到 → null。
export function selectedGroupId(leaf: WorkspaceLeaf): string | null {
  const canvas = canvasOf(leaf);
  if (!canvas?.selection) return null;
  for (const n of canvas.selection as Set<any>) {
    const data = typeof n.getData === "function" ? n.getData() : null;
    if (data?.type === "group") return data.id as string;
  }
  return null;
}
