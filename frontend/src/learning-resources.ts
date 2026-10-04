/**
 * Tiny local-first learning-resource store.
 *
 * This is intentionally independent of the Go runtime: the browser owns the
 * file bytes/text while the runtime owns sessions and model runs.  A host can
 * pass buildResourcePrompt(...) to its existing chat composer without adding a
 * second server-side resource API.
 */

export type LearningResource = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  text: string;
  createdAt: number;
  updatedAt: number;
};

const DATABASE_NAME = "deepstudent-learning-resources";
const DATABASE_VERSION = 1;
const STORE_NAME = "resources";
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

type ResourceDb = IDBDatabase;

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
});

const transactionDone = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
});

let dbPromise: Promise<ResourceDb> | undefined;

function openDb(): Promise<ResourceDb> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("当前浏览器不支持本地资源存储"));
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!store.indexNames.contains("updatedAt")) store.createIndex("updatedAt", "updatedAt");
      if (!store.indexNames.contains("name")) store.createIndex("name", "name");
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = undefined;
      reject(request.error ?? new Error("无法打开本地资源存储"));
    };
  });
  return dbPromise;
}

export async function listLearningResources(): Promise<LearningResource[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readonly");
  const done = transactionDone(tx);
  const rows = await requestResult(tx.objectStore(STORE_NAME).getAll()) as LearningResource[];
  await done;
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putLearningResource(resource: LearningResource): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const done = transactionDone(tx);
  tx.objectStore(STORE_NAME).put(resource);
  await done;
}

export async function deleteLearningResource(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const done = transactionDone(tx);
  tx.objectStore(STORE_NAME).delete(id);
  await done;
}

export function isSupportedLearningFile(file: Pick<File, "name" | "type">): boolean {
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return file.type === "text/plain" || file.type === "text/markdown" || extension === "txt" || extension === "md" || extension === "markdown";
}

/** Decode one Markdown/TXT file; binary/document parsing remains an explicit follow-up. */
export async function resourceFromFile(file: File): Promise<LearningResource> {
  if (!isSupportedLearningFile(file)) throw new Error("最小资源闭环目前只支持 Markdown / TXT");
  if (file.size > MAX_TEXT_BYTES) throw new Error("文件超过 8 MB，请先拆分后再导入");
  const text = await file.text();
  const now = Date.now();
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `resource-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    mimeType: file.type || (file.name.toLowerCase().endsWith(".md") || file.name.toLowerCase().endsWith(".markdown") ? "text/markdown" : "text/plain"),
    size: file.size,
    text,
    createdAt: now,
    updatedAt: now,
  };
}

export function filterLearningResources(resources: LearningResource[], query: string): LearningResource[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return resources;
  return resources.filter((resource) => `${resource.name}\n${resource.text}`.toLocaleLowerCase().includes(needle));
}

/** Keep the prompt bounded while preserving enough context for a first answer. */
export function buildResourcePrompt(resource: LearningResource, question: string, excerpt = ""): string {
  const source = (excerpt.trim() || resource.text).slice(0, 12_000);
  return [
    `请基于学习资料《${resource.name}》回答。`,
    question.trim() || "请总结这份资料的核心要点。",
    "",
    "[资料原文摘录]",
    source,
    "[/资料原文摘录]",
  ].join("\n");
}
