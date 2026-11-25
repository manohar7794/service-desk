import { createId } from "./id";

export interface JobPhoto {
  id: string;
  advisorId: string;
  jobId: string;
  name: string;
  createdAt: string;
  original: Blob;
  thumbnail: Blob;
}

const DATABASE_NAME = "service-desk-photos";
const STORE_NAME = "job-photos";
const DATABASE_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("advisor_job", ["advisorId", "jobId"], { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open local photo storage."));
  });
}

async function makeThumbnail(file: File): Promise<Blob> {
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 480 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create a photo thumbnail.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Unable to encode a photo thumbnail."));
      }, "image/jpeg", 0.78);
    });
  } finally {
    image.close();
  }
}

export async function listJobPhotos(advisorId: string, jobId: string): Promise<JobPhoto[]> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .index("advisor_job")
        .getAll([advisorId, jobId]);
      request.onsuccess = () => resolve((request.result as JobPhoto[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      request.onerror = () => reject(request.error ?? new Error("Unable to load saved photos."));
    });
  } finally {
    database.close();
  }
}

export async function saveJobPhoto(advisorId: string, jobId: string, file: File): Promise<void> {
  const thumbnail = await makeThumbnail(file);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const photo: JobPhoto = {
        id: createId(),
        advisorId,
        jobId,
        name: file.name || "Service photo",
        createdAt: new Date().toISOString(),
        original: file,
        thumbnail,
      };
      const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).add(photo);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Unable to save photo on this device."));
    });
  } finally {
    database.close();
  }
}

export async function deleteJobPhoto(advisorId: string, jobId: string, photoId: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(photoId);
      request.onsuccess = () => {
        const photo = request.result as JobPhoto | undefined;
        if (photo?.advisorId === advisorId && photo.jobId === jobId) store.delete(photoId);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to remove the saved photo."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Unable to remove the saved photo."));
      request.onerror = () => transaction.abort();
    });
  } finally {
    database.close();
  }
}
