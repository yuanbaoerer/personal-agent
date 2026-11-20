import type { ActionService } from "../actions/service.ts";
import type { PluginCatalog } from "./catalog.ts";
import type { PluginLifecycleResult, PluginView } from "./types.ts";

export interface ExtensionServiceDeps {
  catalog: PluginCatalog;
  actions: ActionService;
  now?: () => Date;
}

/**
 * Owner-facing lifecycle surface. It is deliberately separate from the model
 * Router: plugin enablement is an authenticated control-plane decision, not a
 * chat intent, and it invalidates pending approvals for the affected tools.
 */
export class ExtensionService {
  readonly #catalog: PluginCatalog;
  readonly #actions: ActionService;

  constructor(deps: ExtensionServiceDeps) {
    this.#catalog = deps.catalog;
    this.#actions = deps.actions;
  }

  list(): Promise<PluginView[]> {
    return this.#catalog.list();
  }

  get(id: string): Promise<PluginView | undefined> {
    return this.#catalog.get(id);
  }

  async enable(id: string, actorId: string): Promise<PluginLifecycleResult> {
    return this.#setEnabled(id, true, actorId);
  }

  async disable(id: string, actorId: string): Promise<PluginLifecycleResult> {
    return this.#setEnabled(id, false, actorId);
  }

  /**
   * OAuth login/logout/account switch. The tool set is unchanged, but every
   * approval issued under the old credential must be revoked.
   */
  async credentialChanged(
    id: string,
    actorId: string,
  ): Promise<{ generation: number; revokedActions: number; inFlightActions: number }> {
    const generation = this.#catalog.rotateCredential(id, actorId);
    const plugin = await this.#catalog.get(id);
    if (plugin === undefined) {
      throw new Error(`unknown plugin: ${id}`);
    }
    const revoked = this.#actions.revokePendingForTools(
      plugin.tools,
      `plugin_credential_changed:${id}`,
    );
    return {
      generation,
      revokedActions: revoked.superseded,
      inFlightActions: revoked.inFlight,
    };
  }

  async #setEnabled(
    id: string,
    enabled: boolean,
    actorId: string,
  ): Promise<PluginLifecycleResult> {
    const change = await this.#catalog.setEnabled(id, enabled, actorId);
    if (!change.changed) {
      return {
        changed: false,
        generation: change.generation,
        plugin: change.plugin,
        addedTools: [],
        removedTools: [],
        revokedActions: 0,
        inFlightActions: 0,
      };
    }

    let revokedActions = 0;
    let inFlightActions = 0;
    if (!enabled) {
      const tools = [
        ...new Set([
          ...change.removedTools,
          ...change.plugin.tools,
        ]),
      ];
      const revoked = this.#actions.revokePendingForTools(
        tools,
        `plugin_disabled:${id}`,
      );
      revokedActions = revoked.superseded;
      inFlightActions = revoked.inFlight;
    }
    return {
      changed: change.changed,
      generation: change.generation,
      plugin: change.plugin,
      addedTools: change.addedTools,
      removedTools: change.removedTools,
      revokedActions,
      inFlightActions,
    };
  }
}
