export type ToastTone = 'success' | 'error' | 'warning';

let host: HTMLElement | null = null;

function hostEl(): HTMLElement | null {
  if (host && document.contains(host)) return host;
  host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

function markFor(tone: ToastTone): string {
  return tone === 'success' ? '✓' : tone === 'error' ? '!' : 'i';
}

function mount(tone: ToastTone, ms: number): { el: HTMLElement; copy: HTMLElement } | null {
  const root = hostEl();
  if (!root) return null;
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.setAttribute('role', tone === 'error' ? 'alert' : 'status');

  const mark = document.createElement('span');
  mark.className = 'toast-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = markFor(tone);

  const copy = document.createElement('span');
  copy.className = 'toast-copy';

  el.append(mark, copy);
  root.append(el);
  requestAnimationFrame(() => el.classList.add('in'));

  window.setTimeout(() => {
    el.classList.remove('in');
    window.setTimeout(() => el.remove(), 220);
  }, ms);
  return { el, copy };
}

export function showToast(message: string, tone: ToastTone = 'success', ms = 3200): void {
  const toast = mount(tone, ms);
  if (!toast) return;
  toast.copy.textContent = message;
}

/**
 * The ceremonial toast: obsidian glass, one gold rim, an engraved mark and the copy.
 * Used where a reading has to explain itself, or where a rule must refuse with dignity.
 * It rides the shared host but never stacks: the newest royal toast replaces the last.
 */
export function showRoyalToast(
  title: string,
  body: string,
  icon = 'i-shield',
  ms = 4200,
): void {
  const root = hostEl();
  if (!root) return;
  for (const old of root.querySelectorAll('.toast-royal')) old.remove();

  const el = document.createElement('div');
  el.className = 'toast toast-royal is-rich';
  el.setAttribute('role', 'status');

  const mark = document.createElement('span');
  mark.className = 'toast-mark toast-medallion';
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#${icon}" /></svg>`;

  const copy = document.createElement('span');
  copy.className = 'toast-copy toast-detail';
  const lang = (document.documentElement.getAttribute('data-lang') || '').toLowerCase();
  if (lang === 'fa' || lang === 'ar') copy.setAttribute('dir', 'rtl');

  if (title) {
    const head = document.createElement('span');
    head.className = 'toast-title';
    head.textContent = title;
    copy.append(head);
  }
  const line = document.createElement('span');
  line.className = 'toast-body';
  line.textContent = body;
  copy.append(line);

  el.append(mark, copy);
  root.append(el);
  requestAnimationFrame(() => el.classList.add('in'));

  window.setTimeout(() => {
    el.classList.remove('in');
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 260);
  }, ms);
}

/**
 * The canonical toast, with a second line of guidance under the headline. Used where the
 * message is not just an acknowledgement but an instruction — the room code, for instance,
 * says what to do with the number that was just copied.
 *
 * The copy block carries its own direction, so a Persian sentence keeps its RTL base and
 * its punctuation while the numerals inside it stay readable. Long guidance wraps inside
 * the toast instead of widening the shell on a 320px screen.
 */
export function showToastDetail(
  title: string,
  body: string,
  tone: ToastTone = 'success',
  ms = 4200,
): void {
  const toast = mount(tone, ms);
  if (!toast) return;
  toast.el.classList.add('is-rich');
  toast.copy.classList.add('toast-detail');

  const head = document.createElement('span');
  head.className = 'toast-title';
  head.textContent = title;

  const line = document.createElement('span');
  line.className = 'toast-body';
  line.textContent = body;

  const lang = (document.documentElement.getAttribute('data-lang') || '').toLowerCase();
  if (lang === 'fa' || lang === 'ar') toast.copy.setAttribute('dir', 'rtl');

  toast.copy.append(head, line);
}
