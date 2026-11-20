import type {
  Mandate,
  SkillBinding,
  SkillRejection,
  TaskExtensionBinding,
} from "../domain/types.ts";
import type { CapabilityView } from "./fence.ts";

/** Metadata exposed without loading the skill body. */
export interface SkillMetadata {
  id: string;
  version: string;
  digest: string;
  description: string;
  plugins: string[];
  permissions: string[];
  priority: number;
}

export interface SkillDocument extends SkillMetadata {
  body: string;
}

export interface SkillSelectionInput {
  mandate: Mandate;
  /** Plugin identity pinned on the task revision. */
  plugins: readonly TaskExtensionBinding[];
  capabilities: CapabilityView;
}

export interface SkillSelectionResult {
  skills: SkillBinding[];
  rejected: SkillRejection[];
}

export interface SkillLoadResult {
  skills: SkillDocument[];
  rejected: SkillRejection[];
}

/**
 * Host-injected skill loader. The Core never executes skill files; it only
 * indexes metadata and injects bounded guidance after re-verifying the pinned
 * digest and plugin dependencies.
 */
export interface SkillRuntime {
  list(): SkillMetadata[];
  select(input: SkillSelectionInput): SkillSelectionResult;
  load(
    bindings: readonly SkillBinding[],
    enabledPlugins: readonly string[],
  ): SkillLoadResult;
}
