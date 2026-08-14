/**
 * jsdom shims for the drag-and-drop tests (UI pass, Troy direct).
 *
 * jsdom (v30) has no `DataTransfer` constructor, and its `input.files`
 * setter rejects any value that is not jsdom's own internal FileList
 * brand — both verified by running jsdom directly, not assumed. These
 * shims give the REAL production code in `file-drop.ts` a working path in
 * component tests: a minimal DataTransfer, and a `files` accessor that
 * stores whatever FileList-shaped value the code assigns.
 *
 * Test-only by construction: `installFileDropTestShims` is a no-op when a
 * real `DataTransfer` exists (every real browser), and no production
 * module imports this file. The filename deliberately does not end in
 * `.test.ts`, so vitest never collects it as a suite of its own.
 */

interface FileListShape {
  length: number;
  item(index: number): File | null;
  [index: number]: File;
}

function makeFileList(files: readonly File[]): FileList {
  const list: FileListShape = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
  };
  files.forEach((file, index) => {
    list[index] = file;
  });
  return list as unknown as FileList;
}

class DataTransferShim {
  private readonly fileStore: File[] = [];

  readonly items = {
    add: (file: File): void => {
      this.fileStore.push(file);
    },
  };

  get files(): FileList {
    return makeFileList(this.fileStore);
  }
}

export function installFileDropTestShims(): void {
  if (typeof globalThis.DataTransfer !== "undefined") return;
  (globalThis as { DataTransfer?: unknown }).DataTransfer = DataTransferShim;

  const proto = HTMLInputElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "files");
  const originalGet = original?.get;
  if (!originalGet) return;

  const assigned = new WeakMap<HTMLInputElement, FileList>();
  Object.defineProperty(proto, "files", {
    configurable: true,
    get(this: HTMLInputElement): FileList | null {
      return assigned.get(this) ?? (originalGet.call(this) as FileList | null);
    },
    set(this: HTMLInputElement, value: FileList) {
      assigned.set(this, value);
    },
  });
}
