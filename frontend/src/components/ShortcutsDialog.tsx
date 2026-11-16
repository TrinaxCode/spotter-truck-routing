import { useEffect, useRef } from "react";
import { SHORTCUTS } from "../lib/shortcuts";

/** Native modal dialog: focus moves in and back out, Escape closes it, the page behind is inert. */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="shortcuts" aria-labelledby="shortcuts-title" onClose={onClose}>
      <div className="shortcuts-head">
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <dl>
        {SHORTCUTS.map((item) => (
          <div key={item.label} className="shortcut-row">
            <dt>
              {item.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </dt>
            <dd>{item.label}</dd>
          </div>
        ))}
      </dl>
    </dialog>
  );
}
