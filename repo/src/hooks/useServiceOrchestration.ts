import { useEffect } from "react";
import type { UserRole } from "../db/schema";
import { setDALEventPublisher } from "../db/dal";
import { taskScheduler } from "../services/TaskScheduler";
import { equipmentAdapter } from "../services/EquipmentAdapter";
import { notificationService } from "../services/NotificationService";
import { eventBus } from "../services/EventBus";
import { domainConsistencyService } from "../services/DomainConsistencyService";

setDALEventPublisher((type, payload) => {
  eventBus.publish(type, payload);
});

export const orchestrateServicesStart = (role: UserRole | null): void => {
  taskScheduler.start();
  equipmentAdapter.start();
  notificationService.start();
  domainConsistencyService.start();
};

export const orchestrateServicesStop = (): void => {
  domainConsistencyService.stop();
  notificationService.stop();
  equipmentAdapter.stop();
  taskScheduler.stop();
};

export const useServiceOrchestration = (isAuthenticated: boolean, role: UserRole | null): void => {
  useEffect(() => {
    if (!isAuthenticated) {
      orchestrateServicesStop();
      return;
    }

    orchestrateServicesStart(role);

    return () => {
      orchestrateServicesStop();
    };
  }, [isAuthenticated, role]);
};
