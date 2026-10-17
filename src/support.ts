/**
 * support.ts — the support desk: one shared ticket queue behind the client's "Contact Support"
 * bottom sheet and the Admin Command Center's Inbox tab.
 *
 * The sheet is the writer, the Inbox is the reader, and this module is the only thing either of
 * them touches. A ticket is submitted with its category, message, timestamp and the sender's
 * Telegram id / username; the admin replies and resolves it here. The queue persists through the
 * same wrapped door as the save (`readJson` / `writeJson` in storage.ts), so a ticket survives a
 * reload exactly like a purchase does.
 *
 * It is deliberately a device-local store: the Mini App's support drawer never depends on a
 * backend being up, which is the same contract every other local feature keeps. The Worker can
 * own the same shape later — replacing `load` / `flush` with an async store is the whole port.
 */
import { readJson, writeJson } from './storage';

/** The three categories the client's sheet offers. */
export type TicketCategory = 'feedback' | 'bug' | 'stars';
export type TicketStatus = 'new' | 'replied' | 'resolved';

export interface Ticket {
  id: string;
  category: TicketCategory;
  message: string;
  /** Epoch ms — the client's send tap. */
  createdAt: number;
  /** Telegram user id as a string, or `device` for a browser without an identity. */
  userId: string;
  /** Telegram username (or first name), or '' when the client had neither. */
  username: string;
  status: TicketStatus;
  /** The admin's official reply, or '' before one is sent. */
  reply: string;
  repliedAt: number | null;
  resolvedAt: number | null;
}

/** What the sheet may say. Longer text is clipped, never refused. */
export const TICKET_MAX = 300;
/** What one admin reply may hold. */
export const REPLY_MAX = 400;
/** The queue is a desk, not an archive: the oldest tickets fall off past this. */
const MAX_TICKETS = 200;

const KEY = 'detour.support.v1';

const CATS: readonly TicketCategory[] = ['feedback', 'bug', 'stars'];
const STATUSES: readonly TicketStatus[] = ['new', 'replied', 'resolved'];

export const isTicketCategory = (v: unknown): v is TicketCategory =>
  typeof v === 'string' && (CATS as readonly string[]).includes(v);

const isStatus = (v: unknown): v is TicketStatus =>
  typeof v === 'string' && (STATUSES as readonly string[]).includes(v);

const whole = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

interface TicketBox {
  v: number;
  tickets: Ticket[];
}

let seq = 0;
/** `t` + time + a session counter: unique within a device without a backend to ask. */
function mintId(): string {
  return `t${Date.now().toString(36)}${(seq++).toString(36)}`;
}

/** A hand-edited or half-written blob is folded ticket by ticket, never trusted as it stands. */
function fold(raw: unknown): Ticket | null {
  const t = raw as Partial<Ticket> | null;
  if (!t || typeof t !== 'object') return null;
  const message = text(t.message, TICKET_MAX).trim();
  if (!message) return null;
  const category: TicketCategory = isTicketCategory(t.category) ? t.category : 'feedback';
  const status: TicketStatus = isStatus(t.status) ? t.status : 'new';
  return {
    id: text(t.id, 32) || mintId(),
    category,
    message,
    createdAt: whole(t.createdAt) ? t.createdAt : Date.now(),
    userId: text(t.userId, 32) || 'device',
    username: text(t.username, 32),
    status,
    reply: text(t.reply, REPLY_MAX).trim(),
    repliedAt: whole(t.repliedAt) ? t.repliedAt : null,
    resolvedAt: whole(t.resolvedAt) ? t.resolvedAt : null,
  };
}

function load(): Ticket[] {
  const box = readJson<TicketBox>(KEY);
  const rows = Array.isArray(box?.tickets) ? box.tickets : [];
  const out: Ticket[] = [];
  for (const row of rows) {
    const t = fold(row);
    if (t) out.push(t);
    if (out.length >= MAX_TICKETS) break;
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

let list: Ticket[] = load();

const watchers: (() => void)[] = [];

/** Fires after every accepted write, so the Inbox repaints the moment the queue moves. */
export function onTickets(w: () => void): () => void {
  watchers.push(w);
  return () => {
    const i = watchers.indexOf(w);
    if (i >= 0) watchers.splice(i, 1);
  };
}

function flush(): void {
  writeJson(KEY, { v: 1, tickets: list } satisfies TicketBox);
  for (const w of [...watchers]) {
    try {
      w();
    } catch {
      /* a watcher threw: the rest still get their turn */
    }
  }
}

export interface TicketInput {
  category: TicketCategory;
  message: string;
  userId: string;
  username: string;
}

/** The client's send tap. False when the message was blank — nothing enters the queue empty. */
export function submitTicket(input: TicketInput): Ticket | null {
  const message = text(input.message, TICKET_MAX).trim();
  if (!message) return null;
  const ticket: Ticket = {
    id: mintId(),
    category: isTicketCategory(input.category) ? input.category : 'feedback',
    message,
    createdAt: Date.now(),
    userId: text(input.userId, 32) || 'device',
    username: text(input.username, 32),
    status: 'new',
    reply: '',
    repliedAt: null,
    resolvedAt: null,
  };
  list = [ticket, ...list].slice(0, MAX_TICKETS);
  flush();
  return ticket;
}

/** The queue, newest first. The caller reads; only this module writes. */
export const tickets = (): readonly Ticket[] => list;

/** Tickets nobody has answered yet — the badge count on the Inbox tab. */
export const unreadCount = (): number => list.reduce((n, t) => n + (t.status === 'new' ? 1 : 0), 0);

export const ticketById = (id: string): Ticket | undefined => list.find((t) => t.id === id);

/** The admin's send tap: stores the resolution and moves the ticket to Replied. */
export function replyTicket(id: string, body: string): boolean {
  const t = ticketById(id);
  const reply = text(body, REPLY_MAX).trim();
  if (!t || !reply) return false;
  t.reply = reply;
  t.repliedAt = Date.now();
  if (t.status !== 'resolved') t.status = 'replied';
  list = [...list];
  flush();
  return true;
}

/** The admin's resolve toggle: closing keeps the reply; reopening falls back to its own state. */
export function toggleResolved(id: string): Ticket | null {
  const t = ticketById(id);
  if (!t) return null;
  if (t.status === 'resolved') {
    t.status = t.reply ? 'replied' : 'new';
    t.resolvedAt = null;
  } else {
    t.status = 'resolved';
    t.resolvedAt = Date.now();
  }
  list = [...list];
  flush();
  return t;
}

/** `5m ago` / `2h ago` / `3d ago`: the relative stamp on every ticket card. */
export function agoOf(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d ago` : new Date(ms).toISOString().slice(0, 10);
}
