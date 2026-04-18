const memoryStore = new Map<string, string>();

const browserStorage = (): Storage | null => {
  if (typeof window === "undefined") {
    return null;
  }
  if (!window.localStorage) {
    return null;
  }
  return window.localStorage;
};

export const safeStorageGet = (key: string): string | null => {
  const storage = browserStorage();
  if (storage) {
    return storage.getItem(key);
  }
  return memoryStore.get(key) ?? null;
};

export const safeStorageSet = (key: string, value: string): void => {
  const storage = browserStorage();
  if (storage) {
    storage.setItem(key, value);
    return;
  }
  memoryStore.set(key, value);
};
