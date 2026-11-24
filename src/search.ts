import { opensearch, parseTitleInput } from './wiki';

/**
 * Wires a text input to opensearch autocomplete. `onPick` receives a title
 * (the input also accepts full Wikipedia URLs).
 */
export function attachSearch(form: HTMLFormElement, onPick: (title: string) => void): void {
  const input = form.querySelector('input')!;
  const list = document.createElement('ul');
  list.className = 'suggestions';
  list.setAttribute('role', 'listbox');
  list.id = `${input.id || 'search'}-list`;
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('autocomplete', 'off');
  form.appendChild(list);

  let items: string[] = [];
  let active = -1;
  let timer: number | undefined;
  let ctrl: AbortController | undefined;

  const render = () => {
    list.replaceChildren(
      ...items.map((t, i) => {
        const li = document.createElement('li');
        li.textContent = t;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        li.addEventListener('mousedown', (e) => {
          e.preventDefault(); // keep focus; fire before blur
          pick(t);
        });
        return li;
      }),
    );
    list.hidden = items.length === 0;
  };

  const close = () => {
    items = [];
    active = -1;
    render();
  };

  const pick = (t: string) => {
    input.value = t;
    close();
    input.blur();
    onPick(t);
  };

  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    const q = input.value.trim();
    if (!q || /^https?:/i.test(q)) return close();
    timer = window.setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        items = await opensearch(q, ctrl.signal);
        active = -1;
        render();
      } catch {
        /* aborted or offline */
      }
    }, 150);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      // Cycle through -1 (the typed text) and each suggestion.
      const n = items.length;
      if (e.key === 'ArrowDown') active = active + 1 >= n ? -1 : active + 1;
      else active = active - 1 < -1 ? n - 1 : active - 1;
      render();
    } else if (e.key === 'Escape') {
      close();
    }
  });

  input.addEventListener('blur', () => window.setTimeout(close, 100));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const chosen = active >= 0 ? items[active] : parseTitleInput(input.value);
    if (chosen) pick(chosen);
  });

  render();
}
