/**
 * schema.ts — the single source of truth for the data model.
 *
 * Two families of types live here:
 *   1. Config / taxonomy (what the user defines): categories, projects, paths.
 *   2. The parse result (what the pipeline produces): the per-day structured
 *      document that the visualizations consume and the overrides layer mirrors.
 *
 * Runtime shapes are validated with zod so a malformed daily JSON (hand-edited
 * override, corrupted file, schema drift) is caught at the boundary instead of
 * blowing up deep inside a renderer.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ taxonomy */

/** A category spec. `labels` makes it vocab-typed; `proj` makes it project-typed. */
export const CategorySpec = z.object({
  hint: z.string().default(""),
  labels: z.array(z.string()).optional(),
  label_hints: z.record(z.string()).optional(),
  fallback_label: z.string().optional(),
  proj: z.boolean().optional(),
});
export type CategorySpec = z.infer<typeof CategorySpec>;

/** A taxonomy value can be the full spec or a bare hint string (shorthand). */
export const Taxonomy = z.record(z.union([CategorySpec, z.string()]));
export type Taxonomy = z.infer<typeof Taxonomy>;

export const Project = z.object({
  name: z.string(),
  label: z.string().default(""),
  aliases: z.array(z.string()).optional(),
  status: z.enum(["active", "archived"]).default("active"),
});
export type Project = z.infer<typeof Project>;

export const Categories = z.object({
  time_categories: Taxonomy,
  expense_categories: Taxonomy,
});
export type Categories = z.infer<typeof Categories>;

/* -------------------------------------------------------------- parse result */

export const Block = z.object({
  start: z.string(),
  end: z.string().nullable(), // null = open block (in progress)
  label: z.string(),
  category: z.string(),
  detail: z.string().default(""),
  proj: z.string().default(""),
  background: z.boolean().default(false),
  inferred: z.boolean().default(false),
  confidence: z.enum(["high", "medium", "low"]).default("high"),
  open_end: z.boolean().default(false),
  note: z.string().default(""),
  attachments: z.array(z.string()).default([]),
});
export type Block = z.infer<typeof Block>;

export const Expense = z.object({
  time: z.string().nullable(),
  amount: z.number(),
  item: z.string().default(""),
  category: z.string(),
  sub: z.string().default(""),
  type: z.enum(["支出", "收入"]).default("支出"),
  channel: z.string().nullable().default(null),
});
export type Expense = z.infer<typeof Expense>;

export const EventPoint = z.object({
  time: z.string(),
  label: z.string(),
  category: z.string(),
  note: z.string().default(""),
});
export type EventPoint = z.infer<typeof EventPoint>;

export const PresenceNote = z.object({
  time: z.string(),
  text: z.string(),
});

export const Presence = z.object({
  person: z.string(),
  start: z.string(),
  end: z.string().nullable(),
  open_end: z.boolean().default(false),
  notes: z.array(PresenceNote).default([]),
});
export type Presence = z.infer<typeof Presence>;

export const DayResult = z.object({
  date: z.string(),
  generated_at: z.string().optional(),
  blocks: z.array(Block).default([]),
  presence: z.array(Presence).default([]),
  events: z.array(EventPoint).default([]),
  expenses: z.array(Expense).default([]),
  daily_total: z.number().default(0),
  daily_income: z.number().default(0),
  open_end: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  override_present: z.boolean().optional(),
});
export type DayResult = z.infer<typeof DayResult>;

/* ----------------------------------------------------- raw LLM output (loose) */

/**
 * What the model is asked to return. Boundaries are entry indices, sentinels,
 * or literal/cross-day time strings — never wall-clock the model invented from
 * nothing. `start`/`end` therefore widen to `number | string`. Validation in
 * the parser turns this into the strict `DayResult` above.
 */
export interface LlmBlock {
  start: number | string;
  end: number | string;
  src?: number;
  label?: string;
  category?: string;
  detail?: string;
  proj?: string;
  background?: boolean;
  inferred?: boolean;
  confidence?: "high" | "medium" | "low";
}

export interface LlmExpense {
  entry?: number;
  amount: number | string;
  item?: string;
  category?: string;
  sub?: string;
  type?: string;
  channel?: string | null;
}

export interface LlmEvent {
  entry?: number;
  label?: string;
  category?: string;
}

export interface LlmPresence {
  person?: string;
  start: number | string;
  end: number | string;
  notes?: { entry?: number; text?: string }[];
}

export interface LlmOutput {
  blocks: LlmBlock[];
  expenses?: LlmExpense[];
  events?: LlmEvent[];
  presence?: LlmPresence[];
}

/* ---------------------------------------------------------------- pipeline io */

/** A single parsed log line: index, timestamp, and accumulated content. */
export interface Entry {
  i: number;
  t: string; // "HH:MM:SS"
  sec: number;
  c: string;
}

/** Runtime config consumed by the pure parser (paths/IO live in the plugin). */
export interface ParseConfig {
  time_categories: Taxonomy;
  expense_categories: Taxonomy;
  projects: Project[];
  fallback_category: string;
}
