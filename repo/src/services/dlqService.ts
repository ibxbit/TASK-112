import { dal, type DLQEntry } from "../db/dal";
import type { UserRole } from "../db/schema";
import { WOGCError } from "../utils/errors";

type CurrentUser = {
  userId: number | null;
  username: string | null;
  role: UserRole | null;
};

let currentUserResolver: () => CurrentUser = () => ({
  userId: null,
  username: null,
  role: null,
});

const toDALActingRole = (role: UserRole | null): string => {
  if (role === "administrator") {
    return "Administrator";
  }
  if (role === "auditor") {
    return "Auditor";
  }
  if (!role) {
    return "";
  }
  return role;
};

const assertDLQMutationAllowed = (currentUser: CurrentUser, action: "retry" | "archive"): void => {
  if (!currentUser.role || currentUser.role === "auditor") {
    throw new WOGCError({
      code: "AUTH_403",
      message: `Auditor role cannot ${action} DLQ items`,
      context: { action, role: currentUser.role, userId: currentUser.userId },
      retryable: false,
    });
  }
};

class DLQService {
  public async list(status?: "pending" | "replayed" | "archived"): Promise<DLQEntry[]> {
    return dal.listDLQEntries(status);
  }

  public async getById(id: number): Promise<DLQEntry | null> {
    return dal.getDLQEntryById(id);
  }

  public async retryDLQItem(id: number): Promise<DLQEntry | null> {
    const currentUser = currentUserResolver();
    assertDLQMutationAllowed(currentUser, "retry");
    const actingRole = toDALActingRole(currentUser.role);
    if (!actingRole) {
      throw new Error("Unauthorized");
    }
    return dal.retryDLQItem(id, actingRole);
  }

  public async archiveDLQItem(id: number): Promise<DLQEntry | null> {
    const currentUser = currentUserResolver();
    assertDLQMutationAllowed(currentUser, "archive");
    const actingRole = toDALActingRole(currentUser.role);
    if (!actingRole) {
      throw new Error("Unauthorized");
    }
    const row = await dal.getDLQEntryById(id);
    if (!row) {
      return null;
    }
    await dal.updateDLQStatus(id, "archived", actingRole);
    return dal.getDLQEntryById(id);
  }
}

export const dlqService = new DLQService();

export const setDLQCurrentUserResolver = (resolver: () => CurrentUser): void => {
  currentUserResolver = resolver;
};
