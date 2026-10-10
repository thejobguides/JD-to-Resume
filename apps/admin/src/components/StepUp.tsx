import { useEffect, useRef, useState } from 'react';
import { post, registerStepUp } from '../api';
import { Button, ErrorBox, Field, inputCls, Modal } from './ui';

/** Re-authentication for dangerous actions (admin-panel.md §4.1): a fresh email code within 10 minutes. */
export function StepUpHost() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  useEffect(() => {
    registerStepUp(
      () =>
        new Promise<void>((resolve, reject) => {
          pending.current = { resolve, reject };
          setOpen(true);
          setError(null);
          setCode('');
          setHint(null);
          post<{ dev_code?: string }>('/auth/step-up/request').then((r) => setHint(r.dev_code ?? null)).catch(setError);
        }),
    );
  }, []);

  const verify = async () => {
    try {
      await post('/auth/step-up/verify', { code });
      setOpen(false);
      pending.current?.resolve();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Modal
      open={open}
      title="Confirm it's you"
      onClose={() => {
        setOpen(false);
        pending.current?.reject(new Error('Step-up cancelled'));
      }}
    >
      <p className="mb-3 text-sm text-slate-600">This action is sensitive. We emailed you a 6-digit code.</p>
      {hint && <p className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800">Development: code {hint}</p>}
      <ErrorBox error={error} />
      <Field label="Code">
        <input className={inputCls} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && void verify()} autoFocus />
      </Field>
      <div className="flex justify-end">
        <Button disabled={code.length !== 6} onClick={verify}>Confirm</Button>
      </div>
    </Modal>
  );
}
