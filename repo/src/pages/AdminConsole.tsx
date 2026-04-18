import { useEffect, useState } from "react";
import { dal, type RuntimeConfig } from "../db/dal";
import type {
  EquipmentAdapterRecord,
  OperationalTemplateRecord,
  PermissionOverrideRecord,
  SystemSettingRecord,
  TaskWorkstream,
  UserProfileRecord,
  UserRole,
  WarehouseSiteRecord,
} from "../db/schema";
import { WOGCError } from "../utils/errors";
import { authService } from "../services/AuthService";

type UserRow = UserProfileRecord & { id: number };
type SettingRow = SystemSettingRecord & { id: number };
type OverrideRow = PermissionOverrideRecord & { id: number };
type SiteRow = WarehouseSiteRecord & { id: number };
type AdapterRow = EquipmentAdapterRecord & { id: number };
type TemplateRow = OperationalTemplateRecord & { id: number };

const roles: UserRole[] = ["administrator", "dispatcher", "facilitator", "operator", "viewer", "auditor"];
const workstreams: TaskWorkstream[] = ["putaway", "transport", "picking", "replenishment"];

export default function AdminConsole(): JSX.Element {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [adapters, setAdapters] = useState<AdapterRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [sessions, setSessions] = useState<Array<{ id: number; username: string; role: UserRole; createdAt: string; terminatedAt?: string }>>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [configFile, setConfigFile] = useState<File | null>(null);

  const [newUser, setNewUser] = useState({ username: "", displayName: "", badgeId: "", role: "viewer" as UserRole, temporaryPassword: "" });
  const [settingDraft, setSettingDraft] = useState({ key: "", value: "" });
  const [overrideDraft, setOverrideDraft] = useState({ role: "viewer" as UserRole, scope: "", canRead: true, canWrite: false });
  const [siteDraft, setSiteDraft] = useState({ id: 0, code: "", name: "", timezone: "UTC", active: true });
  const [adapterDraft, setAdapterDraft] = useState({ id: 0, adapterKey: "", displayName: "", protocol: "rest" as EquipmentAdapterRecord["protocol"], endpoint: "", active: true });
  const [templateDraft, setTemplateDraft] = useState({ id: 0, templateKey: "", name: "", workstream: "putaway" as TaskWorkstream, content: "", active: true });

  const load = async (): Promise<void> => {
    try {
      const [userRows, settingRows, overrideRows, siteRows, adapterRows, templateRows, sessionRows] = await Promise.all([
        dal.listUsers(),
        dal.listSystemSettings(),
        dal.listPermissionOverrides(),
        dal.listWarehouseSites(),
        dal.listEquipmentAdapters(),
        dal.listOperationalTemplates(),
        dal.listSessions(),
      ]);
      const cfg = await dal.getPublicConfig();
      setUsers(userRows);
      setSettings(settingRows);
      setOverrides(overrideRows);
      setSites(siteRows);
      setAdapters(adapterRows);
      setTemplates(templateRows);
      setSessions(sessionRows);
      setRuntimeConfig(cfg);
    } catch (error) {
      if (error instanceof WOGCError) {
        setToast(`${error.code}: ${error.message}`);
      }
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const createUser = async (): Promise<void> => {
    try {
      const username = authService.normalizeUsername(newUser.username);
      const available = await authService.ensureUsernameAvailable(username);
      if (!available) {
        setToast("Username already exists.");
        return;
      }
      const material = await authService.generateCredentialMaterial(newUser.temporaryPassword);
      await dal.registerLocalUser({
        username,
        displayName: newUser.displayName,
        badgeId: newUser.badgeId,
        role: newUser.role,
        passwordHash: material.passwordHash,
        salt: material.salt,
        iterations: material.iterations,
        mustResetPassword: true,
      });
      setToast("User created with temporary credential. First login requires password reset.");
      await load();
    } catch (error) {
      if (error instanceof WOGCError) {
        setToast(`${error.code}: ${error.message}`);
      }
    }
  };

  const saveSetting = async (): Promise<void> => {
    try {
      await dal.saveSystemSetting(settingDraft);
      setToast("System setting updated.");
      await load();
    } catch (error) {
      if (error instanceof WOGCError) {
        setToast(`${error.code}: ${error.message}`);
      }
    }
  };

  const saveOverride = async (): Promise<void> => {
    try {
      await dal.savePermissionOverride(overrideDraft);
      setToast("Permission override updated.");
      await load();
    } catch (error) {
      if (error instanceof WOGCError) {
        setToast(`${error.code}: ${error.message}`);
      }
    }
  };

  const terminateSession = async (sessionId: number): Promise<void> => {
    try {
      await dal.terminateSession(sessionId);
      setToast(`Session ${sessionId} terminated.`);
      await load();
    } catch (error) {
      if (error instanceof WOGCError) {
        setToast(`${error.code}: ${error.message}`);
      }
    }
  };

  const saveSite = async (): Promise<void> => {
    try {
      await dal.saveWarehouseSite({
        id: siteDraft.id || undefined,
        code: siteDraft.code,
        name: siteDraft.name,
        timezone: siteDraft.timezone,
        active: siteDraft.active,
      });
      setToast(siteDraft.id ? "Warehouse site updated." : "Warehouse site created.");
      setSiteDraft({ id: 0, code: "", name: "", timezone: "UTC", active: true });
      await load();
    } catch (error) {
      if (error instanceof WOGCError) {
        setToast(`${error.code}: ${error.message}`);
      }
    }
  };

  const removeSite = async (id: number): Promise<void> => {
    try {
      await dal.deleteWarehouseSite(id);
      setToast(`Warehouse site ${id} deleted.`);
      await load();
    } catch (error) {
      if (error instanceof WOGCError) {
        setToast(`${error.code}: ${error.message}`);
      }
    }
  };

  const saveAdapter = async (): Promise<void> => {
    try {
      await dal.saveEquipmentAdapter({
        id: adapterDraft.id || undefined,
        adapterKey: adapterDraft.adapterKey,
        displayName: adapterDraft.displayName,
        protocol: adapterDraft.protocol,
        endpoint: adapterDraft.endpoint,
        active: adapterDraft.active,
      });
      setToast(adapterDraft.id ? "Equipment adapter updated." : "Equipment adapter created.");
      setAdapterDraft({ id: 0, adapterKey: "", displayName: "", protocol: "rest", endpoint: "", active: true });
      await load();
    } catch (error) {
      if (error instanceof WOGCError) {
        setToast(`${error.code}: ${error.message}`);
      }
    }
  };

  const removeAdapter = async (id: number): Promise<void> => {
    try {
      await dal.deleteEquipmentAdapter(id);
      setToast(`Equipment adapter ${id} deleted.`);
      await load();
    } catch (error) {
      if (error instanceof WOGCError) {
        setToast(`${error.code}: ${error.message}`);
      }
    }
  };

  const saveTemplate = async (): Promise<void> => {
    try {
      await dal.saveOperationalTemplate({
        id: templateDraft.id || undefined,
        templateKey: templateDraft.templateKey,
        name: templateDraft.name,
        workstream: templateDraft.workstream,
        content: templateDraft.content,
        active: templateDraft.active,
      });
      setToast(templateDraft.id ? "Operational template updated." : "Operational template created.");
      setTemplateDraft({ id: 0, templateKey: "", name: "", workstream: "putaway", content: "", active: true });
      await load();
    } catch (error) {
      if (error instanceof WOGCError) {
        setToast(`${error.code}: ${error.message}`);
      }
    }
  };

  const removeTemplate = async (id: number): Promise<void> => {
    try {
      await dal.deleteOperationalTemplate(id);
      setToast(`Operational template ${id} deleted.`);
      await load();
    } catch (error) {
      if (error instanceof WOGCError) {
        setToast(`${error.code}: ${error.message}`);
      }
    }
  };

  const importConfig = async (): Promise<void> => {
    if (!configFile) {
      setToast("Choose a JSON config file first.");
      return;
    }
    try {
      const text = await configFile.text();
      const imported = await dal.importRuntimeConfig(text);
      setRuntimeConfig(imported);
      setToast(`Configuration imported (v${imported.version}).`);
      await load();
    } catch (error) {
      if (error instanceof WOGCError) {
        setToast(`${error.code}: ${error.message}`);
      }
    }
  };

  return (
    <main style={{ padding: "1rem", display: "grid", gap: "0.8rem" }}>
      <h2>Administrator Console</h2>
      {toast ? <p className="inline-error">{toast}</p> : null}

      <section className="card-grid">
        <article className="card">
          <h3>User Management</h3>
          <div className="row-wrap">
            <input placeholder="username" value={newUser.username} onChange={(event) => setNewUser((prev) => ({ ...prev, username: event.target.value }))} />
            <input placeholder="display name" value={newUser.displayName} onChange={(event) => setNewUser((prev) => ({ ...prev, displayName: event.target.value }))} />
            <input placeholder="badge id" value={newUser.badgeId} onChange={(event) => setNewUser((prev) => ({ ...prev, badgeId: event.target.value }))} />
            <input type="password" placeholder="temporary password" value={newUser.temporaryPassword} onChange={(event) => setNewUser((prev) => ({ ...prev, temporaryPassword: event.target.value }))} />
            <select value={newUser.role} onChange={(event) => setNewUser((prev) => ({ ...prev, role: event.target.value as UserRole }))}>
              {roles.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
            <button type="button" onClick={() => void createUser()}>Create User</button>
          </div>
          <table style={{ width: "100%" }}>
            <thead><tr><th>User</th><th>Role</th><th>Reset</th></tr></thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}><td>{user.username}</td><td>{user.role}</td><td>{user.mustResetPassword ? "yes" : "no"}</td></tr>
              ))}
            </tbody>
          </table>
        </article>

        <article className="card">
          <h3>Warehouse Sites</h3>
          <div className="row-wrap">
            <input placeholder="site code" value={siteDraft.code} onChange={(event) => setSiteDraft((prev) => ({ ...prev, code: event.target.value }))} />
            <input placeholder="site name" value={siteDraft.name} onChange={(event) => setSiteDraft((prev) => ({ ...prev, name: event.target.value }))} />
            <input placeholder="timezone" value={siteDraft.timezone} onChange={(event) => setSiteDraft((prev) => ({ ...prev, timezone: event.target.value }))} />
            <label><input type="checkbox" checked={siteDraft.active} onChange={(event) => setSiteDraft((prev) => ({ ...prev, active: event.target.checked }))} /> Active</label>
            <button type="button" onClick={() => void saveSite()}>{siteDraft.id ? "Update Site" : "Create Site"}</button>
          </div>
          <table style={{ width: "100%" }}>
            <thead><tr><th>Code</th><th>Name</th><th>Timezone</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {sites.map((site) => (
                <tr key={site.id}>
                  <td>{site.code}</td>
                  <td>{site.name}</td>
                  <td>{site.timezone}</td>
                  <td>{site.active ? "active" : "inactive"}</td>
                  <td>
                    <button type="button" onClick={() => setSiteDraft({ id: site.id, code: site.code, name: site.name, timezone: site.timezone, active: site.active })}>Edit</button>
                    <button type="button" onClick={() => void removeSite(site.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <article className="card">
          <h3>Equipment Adapters</h3>
          <div className="row-wrap">
            <input placeholder="adapter key" value={adapterDraft.adapterKey} onChange={(event) => setAdapterDraft((prev) => ({ ...prev, adapterKey: event.target.value }))} />
            <input placeholder="display name" value={adapterDraft.displayName} onChange={(event) => setAdapterDraft((prev) => ({ ...prev, displayName: event.target.value }))} />
            <select value={adapterDraft.protocol} onChange={(event) => setAdapterDraft((prev) => ({ ...prev, protocol: event.target.value as EquipmentAdapterRecord["protocol"] }))}>
              <option value="rest">rest</option>
              <option value="mqtt">mqtt</option>
              <option value="opcua">opcua</option>
              <option value="file">file</option>
            </select>
            <input placeholder="endpoint" value={adapterDraft.endpoint} onChange={(event) => setAdapterDraft((prev) => ({ ...prev, endpoint: event.target.value }))} />
            <label><input type="checkbox" checked={adapterDraft.active} onChange={(event) => setAdapterDraft((prev) => ({ ...prev, active: event.target.checked }))} /> Active</label>
            <button type="button" onClick={() => void saveAdapter()}>{adapterDraft.id ? "Update Adapter" : "Create Adapter"}</button>
          </div>
          <table style={{ width: "100%" }}>
            <thead><tr><th>Key</th><th>Name</th><th>Protocol</th><th>Endpoint</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {adapters.map((adapter) => (
                <tr key={adapter.id}>
                  <td>{adapter.adapterKey}</td>
                  <td>{adapter.displayName}</td>
                  <td>{adapter.protocol}</td>
                  <td>{adapter.endpoint}</td>
                  <td>{adapter.active ? "active" : "inactive"}</td>
                  <td>
                    <button type="button" onClick={() => setAdapterDraft({
                      id: adapter.id,
                      adapterKey: adapter.adapterKey,
                      displayName: adapter.displayName,
                      protocol: adapter.protocol,
                      endpoint: adapter.endpoint,
                      active: adapter.active,
                    })}>Edit</button>
                    <button type="button" onClick={() => void removeAdapter(adapter.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <article className="card">
          <h3>Operational Templates</h3>
          <div className="row-wrap">
            <input placeholder="template key" value={templateDraft.templateKey} onChange={(event) => setTemplateDraft((prev) => ({ ...prev, templateKey: event.target.value }))} />
            <input placeholder="template name" value={templateDraft.name} onChange={(event) => setTemplateDraft((prev) => ({ ...prev, name: event.target.value }))} />
            <select value={templateDraft.workstream} onChange={(event) => setTemplateDraft((prev) => ({ ...prev, workstream: event.target.value as TaskWorkstream }))}>
              {workstreams.map((workstream) => (
                <option key={workstream} value={workstream}>{workstream}</option>
              ))}
            </select>
            <input placeholder="template content" value={templateDraft.content} onChange={(event) => setTemplateDraft((prev) => ({ ...prev, content: event.target.value }))} />
            <label><input type="checkbox" checked={templateDraft.active} onChange={(event) => setTemplateDraft((prev) => ({ ...prev, active: event.target.checked }))} /> Active</label>
            <button type="button" onClick={() => void saveTemplate()}>{templateDraft.id ? "Update Template" : "Create Template"}</button>
          </div>
          <table style={{ width: "100%" }}>
            <thead><tr><th>Key</th><th>Name</th><th>Workstream</th><th>Content</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {templates.map((template) => (
                <tr key={template.id}>
                  <td>{template.templateKey}</td>
                  <td>{template.name}</td>
                  <td>{template.workstream}</td>
                  <td>{template.content}</td>
                  <td>{template.active ? "active" : "inactive"}</td>
                  <td>
                    <button type="button" onClick={() => setTemplateDraft({
                      id: template.id,
                      templateKey: template.templateKey,
                      name: template.name,
                      workstream: template.workstream,
                      content: template.content,
                      active: template.active,
                    })}>Edit</button>
                    <button type="button" onClick={() => void removeTemplate(template.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <article className="card">
          <h3>Operational Parameters</h3>
          <div className="row-wrap">
            <input value={settingDraft.key} onChange={(event) => setSettingDraft((prev) => ({ ...prev, key: event.target.value }))} />
            <input value={settingDraft.value} onChange={(event) => setSettingDraft((prev) => ({ ...prev, value: event.target.value }))} />
            <button type="button" onClick={() => void saveSetting()}>Save Setting</button>
          </div>
          <ul>
            {settings.map((setting) => (
              <li key={setting.id}><code>{setting.key}</code>: {setting.value}</li>
            ))}
          </ul>
          <h4>JSON Runtime Config Import</h4>
          <div className="row-wrap">
            <input type="file" accept="application/json" onChange={(event) => setConfigFile(event.target.files?.[0] ?? null)} />
            <button type="button" onClick={() => void importConfig()}>Import Config</button>
          </div>
          {runtimeConfig ? <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(runtimeConfig, null, 2)}</pre> : null}
        </article>

        <article className="card">
          <h3>Permission Overrides</h3>
          <div className="row-wrap">
            <select value={overrideDraft.role} onChange={(event) => setOverrideDraft((prev) => ({ ...prev, role: event.target.value as UserRole }))}>
              {roles.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
            <input value={overrideDraft.scope} onChange={(event) => setOverrideDraft((prev) => ({ ...prev, scope: event.target.value }))} />
            <label><input type="checkbox" checked={overrideDraft.canRead} onChange={(event) => setOverrideDraft((prev) => ({ ...prev, canRead: event.target.checked }))} /> Read</label>
            <label><input type="checkbox" checked={overrideDraft.canWrite} onChange={(event) => setOverrideDraft((prev) => ({ ...prev, canWrite: event.target.checked }))} /> Write</label>
            <button type="button" onClick={() => void saveOverride()}>Save Override</button>
          </div>
          <ul>
            {overrides.map((override) => (
              <li key={override.id}>{override.role} / {override.scope} {"->"} R:{String(override.canRead)} W:{String(override.canWrite)}</li>
            ))}
          </ul>
        </article>

        <article className="card">
          <h3>Active Sessions</h3>
          <table style={{ width: "100%" }}>
            <thead><tr><th>User</th><th>Role</th><th>Started</th><th>Action</th></tr></thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>{session.username}</td>
                  <td>{session.role}</td>
                  <td>{new Date(session.createdAt).toLocaleString()}</td>
                  <td>{session.terminatedAt ? "terminated" : <button type="button" onClick={() => void terminateSession(session.id)}>Terminate</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </section>
    </main>
  );
}
