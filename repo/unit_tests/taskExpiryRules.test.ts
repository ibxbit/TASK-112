import { beforeEach, describe, expect, it } from "vitest";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";
import { WOGCError } from "../src/utils/errors";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

describe("task expiry rules", () => {
  beforeEach(async () => {
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "dispatcher",
      role: "dispatcher",
    }));
    await clearTables();
  });

  it("expires unacknowledged task after 30 minutes", async () => {
    const createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    await dal.saveTask({
      title: "A",
      status: "open",
      workstream: "putaway",
      createdAt,
    });
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const tasks = await dal.getExpirableTasks(cutoff);
    expect(tasks.length).toBe(1);
  });

  it("never expires acknowledged task regardless of age", async () => {
    const createdAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    await dal.saveTask({
      title: "B",
      status: "open",
      workstream: "putaway",
      createdAt,
      acknowledgedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    });
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const tasks = await dal.getExpirableTasks(cutoff);
    expect(tasks.length).toBe(0);
  });

  it("enforces task priority boundaries at DAL write boundary", async () => {
    await expect(dal.saveTask({ title: "P1", status: "open", workstream: "putaway", priority: 1, createdAt: new Date().toISOString() })).resolves.toBeTypeOf("number");
    await expect(dal.saveTask({ title: "P5", status: "open", workstream: "putaway", priority: 5, createdAt: new Date().toISOString() })).resolves.toBeTypeOf("number");

    await expect(dal.saveTask({ title: "P0", status: "open", workstream: "putaway", priority: 0 as unknown as 1, createdAt: new Date().toISOString() })).rejects.toBeInstanceOf(WOGCError);
    await expect(dal.saveTask({ title: "P6", status: "open", workstream: "putaway", priority: 6 as unknown as 1, createdAt: new Date().toISOString() })).rejects.toBeInstanceOf(WOGCError);
    await expect(dal.saveTask({ title: "Pfloat", status: "open", workstream: "putaway", priority: 2.5 as unknown as 1, createdAt: new Date().toISOString() })).rejects.toBeInstanceOf(WOGCError);
    await expect(dal.saveTask({ title: "Pnull", status: "open", workstream: "putaway", priority: null as unknown as 1, createdAt: new Date().toISOString() })).rejects.toBeInstanceOf(WOGCError);

    const rows = await dal.listTasks();
    expect(rows.some((row) => (row.priority ?? 3) < 1 || (row.priority ?? 3) > 5)).toBe(false);
  });

  it("task acknowledged after expiry window remains expired once transitioned", async () => {
    const createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const taskId = await dal.saveTask({
      title: "D",
      status: "open",
      workstream: "putaway",
      createdAt,
    });
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const expirable = await dal.getExpirableTasks(cutoff);
    await dal.expireTasks(expirable.map((task) => task.id));

    await dal.saveTask({
      id: taskId,
      title: "D",
      status: "expired",
      workstream: "putaway",
      createdAt,
      acknowledgedAt: new Date().toISOString(),
    });

    const task = await dal.getTaskById(taskId);
    expect(task?.status).toBe("expired");
  });

  it("unacknowledged task at 30-minute threshold transitions to expired", async () => {
    const createdAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await dal.saveTask({
      title: "E",
      status: "open",
      workstream: "putaway",
      createdAt,
    });
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const expirable = await dal.getExpirableTasks(cutoff);
    expect(expirable.length).toBe(1);
    await dal.expireTasks(expirable.map((task) => task.id));
    const tasks = await dal.listTasks();
    expect(tasks[0]?.status).toBe("expired");
  });
});
