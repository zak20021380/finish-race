/**
 * postchat.ts — the closed vocabulary of the post-match capsule.
 *
 * A free player can still talk after the verdict, but only in these four lines. They travel the
 * wire as an ID, never as text: the sender picks the tile, the receiver renders it out of its own
 * table in its own language, and a hand-crafted frame therefore cannot smuggle a string onto a
 * rival's screen. That is the whole reason the IDs exist — the VIP gate is what makes a custom
 * line possible at all, and this table is what keeps "no VIP" from meaning "no voice".
 *
 * `en` is the canonical spelling, kept for two jobs only: it is the fallback copy when a language
 * table has not caught up, and it is what a client that shipped before the IDs still sends. The
 * room maps such a line back to its ID rather than relaying the text, so an old client degrades
 * to the same closed set instead of losing its voice.
 */
export type PostChatPresetId = 'gg' | 'rematch' | 'luck' | 'wp';

export interface PostChatPreset {
  id: PostChatPresetId;
  /** Canonical English line — the fallback copy and the legacy wire spelling. */
  en: string;
}

/** The four tiles, in the order the drawer paints them: control, challenge, critique, pressure. */
export const POST_CHAT_PRESETS: readonly PostChatPreset[] = [
  { id: 'gg', en: 'Calculated. ♟️' },
  { id: 'rematch', en: 'Run it back. ⚔️' },
  { id: 'luck', en: 'Fatal error. ⚡' },
  { id: 'wp', en: 'Close call. 🎯' },
];

/**
 * One post-match line as it travels. Exactly one of the two fields is set: `preset` for the closed
 * vocabulary, `text` for a VIP custom line. Both the socket and the capsule's own sender speak
 * this shape, so there is one place to look when asking "what can cross this wire?".
 */
export interface PostChatLine {
  preset?: PostChatPresetId;
  text?: string;
}

const PRESET_IDS = new Set<string>(POST_CHAT_PRESETS.map((p) => p.id));

/**
 * The five faces of the free tray, in the order it paints them.
 *
 * They matter to the room as much as to the UI: a reaction travels as a pictograph-only line,
 * which is technically a custom text, and a free seat may not send those. So this table is the
 * other half of the gate — a line that is exactly one of these five says nothing a machine could
 * abuse, and the room relays it from any seat. Anything else needs an entitlement. Keeping the
 * list here is what stops the tray and the gate from drifting apart.
 */
export const POST_CHAT_FREE_REACTIONS: readonly string[] = ['🤝', '🔥', '💀', '⚡', '🧠'];

/** A line that is exactly one of the free faces — the only "text" a free seat may broadcast. */
export const isPostChatFreeReaction = (text: string): boolean =>
  POST_CHAT_FREE_REACTIONS.includes(text);

/** A payload that names one of our four lines, or nothing. */
export const isPostChatPreset = (raw: unknown): raw is PostChatPresetId =>
  typeof raw === 'string' && PRESET_IDS.has(raw);

/** The canonical text for an ID, or '' when the ID is not one of ours. */
export function postChatPresetText(raw: unknown): string {
  if (!isPostChatPreset(raw)) return '';
  return POST_CHAT_PRESETS.find((p) => p.id === raw)?.en ?? '';
}

/**
 * The inverse of the table: which tile a raw line is. Only a legacy sender needs this — anything
 * that is not one of the four is a custom line, and a custom line needs VIP.
 */
export function postChatPresetForText(text: string): PostChatPresetId | null {
  return POST_CHAT_PRESETS.find((p) => p.en === text)?.id ?? null;
}
