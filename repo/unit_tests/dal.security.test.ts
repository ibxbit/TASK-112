import { beforeEach, describe, expect, it, vi } from "vitest";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

const installLocalStorageStub = (seed: Record<string, string>): void => {
  const store = new Map<string, string>(Object.entries(seed));
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  (globalThis as unknown as { window?: { localStorage?: unknown } }).window = { localStorage };
};

describe("DAL security contracts", () => {
  beforeEach(async () => {
    await clearTables();
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "administrator",
      role: "administrator",
    }));
  });

  it("getUserProfile strips credential fields", async () => {
    const userId = await dal.registerLocalUser({
      username: "secure_user",
      displayName: "Secure User",
      badgeId: "SECU-1001",
      passwordHash: "hash",
      salt: "salt",
      iterations: 120000,
      role: "viewer",
      mustResetPassword: false,
      allowRoleOverride: true,
    });

    const profile = await dal.getUserProfile(userId);
    expect(profile).toBeDefined();
    expect((profile as Record<string, unknown>).passwordHash).toBeUndefined();
    expect((profile as Record<string, unknown>).salt).toBeUndefined();
    expect((profile as Record<string, unknown>).iterations).toBeUndefined();
  });

  it("boots auth store with LocalStorage sessionTimeout", async () => {
    vi.resetModules();
    installLocalStorageStub({
      theme: "dark",
      lastSite: "/queue",
      sessionTimeout: "1800000",
    });

    const authSlice = await import("../src/store/authSlice");
    const initial = authSlice.default(undefined, { type: "@@INIT" });
    expect(initial.sessionTimeoutMs).toBe(1800000);
    expect(initial.lastSite).toBe("/queue");
    expect(initial.preferredTheme).toBe("dark");
  });
});
