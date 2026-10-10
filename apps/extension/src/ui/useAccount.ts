import type { MeResponse, PublicConfig, UsageResponse } from '@jmo/shared';
import { DEFAULT_PLAN_LIMITS } from '@jmo/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import type { ByokSettings } from '../lib/engine';
import * as store from '../lib/store';

export type AiMode =
  | { kind: 'hosted' }
  | { kind: 'byok'; settings: ByokSettings }
  | { kind: 'local'; reason: 'signed_out' | 'paused' | 'needs_key' | 'offline' };

export interface Account {
  loading: boolean;
  signedIn: boolean;
  email: string | null;
  me: MeResponse | null;
  usage: UsageResponse | null;
  byok: ByokSettings | null;
  config: PublicConfig | null;
  mode: AiMode;
  offline: boolean;
  reload: () => Promise<void>;
}

/** Who does the AI work: our API, the user's own key (BYOK plan), or nobody (on-device deterministic features only). */
export function aiMode(me: MeResponse | null, byok: ByokSettings | null, config: PublicConfig | null, offline: boolean): AiMode {
  if (me?.plan === 'byok_annual') return byok?.enabled && byok.key ? { kind: 'byok', settings: byok } : { kind: 'local', reason: 'needs_key' };
  if (!me) return { kind: 'local', reason: offline ? 'offline' : 'signed_out' };
  if (config?.kill_switches.hosted_ai || !DEFAULT_PLAN_LIMITS[me.plan].hosted_ai) return { kind: 'local', reason: 'paused' };
  return { kind: 'hosted' };
}

export function useAccount(): Account {
  const [state, setState] = useState<Omit<Account, 'reload' | 'mode'>>({ loading: true, signedIn: false, email: null, me: null, usage: null, byok: null, config: null, offline: false });
  // Reloads overlap (sign-out, refresh and settings changes each trigger one); only the newest may update state,
  // otherwise a slow earlier reload could show "signed in" again after a sign-out.
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const apply = (s: Omit<Account, 'reload' | 'mode'>) => {
      if (mine === seq.current) setState(s);
    };
    const [session, byok, config] = await Promise.all([api.getSession(), store.get<ByokSettings>('byok').catch(() => null), api.config().catch(() => null)]);
    if (!session) {
      apply({ loading: false, signedIn: false, email: null, me: null, usage: null, byok, config, offline: false });
      return;
    }
    try {
      const [me, usage] = await Promise.all([api.me(), api.usage().catch(() => null)]);
      apply({ loading: false, signedIn: true, email: session.email, me, usage, byok, config, offline: false });
    } catch (e) {
      const offline = e instanceof api.ApiFailure && e.code === 'offline';
      const still = await api.getSession();
      apply({ loading: false, signedIn: !!still, email: still?.email ?? null, me: null, usage: null, byok, config, offline });
    }
  }, []);
  useEffect(() => {
    void reload();
    const off = store.onChange((id) => {
      if (id === 'session' || id === 'byok' || id === '*' || id === 'account') void reload();
    });
    return off;
  }, [reload]);
  return { ...state, mode: aiMode(state.me, state.byok, state.config, state.offline), reload };
}
