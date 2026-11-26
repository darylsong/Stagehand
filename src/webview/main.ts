export interface ViewState {
  branch?: string;
}

export function render(root: HTMLElement, state: ViewState): void {
  root.innerHTML = '';
  const p = document.createElement('p');
  p.append('Current branch: ');
  const b = document.createElement('span');
  b.id = 'branch';
  b.textContent = state.branch ?? '(detached)';
  p.append(b);
  root.append(p);
}

// The extension (or a test) sends state via postMessage; standalone it renders a placeholder.
const app = document.getElementById('app');
if (app) {
  render(app, { branch: 'main' });
  window.addEventListener('message', (e: MessageEvent<ViewState>) => render(app, e.data));
}
