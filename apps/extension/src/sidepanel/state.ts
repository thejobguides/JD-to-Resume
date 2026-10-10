import type { CanonicalResume, ExtractedJob, JobAnalysis, Mapping, OptimizationResult, OptimizeRequest } from '@jmo/shared';
import { useCallback, useEffect, useState } from 'react';
import type { LoadedResume } from '../lib/files';
import * as store from '../lib/store';

// Everything the panel remembers lives in the encrypted local store, so closing the panel loses nothing.

export interface JobState {
  job: ExtractedJob;
  analysis: JobAnalysis;
  job_analysis_id?: string;
  analyzed_by: 'hosted' | 'byok' | 'local';
  mappings?: Mapping[];
  at: string;
}

export interface TailorState {
  id: string;
  mode: 'hosted' | 'byok';
  optimization_id?: string;
  idempotency_key: string;
  request: OptimizeRequest;
  job_hash: string;
  resume_version: string;
  status: 'running' | 'done' | 'failed' | 'canceled';
  step?: string;
  progress?: number;
  error?: string;
  result?: OptimizationResult;
  models?: string[];
  // review choices
  accepted: string[];
  summary: boolean;
  skills: boolean;
  edits: Record<string, string>;
  attested: string[];
}

export interface HistoryItem {
  id: string;
  at: string;
  title?: string;
  company?: string;
  before: number;
  after: number;
  ceiling: number;
  resume: CanonicalResume;
  attested: string[];
}

export type Step = 'resume' | 'job' | 'match' | 'tailor' | 'export';

export function useStored<T>(id: string): [T | null | undefined, (v: T | null) => Promise<void>] {
  const [value, setValue] = useState<T | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const load = () =>
      store.get<T>(id).then((v) => {
        if (live) setValue(v);
      });
    void load();
    const off = store.onChange((changed) => {
      if (changed === id || changed === '*') void load();
    });
    return () => {
      live = false;
      off();
    };
  }, [id]);
  const set = useCallback(
    async (v: T | null) => {
      setValue(v);
      if (v === null) await store.del(id);
      else await store.put(id, v);
    },
    [id],
  );
  return [value, set];
}

export type BaseResume = LoadedResume;
