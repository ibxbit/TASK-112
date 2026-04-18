import { describe, expect, it, vi } from "vitest";
import { orchestrateServicesStart, orchestrateServicesStop } from "../src/hooks/useServiceOrchestration";
import { taskScheduler } from "../src/services/TaskScheduler";
import { equipmentAdapter } from "../src/services/EquipmentAdapter";
import { notificationService } from "../src/services/NotificationService";

describe("service orchestration", () => {
  it("starts all background services", () => {
    const schedulerSpy = vi.spyOn(taskScheduler, "start");
    const adapterSpy = vi.spyOn(equipmentAdapter, "start");
    const notifySpy = vi.spyOn(notificationService, "start");

    orchestrateServicesStart("administrator");

    expect(schedulerSpy).toHaveBeenCalledTimes(1);
    expect(adapterSpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    schedulerSpy.mockRestore();
    adapterSpy.mockRestore();
    notifySpy.mockRestore();
  });

  it("starts notification service for non-admin roles", () => {
    const notifySpy = vi.spyOn(notificationService, "start");
    orchestrateServicesStart("viewer");
    expect(notifySpy).toHaveBeenCalledTimes(1);
    notifySpy.mockRestore();
  });

  it("stops all background services", () => {
    const schedulerSpy = vi.spyOn(taskScheduler, "stop");
    const adapterSpy = vi.spyOn(equipmentAdapter, "stop");
    const notifySpy = vi.spyOn(notificationService, "stop");

    orchestrateServicesStop();

    expect(schedulerSpy).toHaveBeenCalledTimes(1);
    expect(adapterSpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    schedulerSpy.mockRestore();
    adapterSpy.mockRestore();
    notifySpy.mockRestore();
  });
});
