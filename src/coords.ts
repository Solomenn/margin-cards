// 屏幕像素和 PDF 点之间的换算，只写在这个文件里，其他文件都调用这里的两个函数。
//
// 两种坐标：
// - PDF 点：1 点 = 1/72 英寸，原点在页面左下角，rect 存成 [x1, y1, x2, y2]，
//   (x1, y1) 是框的左下角，(x2, y2) 是右上角。
// - 屏幕像素：原点在页面左上角，向右、向下增大。
// 页面自带旋转时，换算交给 pdf.js 的 viewport 处理。

// pdf.js 的页面视图（scale 为 1 时）里，这里用到的两个换算方法。
export interface PageViewport {
  convertToViewportPoint(x: number, y: number): [number, number];
  convertToPdfPoint(x: number, y: number): [number, number];
}

export type PdfRect = [number, number, number, number];

export interface CssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// 用户在页面上拖出一个框后调用。
// 参数 viewport：这一页 scale 为 1 的 pdf.js 视图；css：框在页面里的位置和大小（屏幕像素，原点在页面左上角）；
// scale：现在 1 个 PDF 点占几个屏幕像素。
// 返回 [x1, y1, x2, y2]（PDF 点，保留两位小数）。
// 例：scale 为 2，页面高 792 点；屏幕上 left 144、top 100、width 400、height 200
//   → 返回 [72, 592, 272, 692]。
export function cssRectToPdfRect(viewport: PageViewport, css: CssRect, scale: number): PdfRect {
  const [ax, ay] = viewport.convertToPdfPoint(css.left / scale, css.top / scale);
  const [bx, by] = viewport.convertToPdfPoint((css.left + css.width) / scale, (css.top + css.height) / scale);
  const r = (n: number) => Math.round(n * 100) / 100;
  return [r(Math.min(ax, bx)), r(Math.min(ay, by)), r(Math.max(ax, bx)), r(Math.max(ay, by))];
}

// 画卡片框、渲染框选图片、跳转闪框时调用。
// 参数 viewport：这一页 scale 为 1 的 pdf.js 视图；rect：[x1, y1, x2, y2]（PDF 点）；scale：1 个 PDF 点占几个屏幕像素。
// 返回框在页面里的位置和大小（屏幕像素，原点在页面左上角）。
// 例：scale 为 2，页面高 792 点；rect 是 [72, 592, 272, 692] → 返回 left 144、top 200、width 400、height 200。
export function pdfRectToCssRect(viewport: PageViewport, rect: PdfRect, scale: number): CssRect {
  const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return {
    left: Math.min(ax, bx) * scale,
    top: Math.min(ay, by) * scale,
    width: Math.abs(bx - ax) * scale,
    height: Math.abs(by - ay) * scale,
  };
}
