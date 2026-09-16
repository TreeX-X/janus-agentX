/**
 * Shared vocabulary for harness-note/1 (contract C1-C6).
 * Pure types and closed sets only. No IO, no parsing.
 */

export const NOTE_SCHEMA = 'harness-note/1' as const;
export const RECEIPT_SCHEMA = 'harness-receipt/1' as const;
export const BUNDLE_SCHEMA = 'harness-bundle/1' as const;
export const VIEW_SCHEMA = 'harness-view/1' as const;

export const NOTE_KINDS = ['idea', 'initiative', 'requirement', 'decision', 'task'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const LIFECYCLES = ['draft', 'proposed', 'accepted', 'rejected', 'archived', 'implemented'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export const NOTE_CLASSES = ['feature', 'bug-fix', 'architecture', 'process', 'testing', 'simplification'] as const;
export type NoteClass = (typeof NOTE_CLASSES)[number];

export const RELATION_TYPES = [
  'parent',
  'depends-on',
  'implements',
  'governed-by',
  'derived-from',
  'supersedes',
  'related-to',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** Relations that enter the task contract hash (C3). */
export const CONTRACT_RELATIONS: RelationType[] = ['implements', 'depends-on', 'governed-by'];

/** Sections that enter the task contract hash, per kind-agnostic fixed set (C3). */
export const CONTRACT_SECTIONS = ['Scope', 'Acceptance criteria', 'Verification'] as const;

export const EXECUTION_STATES = [
  'queued',
  'running',
  'verifying',
  'blocked',
  'paused',
  'done',
  'cancelled',
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const MODES = ['xdo', 'xdel', 'xflow'] as const;
export type HarnessMode = (typeof MODES)[number];

export const ERROR_CODES = [
  'UNSUPPORTED_SCHEMA',
  'SCHEMA_INVALID',
  'NOT_FOUND',
  'UNRESOLVED_REFERENCE',
  'INVALID_RELATION',
  'CONFLICT',
  'NOT_READY',
  'STALE_BASELINE',
  'DEPENDENCY_UNSATISFIED',
  'APPROVAL_REQUIRED',
  'PERMISSION_DENIED',
  'BUSY',
  'RECOVERY_REQUIRED',
  'IO_ERROR',
  'CAPABILITY_UNAVAILABLE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Diagnostic {
  code: ErrorCode;
  message: string;
  /** JSON-pointer-ish location, e.g. `relations[0].target`. */
  path?: string;
}

export const KNOWN_TOP_KEYS = [
  'schema',
  'id',
  'kind',
  'lifecycle',
  'created',
  'class',
  'tags',
  'parent',
  'relations',
  'repositories',
  'codeRefs',
  'work',
  'execution',
  'disposition',
  'extensions',
] as const;

export interface Relation {
  type: RelationType;
  target: string;
  criteria?: string[];
  scope?: 'full' | 'partial';
  reason?: string;
}

export interface CodeRef {
  repoId: string;
  path: string;
  symbol?: string;
  role: 'entry' | 'implementation' | 'test';
}

export interface WorkScope {
  repoId: string;
  paths: string[];
}

export interface AcceptanceRef {
  uri: string;
  criterionId: string;
}

export interface VerificationStep {
  id: string;
  kind: 'command' | 'manual';
  required: boolean;
  repoId: string;
  cwd: string;
  program?: string;
  args?: string[];
  description?: string;
}

export interface WorkContract {
  scope: WorkScope[];
  acceptanceRefs: AcceptanceRef[];
  verification: VerificationStep[];
}

export interface BaselineInput {
  uri: string;
  contentHash: string;
  criteria?: string[];
}

export interface TaskExecution {
  mode: HarnessMode;
  state: ExecutionState;
  baseline: { taskContractHash: string; inputs: BaselineInput[] };
  attempt: number;
  receipts: string[];
  closeout: 'commit-required' | 'working-tree-authorized';
  blocker?: { code: string; summary: string };
  authorizationRef?: string;
}

export interface HarnessNoteMeta {
  schema: typeof NOTE_SCHEMA;
  id: string;
  kind: NoteKind;
  lifecycle: Lifecycle;
  created: string;
  class?: NoteClass;
  tags?: string[];
  parent?: string;
  relations?: Relation[];
  repositories?: { primary?: string; related?: string[] };
  codeRefs?: CodeRef[];
  work?: WorkContract;
  execution?: TaskExecution;
  disposition?: { reason: string };
  extensions?: Record<string, unknown>;
}

export interface BodySection {
  name: string;
  /** Raw text between this H2 and the next H2/H1 (line-based slice, C3). */
  text: string;
}

export interface AcceptanceItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface ParsedNote {
  meta: HarnessNoteMeta;
  /** Top-level keys outside the known set. Preserved verbatim, never executed. */
  unknownFields: Record<string, unknown>;
  /** Frontmatter key order for stable re-serialization. */
  keyOrder: string[];
  title: string;
  sections: BodySection[];
  acs: AcceptanceItem[];
  /** Full body (everything after frontmatter), byte-preserved except EOL bookkeeping. */
  body: string;
  eol: '\n' | '\r\n';
  bom: boolean;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const NOTE_URI_RE = /^note:\/\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const AC_ID_RE = /^AC-\d+$/;

export function isNoteKind(v: unknown): v is NoteKind {
  return typeof v === 'string' && (NOTE_KINDS as readonly string[]).includes(v);
}

export function isLifecycle(v: unknown): v is Lifecycle {
  return typeof v === 'string' && (LIFECYCLES as readonly string[]).includes(v);
}
