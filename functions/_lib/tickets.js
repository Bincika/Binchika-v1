// Ticketed enquiries, phase 1 (session 78; docs/TICKETED-INQUIRIES-DESIGN.md). No AI. References BIN-YYMM-NNNN, issued
// by /api/contact before the owner copy is sent; the ticket row is written once the Inbox copy exists. Tickets carry
// no personal data (D1 migration 0007). Shared by the API and tests.

export const TICKET_STATUSES = ["new", "in_progress", "answered", "closed"];
export const TICKET_DUE_WORKING_DAYS = 2;   // proposed in the design; an owner decision may change it
export const RESOLUTION_MAX = 500;
export const REF_RE = /^BIN-\d{4}-\d{4,}$/;

const LAGOS_MS = 60 * 60 * 1000;            // West Africa Time is UTC+1 all year (no daylight saving)
const lagos = (d) => new Date(d.getTime() + LAGOS_MS);

/** "2611" for a time in November 2026, Lagos time. */
export const yymmOf = (d = new Date()) => { const l = lagos(d); return `${String(l.getUTCFullYear()).slice(2)}${String(l.getUTCMonth() + 1).padStart(2, "0")}`; };
export const refOf = (yymm, n) => `BIN-${yymm}-${String(n).padStart(4, "0")}`;

/** The same time of day, N working days (Monday to Friday, Lagos time) later. Public holidays are not counted yet. */
export function dueAfter(d = new Date(), days = TICKET_DUE_WORKING_DAYS) {
  const t = lagos(d);
  let left = days;
  while (left > 0) {
    t.setUTCDate(t.getUTCDate() + 1);
    const wd = t.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return new Date(t.getTime() - LAGOS_MS);
}

/** Reserve the next reference for this month. One atomic statement, so two enquiries can never share a number. */
export async function nextRef(db, now = new Date()) {
  const yymm = yymmOf(now);
  const row = await db.prepare("INSERT INTO ticket_counters (yymm, n) VALUES (?1, 1) ON CONFLICT (yymm) DO UPDATE SET n = n + 1 RETURNING n").bind(yymm).first();
  return refOf(yymm, row.n);
}

/** Write the ticket for an issued reference. mailId may be null if the Inbox copy could not be stored. */
export async function openTicket(db, { ref, mailId = null, nature, mailbox, now = new Date() }) {
  await db.prepare("INSERT INTO tickets (ref, mail_id, nature, mailbox, due_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)")
    .bind(ref, mailId, nature, mailbox, dueAfter(now).toISOString(), now.toISOString()).run();
}

/** List for the dashboard: newest first, optionally one status; open tickets past due are flagged. */
export async function listTickets(db, { status = null, limit = 100, now = new Date() } = {}) {
  const where = TICKET_STATUSES.includes(status) ? "WHERE status = ?1" : "";
  const sql = `SELECT ref, mail_id, nature, mailbox, status, owner_seat, resolution, due_at, created_at, updated_at, closed_at FROM tickets ${where} ORDER BY created_at DESC LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 200)}`;
  const { results } = await (where ? db.prepare(sql).bind(status) : db.prepare(sql)).all();
  const counts = await db.prepare("SELECT status, COUNT(*) AS n FROM tickets GROUP BY status").all();
  const iso = now.toISOString();
  return {
    tickets: (results ?? []).map((t) => ({ ...t, overdue: t.status !== "answered" && t.status !== "closed" && t.due_at < iso })),
    counts: Object.fromEntries((counts.results ?? []).map((r) => [r.status, r.n])),
  };
}

/**
 * Change a ticket's status and/or resolution note. The person acting is recorded by public ID only.
 * @returns {{ status: number, body: object }}
 */
export async function updateTicket(db, ref, { status, resolution } = {}, actorPublicId, now = new Date()) {
  if (!REF_RE.test(String(ref ?? ""))) return { status: 400, body: { error: "invalid reference" } };
  if (status !== undefined && !TICKET_STATUSES.includes(status)) return { status: 422, body: { error: `status must be one of ${TICKET_STATUSES.join(", ")}` } };
  if (resolution !== undefined && (typeof resolution !== "string" || resolution.length > RESOLUTION_MAX)) return { status: 422, body: { error: `resolution must be text of at most ${RESOLUTION_MAX} characters` } };
  if (status === undefined && resolution === undefined) return { status: 400, body: { error: "nothing to change" } };
  const cur = await db.prepare("SELECT status FROM tickets WHERE ref = ?1").bind(ref).first();
  if (!cur) return { status: 404, body: { error: "not found" } };
  const next = status ?? cur.status;
  const closedAt = next === "closed" ? (cur.status === "closed" ? undefined : now.toISOString()) : null;
  await db.prepare(`UPDATE tickets SET status = ?2, resolution = COALESCE(?3, resolution), owner_seat = COALESCE(?4, owner_seat), updated_at = ?5${closedAt === undefined ? "" : ", closed_at = ?6"} WHERE ref = ?1`)
    .bind(...[ref, next, resolution === undefined ? null : resolution.trim() || null, actorPublicId ?? null, now.toISOString(), ...(closedAt === undefined ? [] : [closedAt])]).run();
  const t = await db.prepare("SELECT ref, status, owner_seat, resolution, due_at, created_at, updated_at, closed_at FROM tickets WHERE ref = ?1").bind(ref).first();
  return { status: 200, body: { ok: true, ticket: t } };
}
