import { MarkdownView, TFile } from "obsidian";
import type S3ImageSyncPlugin from "./plugin";
import { ImageUploadRecord, S3Config } from "./types";
import { deleteS3Object } from "./s3-client";
import { sha256Hex } from "./crypto";
import { extractLocalRefs } from "./link-parser";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "heif", "bmp", "tif", "tiff", "avif", "ico"]);
const NOTE_EXTENSIONS = new Set(["md", "canvas", "base", "html", "htm"]);
const endpoint = (value: string) => value.replace(/\/+$/, "");
const identity = (r: ImageUploadRecord) => JSON.stringify([endpoint(r.endpoint), r.bucketName, r.key]);
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

// Conservative search supplements link parsing: YAML, HTML, Canvas, reference
// definitions and code examples can all protect a file. False positives retain it.
function normalize(text: string): string {
  // Older replacements may percent-encode an already encoded public URL.
  for (let i = 0; i < 4; i++) {
    const decoded = text.replace(/(?:%[0-9a-f]{2})+/gi, encoded => { try { return decodeURIComponent(encoded); } catch { return encoded; } });
    if (decoded === text) break;
    text = decoded;
  }
  return text.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (raw, code) => {
      const n = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw;
    })
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\\([\\ /()\[\]_*#!])/g, "$1").normalize("NFC").toLowerCase();
}

export interface UnusedImage {
  path: string;
  sizeBytes: number;
  mtime: number;
  ctime: number;
  localHash: string;
  local: boolean;
  records: ImageUploadRecord[];
  remoteBlock: string | null;
}
export interface CleanupResult {
  path: string;
  status: "deleted" | "skipped" | "failed";
  localDeleted: boolean;
  remoteDeleted: number;
  message: string;
}
export interface CleanupScan {
  items: UnusedImage[];
  imagesScanned: number;
  notesScanned: number;
  revision: number;
  fingerprint: string;
  editors: string;
  localText: string;
  remoteText: string;
}

export class ImageCleanup {
  running = false;
  private revision = 0;
  constructor(private plugin: S3ImageSyncPlugin) {}
  invalidate(): void { this.revision++; }

  recordUpload(sourcePath: string, sourceHash: string, key: string, publicUrl: string, config: S3Config): void {
    const record: ImageUploadRecord = {
      sourcePath, sourceHash, key, publicUrl, endpoint: endpoint(config.endpoint),
      region: config.region || "auto", bucketName: config.bucketName, uploadedAt: new Date().toISOString(),
    };
    const records = this.plugin.settings.uploadRecords;
    const existing = records.findIndex(r => identity(r) === identity(record) && r.sourcePath === sourcePath && r.publicUrl === publicUrl);
    if (existing < 0) records.push(record); else records[existing] = record;
  }

  private editorTexts(): string[] {
    return this.plugin.app.workspace.getLeavesOfType("markdown")
      .filter(leaf => leaf.view instanceof MarkdownView)
      .map(leaf => {
        const view = leaf.view as MarkdownView;
        return `${view.file?.path || ""}\n${view.editor.getValue()}`;
      });
  }

  private fingerprint(): string {
    return JSON.stringify(this.plugin.app.vault.getFiles().filter(f =>
      NOTE_EXTENSIONS.has(f.extension.toLowerCase()) || IMAGE_EXTENSIONS.has(f.extension.toLowerCase())
    ).map(f => [f.path, f.stat.mtime, f.stat.ctime, f.stat.size]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  }

  assertStable(scan: CleanupScan): void {
    if (this.plugin.isStopped || scan.revision !== this.revision || scan.fingerprint !== this.fingerprint()
      || scan.editors !== JSON.stringify(this.editorTexts())) throw new Error(this.plugin.t("cleanupChanged"));
  }

  private localUsed(file: TFile, text: string): boolean {
    if (text.includes(normalize(file.name))) return true;
    // Obsidian also resolves wikilinks that omit the image extension.
    const stem = normalize(file.basename);
    for (const match of text.matchAll(/\[\[([^\]|#\n]+)/g)) {
      if (match[1].trim().split("/").pop() === stem) return true;
    }
    return false;
  }

  private remoteUsed(record: ImageUploadRecord, text: string): boolean {
    // Protect alternate domains and signed links by searching the object key as
    // well as the stored URL. Ambiguous matches intentionally keep the object.
    return text.includes(normalize(record.publicUrl)) || text.includes(normalize(record.key));
  }

  private sameStorage(record: ImageUploadRecord): boolean {
    const config = this.plugin.settings.s3;
    return endpoint(config.endpoint) === endpoint(record.endpoint)
      && config.bucketName === record.bucketName && (config.region || "auto") === record.region;
  }

  async scan(hashPaths?: ReadonlySet<string>): Promise<CleanupScan> {
    const { app } = this.plugin;
    const all = app.vault.getFiles();
    const notes = all.filter(f => NOTE_EXTENSIONS.has(f.extension.toLowerCase()));
    const images = all.filter(f => IMAGE_EXTENSIONS.has(f.extension.toLowerCase()));
    const scan: CleanupScan = {
      items: [], imagesScanned: images.length, notesScanned: notes.length,
      revision: this.revision, fingerprint: this.fingerprint(), editors: JSON.stringify(this.editorTexts()),
      localText: "", remoteText: "",
    };
    const texts = this.editorTexts();
    const resolved = new Set<string>();
    for (const note of notes) {
      // A failed read invalidates the whole result; never treat it as an empty note.
      const text = await app.vault.read(note);
      texts.push(text);
      if (note.extension.toLowerCase() === "md") {
        for (const ref of extractLocalRefs(text)) {
          const target = this.plugin.resolveLinkedFile(ref.target, note);
          if (target) resolved.add(target.path);
        }
        // Cache evidence can only retain an image, never authorize its deletion.
        for (const target of Object.keys(app.metadataCache.resolvedLinks?.[note.path] || {})) resolved.add(target);
      }
    }
    scan.remoteText = normalize(texts.join("\n"));
    scan.localText = scan.remoteText
      .replace(/!?\[(?:\\.|[^\]\\\n])*\](?=\s*[([])/g, "")
      .replace(/\balt\s*=\s*(?:"[^"]*"|'[^']*')/g, "")
      .replace(/https?:\/\/[^\s<>"'\])]+/g, "");
    const byPath = new Map<string, ImageUploadRecord[]>();
    for (const record of this.plugin.settings.uploadRecords) {
      if (!IMAGE_EXTENSIONS.has(record.sourcePath.split(".").pop()?.toLowerCase() || "")) continue;
      const records = byPath.get(record.sourcePath) || [];
      records.push(record);
      byPath.set(record.sourcePath, records);
    }
    const paths = new Set([...images.map(f => f.path), ...byPath.keys()]);
    for (const path of paths) {
      const file = app.vault.getAbstractFileByPath(path);
      const local = file instanceof TFile && IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
      if (local && (resolved.has(path) || this.localUsed(file, scan.localText))) continue;
      const records = byPath.get(path) || [];
      const active = records.filter(r => !r.deletedAt);
      if (!local && (active.length === 0 || active.some(r => this.remoteUsed(r, scan.remoteText)))) continue;
      let remoteBlock: string | null = null;
      if (records.length === 0) remoteBlock = this.plugin.t("cleanupUntracked");
      else if (active.some(r => this.remoteUsed(r, scan.remoteText))) remoteBlock = this.plugin.t("cleanupRemoteUsed");
      else if (active.some(r => !this.sameStorage(r))) remoteBlock = this.plugin.t("cleanupStorageChanged");
      scan.items.push({
        path, local, sizeBytes: local ? file.stat.size : 0,
        mtime: local ? file.stat.mtime : 0, ctime: local ? file.stat.ctime : 0,
        localHash: local && (!hashPaths || hashPaths.has(path)) ? await sha256Hex(new Uint8Array(await app.vault.readBinary(file))) : "",
        records, remoteBlock,
      });
    }
    this.assertStable(scan);
    scan.items.sort((a, b) => a.path.localeCompare(b.path));
    return scan;
  }

  async deleteSelected(selected: UnusedImage[], mode: "local" | "both", onResult?: (result: CleanupResult) => void): Promise<CleanupResult[]> {
    if (this.running || this.plugin.syncBusy || this.plugin.isStopped) throw new Error(this.plugin.t("cleanupBusy"));
    this.running = true;
    const results: CleanupResult[] = [];
    try {
      for (const requested of new Map(selected.map(item => [item.path, item])).values()) {
        const result: CleanupResult = { path: requested.path, status: "skipped", localDeleted: false, remoteDeleted: 0, message: "" };
        try {
          if (this.plugin.isStopped) throw new Error(this.plugin.t("cleanupChanged"));
          const scan = await this.scan(new Set([requested.path]));
          const current = scan.items.find(item => item.path === requested.path);
          if (!current || current.local !== requested.local || current.mtime !== requested.mtime
            || current.ctime !== requested.ctime || current.sizeBytes !== requested.sizeBytes || current.localHash !== requested.localHash) {
            result.message = this.plugin.t("cleanupChanged");
          } else if (mode === "both" && current.remoteBlock) {
            result.message = current.remoteBlock;
          } else if (mode === "local" && !current.local) {
            result.message = this.plugin.t("cleanupNoLocal");
          } else {
            // Do not expand a user's reviewed selection to newly uploaded objects.
            const recordSet = (records: ImageUploadRecord[]) => JSON.stringify(records.map(r =>
              [identity(r), r.sourceHash, r.uploadedAt]).sort());
            if (mode === "both" && recordSet(current.records) !== recordSet(requested.records)) throw new Error(this.plugin.t("cleanupChanged"));
            const config = { ...this.plugin.settings.s3 };
            if (mode === "both" && current.records.some(r => !r.deletedAt)) this.plugin.ensureS3Settings();
            this.assertStable(scan);
            const completed = new Set<string>();
            if (mode === "both") {
              for (const record of current.records) {
                if (record.deletedAt || completed.has(identity(record))) continue;
                this.assertStable(scan);
                if (!this.sameStorage(record)) throw new Error(this.plugin.t("cleanupStorageChanged"));
                await deleteS3Object(config, record.key);
                completed.add(identity(record));
                result.remoteDeleted++;
                // Shared hashes can belong to multiple local files. Persist all aliases.
                for (const stored of this.plugin.settings.uploadRecords) {
                  if (identity(stored) === identity(record)) stored.deletedAt = new Date().toISOString();
                }
                await this.plugin.saveSettings();
              }
            }
            this.assertStable(scan);
            const file = this.plugin.app.vault.getAbstractFileByPath(current.path);
            if (current.local && file instanceof TFile) {
              // Fingerprint again after cloud requests and immediately before trashing.
              await this.plugin.app.vault.trash(file, false);
              result.localDeleted = true;
              this.plugin.settings.pendingDeletes = this.plugin.settings.pendingDeletes.filter(r => r.sourcePath !== current.path);
            }
            result.status = "deleted";
            result.message = this.plugin.t("cleanupDeleted");
          }
        } catch (error) {
          result.status = "failed";
          result.message = errorText(error);
        }
        this.plugin.addLog({
          status: `cleanup-${mode}-${result.status}: local=${result.localDeleted}, remote=${result.remoteDeleted}; ${result.message}`,
          sourcePath: result.path, notePath: "", remoteUrl: "", trashed: result.localDeleted,
        });
        results.push(result);
        onResult?.(result);
        // Stop after persistence failure: don't continue deleting without a journal.
        await this.plugin.saveSettings();
      }
      return results;
    } finally {
      this.running = false;
    }
  }
}
