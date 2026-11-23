# Margin Cards

在 Obsidian 里做类 MarginNote 的读书工具，电脑和 iPad 都能用。

## 现在有的功能（0.1.0）

- 右键文件列表里的 PDF → "用卡片模式打开"，在新标签页里用插件自己的 PDF 视图阅读。
- 只画屏幕附近的页，滚出去的页立刻释放画布，300 页以上的书也不占满内存。
- 缩放：工具栏的放大、缩小、适应宽度；Ctrl+滚轮；iPad 上双指捏合。
- 跳页：在页码框里输入页码，按回车。
- 目录：点左上角的目录按钮，点条目跳到对应页。
- 关掉再打开，回到上次的页码和缩放。

## 安装

把 margin-cards-<版本>.zip 里的 main.js、manifest.json、styles.css 放进库里的 .obsidian/plugins/margin-cards/，重启 Obsidian，在"第三方插件"里启用 Margin Cards。

## 开发

```
npm install
npm run build
```

构建后生成 main.js。manifest.json 里的 version 和 package.json 里的 version 保持一致，每次发布的 zip 文件名带这个版本号。

## 路线

1. 自己的 PDF 视图（已完成）
2. 框选生成卡片，标严重性和分类
3. 卡片进脑图（Canvas），左右并排、双向跳转
4. 卡片背面手写
5. 翻卡复习
6. 书本留白：在 PDF 两段之间撑开空白手写
