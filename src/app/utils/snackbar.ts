// Text-only snackbar with the same API and markup as node-snackbar 0.1.x,
// whose styles are still bundled from node_modules (see styles.scss).
//
// The app used to load node-snackbar's script from jsDelivr as `@latest`,
// which let whoever controls that npm package run code on every Kept
// origin, and the library wrote its text with innerHTML. This keeps the
// visible behaviour and writes every caller-supplied string as text.

export interface SnackbarOptions {
  text?: string;
  textColor?: string;
  width?: string;
  showAction?: boolean;
  actionText?: string;
  actionTextAria?: string;
  alertScreenReader?: boolean;
  actionTextColor?: string;
  showSecondButton?: boolean;
  secondButtonText?: string;
  secondButtonAria?: string;
  secondButtonTextColor?: string;
  backgroundColor?: string;
  pos?: string;
  duration?: number;
  customClass?: string;
  onActionClick?: (element: HTMLElement) => void;
  onSecondButtonClick?: (element: HTMLElement) => void;
  onClose?: (element: HTMLElement) => void;
}

type Resolved = Required<SnackbarOptions>;

const defaults: Resolved = {
  text: 'Default Text',
  textColor: '#FFFFFF',
  width: 'auto',
  showAction: true,
  actionText: 'Dismiss',
  actionTextAria: 'Dismiss, Description for Screen Readers',
  alertScreenReader: false,
  actionTextColor: '#4CAF50',
  showSecondButton: false,
  secondButtonText: '',
  secondButtonAria: 'Description for Screen Readers',
  secondButtonTextColor: '#4CAF50',
  backgroundColor: '#323232',
  pos: 'bottom-left',
  duration: 5000,
  customClass: '',
  onActionClick: element => { element.style.opacity = '0'; },
  onSecondButtonClick: () => {},
  onClose: () => {}
};

function button(label: unknown, aria: string, color: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.className = 'action';
  element.textContent = String(label ?? '');
  element.setAttribute('aria-label', aria);
  element.style.color = color;
  element.addEventListener('click', onClick);
  return element;
}

export const Snackbar = {
  current: null as HTMLElement | null,

  show(input: SnackbarOptions = {}): void {
    const options = { ...defaults } as Resolved;
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) (options as any)[key] = value;
    }

    const previous = Snackbar.current;
    if (previous) {
      previous.style.opacity = '0';
      setTimeout(() => previous.parentElement?.removeChild(previous), 500);
    }

    const snackbar = document.createElement('div');
    snackbar.className = 'snackbar-container ' + options.customClass;
    snackbar.style.width = options.width;
    snackbar.style.background = options.backgroundColor;

    const text = document.createElement('p');
    text.style.margin = '0';
    text.style.padding = '0';
    text.style.color = options.textColor;
    text.style.fontSize = '14px';
    text.style.fontWeight = '300';
    text.style.lineHeight = '1em';
    text.textContent = String(options.text ?? '');
    snackbar.appendChild(text);

    if (options.showSecondButton) {
      snackbar.appendChild(button(options.secondButtonText, options.secondButtonAria, options.secondButtonTextColor,
        () => options.onSecondButtonClick(snackbar)));
    }
    if (options.showAction) {
      snackbar.appendChild(button(options.actionText, options.actionTextAria, options.actionTextColor,
        () => options.onActionClick(snackbar)));
    }

    if (options.duration) {
      setTimeout(() => {
        if (Snackbar.current !== snackbar) return;
        snackbar.style.opacity = '0';
        // Slide out the way node-snackbar does when it closes on its own.
        snackbar.style.top = '-100px';
        snackbar.style.bottom = '-100px';
      }, options.duration);
    }

    if (options.alertScreenReader) snackbar.setAttribute('role', 'alert');

    snackbar.addEventListener('transitionend', event => {
      if (event.propertyName !== 'opacity' || snackbar.style.opacity !== '0') return;
      options.onClose(snackbar);
      snackbar.parentElement?.removeChild(snackbar);
      if (Snackbar.current === snackbar) Snackbar.current = null;
    });

    Snackbar.current = snackbar;
    document.body.appendChild(snackbar);
    // Read layout once so the opacity change below animates, as the original did.
    void getComputedStyle(snackbar).bottom;
    snackbar.style.opacity = '1';
    snackbar.className = 'snackbar-container ' + options.customClass + ' snackbar-pos ' + options.pos;
  },

  close(): void {
    if (Snackbar.current) Snackbar.current.style.opacity = '0';
  }
};

// Existing callers use the global `Snackbar` (declare var / window.Snackbar).
export function installSnackbar(target: any = globalThis): void {
  target.Snackbar = Snackbar;
}
