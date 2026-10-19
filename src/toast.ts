export type ToastTone = 'success' | 'error' | 'warning';

let host: HTMLElement | null = null;

function hostEl(): HTMLElement {
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

export function showToast(message: string, tone: ToastTone = 'success', ms = 3200): void {
  const root = hostEl();
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.setAttribute('role', tone === 'error' ? 'alert' : 'status');

  const mark = document.createElement('span');
  mark.className = 'toast-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = tone === 'success' ? '✓' : tone === 'error' ? '!' : 'i';

  const copy = document.createElement('span');
  copy.className = 'toast-copy';
  copy.textContent = message;

  el.append(mark, copy);
  root.append(el);
  requestAnimationFrame(() => el.classList.add('in'));

  window.setTimeout(() => {
    el.classList.remove('in');
    window.setTimeout(() => el.remove(), 220);
  }, ms);
}
