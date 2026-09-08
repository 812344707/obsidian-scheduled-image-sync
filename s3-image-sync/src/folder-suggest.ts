import { AbstractInputSuggest, App, TFolder } from "obsidian";

/** Use Obsidian's native popover for mouse and keyboard folder selection. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    private readonly vaultApp: App,
    private readonly input: HTMLInputElement,
    private readonly onChoose: (path: string) => void,
  ) {
    super(vaultApp, input);
  }

  getSuggestions(query: string): TFolder[] {
    const search = query.trim().normalize("NFC").toLowerCase();
    return this.vaultApp.vault.getAllFolders(false)
      .filter(folder => folder.path.normalize("NFC").toLowerCase().includes(search))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.input.value = folder.path;
    this.onChoose(folder.path);
    this.close();
  }
}
