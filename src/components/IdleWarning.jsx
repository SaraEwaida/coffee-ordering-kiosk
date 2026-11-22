import React, { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';

/**
 * Inactivity timeout.
 *
 * An unattended kiosk must not leave one customer's order on screen for the
 * next person. After the configured idle period it warns, counts down, and
 * then clears the session.
 *
 * The warning is deliberately interruptible: any touch anywhere cancels it. A
 * kiosk that discards a half-built order because someone paused to read is
 * worse than one that waits a little longer.
 */
const WARNING_SECONDS = 15;

export default function IdleWarning({ t, lang, timeoutSeconds = 60, onTimeout }) {
  const [remaining, setRemaining] = useState(null);
  const lastActivity = useRef(Date.now());

  useEffect(() => {
    const markActive = () => {
      lastActivity.current = Date.now();
      setRemaining(null);
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    for (const event of events) window.addEventListener(event, markActive, { passive: true });

    const tick = setInterval(() => {
      const idleSeconds = (Date.now() - lastActivity.current) / 1000;
      const untilTimeout = timeoutSeconds - idleSeconds;
      if (untilTimeout <= 0) {
        setRemaining(null);
        onTimeout();
        lastActivity.current = Date.now();
      } else if (untilTimeout <= WARNING_SECONDS) {
        setRemaining(Math.ceil(untilTimeout));
      }
    }, 1000);

    return () => {
      for (const event of events) window.removeEventListener(event, markActive);
      clearInterval(tick);
    };
  }, [timeoutSeconds, onTimeout]);

  if (remaining === null) return null;

  return (
    <div className="idle-overlay" role="alertdialog" aria-live="assertive">
      <div className="idle-card">
        <Clock size={48} />
        <h2>{t.stillThere}</h2>
        <p>{t.idleWarning.replace('{n}', remaining)}</p>
        <button className="primary-button" onClick={() => { /* the listener resets it */ }}>
          {t.continueOrder}
        </button>
      </div>
    </div>
  );
}
