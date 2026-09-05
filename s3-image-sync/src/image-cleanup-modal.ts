import { App, Modal, Setting } from "obsidian";
import type S3ImageSyncPlugin from "./plugin";
import { CleanupResult, CleanupScan, UnusedImage } from "./image-cleanup";
import { formatBytes } from "./utils";

export class ImageCleanupModal extends Modal {
  private scanResult: CleanupScan | null = null;
  private selected = new Set<string>();
  private mode: "local" | "both" = "local";
  private filter = "";
  private page = 0;
  private busy = false;
  private closed = false;
  private results: CleanupResult[] = [];
  constructor(app: App, private plugin: S3ImageSyncPlugin) { super(app); }
  private t(key: string, params: Record<string, unknown> = {}): string { return this.plugin.t(key, params); }

  onOpen(): void {
    this.modalEl.addClass("image-cleanup-modal");
    void this.refresh();
  }
  onClose(): void { this.closed = true; this.contentEl.empty(); }

  private async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.t("cleanupScanning") });
    try {
      this.scanResult = await this.plugin.cleanup.scan();
      this.selected.clear();
      this.page = 0;
      this.results = [];
      if (!this.closed) this.render();
    } catch (error) {
      if (!this.closed) {
        this.contentEl.empty();
        this.contentEl.createEl("p", { text: `${this.t("cleanupScanFailed")} ${error instanceof Error ? error.message : String(error)}` });
        new Setting(this.contentEl).addButton(b => b.setButtonText(this.t("cleanupScan")).onClick(() => void this.refresh()));
      }
    } finally { this.busy = false; }
  }

  private eligible(item: UnusedImage): boolean {
    return this.mode === "local" ? item.local : !item.remoteBlock;
  }

  private render(): void {
    const scan = this.scanResult;
    if (!scan || this.closed) return;
    const el = this.contentEl;
    el.empty();
    el.createEl("h2", { text: this.t("cleanupTitle") });
    el.createEl("p", { text: this.t("cleanupScope"), cls: "setting-item-description" });
    el.createEl("p", { text: this.t("cleanupSummary", { images: scan.imagesScanned, notes: scan.notesScanned, count: scan.items.length }) });
    new Setting(el).setName(this.t("cleanupMode")).addDropdown(d => d
      .addOption("local", this.t("cleanupLocal")).addOption("both", this.t("cleanupBoth"))
      .setValue(this.mode).onChange(value => {
        this.mode = value as "local" | "both";
        this.selected.clear();
        this.render();
      }));
    el.createEl("p", { text: this.t(this.mode === "both" ? "cleanupBothHint" : "cleanupLocalHint"), cls: "setting-item-description" });
    const search = el.createEl("input", { type: "search", cls: "image-cleanup-search", attr: { placeholder: this.t("cleanupSearch"), "aria-label": this.t("cleanupSearch") } });
    search.value = this.filter;
    const toolbar = el.createDiv({ cls: "image-cleanup-toolbar" });
    const allLabel = toolbar.createEl("label");
    const all = allLabel.createEl("input", { type: "checkbox" });
    allLabel.appendText(this.t("cleanupSelectVisible"));
    const selectedText = toolbar.createSpan();
    const list = el.createDiv({ cls: "image-cleanup-list" });
    const pagination = el.createDiv();
    let updateSelection: () => void;
    const action = new Setting(el)
      .addButton(b => b.setButtonText(this.t("cleanupScan")).onClick(() => void this.refresh()))
      .addButton(b => {
        b.setButtonText(this.t("cleanupReview")).setCta().setDisabled(this.selected.size === 0)
          .onClick(() => this.review());
        updateSelection = () => {
          b.setDisabled(this.selected.size === 0);
          selectedText.setText(this.t("cleanupSelected", { count: this.selected.size }));
        };
      });
    action.settingEl.addClass("image-cleanup-actions");
    const drawList = () => {
      list.empty(); pagination.empty();
      const filtered = scan.items.filter(item => item.path.toLowerCase().includes(this.filter.toLowerCase()));
      const pages = Math.max(1, Math.ceil(filtered.length / 100));
      this.page = Math.min(this.page, pages - 1);
      const visible = filtered.slice(this.page * 100, (this.page + 1) * 100);
      const eligible = visible.filter(item => this.eligible(item));
      const updateAll = () => {
        const count = eligible.filter(item => this.selected.has(item.path)).length;
        all.checked = eligible.length > 0 && count === eligible.length;
        all.indeterminate = count > 0 && count < eligible.length;
        all.disabled = eligible.length === 0;
        updateSelection();
      };
      if (!visible.length) list.createEl("p", { text: this.t("cleanupEmpty") });
      for (const item of visible) {
        const row = list.createEl("label", { cls: "image-cleanup-row" });
        const checkbox = row.createEl("input", { type: "checkbox", attr: { "aria-label": item.path } });
        checkbox.checked = this.selected.has(item.path);
        checkbox.disabled = !this.eligible(item);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) this.selected.add(item.path); else this.selected.delete(item.path);
          updateAll();
        });
        const info = row.createDiv();
        info.createDiv({ text: item.path, cls: "image-cleanup-path" });
        info.createDiv({ text: item.local ? formatBytes(item.sizeBytes) : this.t("cleanupNoLocal"), cls: "setting-item-description" });
        info.createDiv({ text: item.remoteBlock || this.t(item.records.some(r => !r.deletedAt) ? "cleanupRemoteReady" : "cleanupRemoteGone"), cls: "setting-item-description" });
      }
      all.onchange = () => {
        for (const item of eligible) {
          if (all.checked) this.selected.add(item.path); else this.selected.delete(item.path);
        }
        drawList();
      };
      new Setting(pagination).setName(this.t("cleanupPage", { page: this.page + 1, pages }))
        .addButton(b => b.setButtonText("←").setDisabled(this.page === 0).onClick(() => { this.page--; drawList(); }))
        .addButton(b => b.setButtonText("→").setDisabled(this.page >= pages - 1).onClick(() => { this.page++; drawList(); }));
      updateAll();
    };
    search.addEventListener("input", () => { this.filter = search.value; this.page = 0; drawList(); });
    drawList();
  }

  private review(): void {
    if (this.busy || !this.scanResult) return;
    const selected = this.scanResult.items.filter(item => this.selected.has(item.path) && this.eligible(item));
    if (!selected.length) return;
    const el = this.contentEl;
    el.empty();
    el.createEl("h2", { text: this.t("cleanupConfirmTitle", { count: selected.length }) });
    el.createEl("p", { text: this.t(this.mode === "both" ? "cleanupBothHint" : "cleanupLocalHint") });
    const list = el.createDiv({ cls: "image-cleanup-list" });
    for (const item of selected) {
      const row = list.createDiv({ cls: "image-cleanup-review-row" });
      row.createDiv({ text: item.path, cls: "image-cleanup-path" });
      if (this.mode === "both") {
        for (const record of item.records.filter(r => !r.deletedAt)) {
          row.createDiv({ text: record.publicUrl, cls: "setting-item-description image-cleanup-path" });
        }
      }
    }
    new Setting(el)
      .addButton(b => b.setButtonText(this.t("cleanupBack")).onClick(() => this.render()))
      .addButton(b => b.setButtonText(this.t("cleanupConfirm")).setWarning().onClick(() => void this.execute(selected)));
  }

  private async execute(items: UnusedImage[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.results = [];
    const el = this.contentEl;
    el.empty();
    const status = el.createEl("p", { text: this.t("cleanupDeleting") });
    let failure = "";
    try {
      await this.plugin.cleanup.deleteSelected(items, this.mode, result => {
        this.results.push(result);
        if (!this.closed) status.setText(this.t("cleanupProgress", { current: this.results.length, total: items.length }));
      });
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; }
    if (this.closed) return;
    el.empty();
    el.createEl("h2", { text: this.t("cleanupResults") });
    if (failure) el.createEl("p", { text: failure });
    const list = el.createDiv({ cls: "image-cleanup-list" });
    for (const result of this.results) {
      list.createDiv({ text: `${result.path}\n${result.message}\n${this.t("cleanupResultDetail", { local: result.localDeleted ? "✓" : "—", remote: result.remoteDeleted })}`, cls: "image-cleanup-review-row image-cleanup-path" });
    }
    new Setting(el)
      .addButton(b => b.setButtonText(this.t("cleanupScan")).onClick(() => void this.refresh()))
      .addButton(b => b.setButtonText(this.t("cleanupClose")).onClick(() => this.close()));
  }
}
