import { useEffect, useState } from "react";

/**
 * Brief confirmation ("Link copied"). The live region stays mounted so screen readers announce
 * each message; the parent keys `ToastMessage` by message id, so every message restarts its timer.
 */
export function ToastRegion({ children }: { children?: React.ReactNode }) {
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {children}
    </div>
  );
}

export function ToastMessage({ text, onDone }: { text: string; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const fade = window.setTimeout(() => setLeaving(true), 2400);
    const done = window.setTimeout(onDone, 2700);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(done);
    };
  }, [onDone]);
  return (
    <p className="toast" data-leaving={leaving}>
      {text}
    </p>
  );
}
