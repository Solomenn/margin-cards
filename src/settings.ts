import { PluginSettingTab, Setting } from "obsidian";
import type MarginCardsPlugin from "./main";

export interface MarginCardsSettings {
  cardsFolder: string; // 卡片、图片、手写、脑图都放在库里的这个文件夹下
}

export const DEFAULT_SETTINGS: MarginCardsSettings = {
  cardsFolder: "卡片",
};

export class MarginCardsSettingTab extends PluginSettingTab {
  constructor(private plugin: MarginCardsPlugin) {
    super(plugin.app, plugin);
  }

  // 用户打开插件设置页时 Obsidian 调用。显示一个输入框，改完立刻保存。
  // 输入的文件夹名去掉首尾空格和斜杠；清空时恢复成默认的"卡片"。
  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("卡片文件夹").addText((text) =>
      text
        .setPlaceholder(DEFAULT_SETTINGS.cardsFolder)
        .setValue(this.plugin.settings.cardsFolder)
        .onChange(async (value) => {
          const cleaned = value.trim().replace(/^\/+|\/+$/g, "");
          this.plugin.settings.cardsFolder = cleaned || DEFAULT_SETTINGS.cardsFolder;
          await this.plugin.saveSettings();
        })
    );
  }
}
