import { dal } from "../db/dal";
import { WOGCError } from "../utils/errors";

class ConflictService {
  public async resolve(input: { taskId: number; keepResource: boolean; reason: string }): Promise<void> {
    const reason = input.reason.trim();
    if (reason.length <= 10) {
      throw new WOGCError({
        code: "VAL_REASON_REQUIRED",
        message: "Resolution reason must be more than 10 characters.",
        context: { field: "reason", minLengthExclusive: 10 },
        retryable: false,
      });
    }
    await dal.resolveTaskConflict(input);
  }
}

export const conflictService = new ConflictService();
