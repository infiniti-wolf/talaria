import { create } from 'zustand';
import { toast } from 'sonner';
import type { AgentRun, AISignIn, AIStatus, AnswerBankItem, Bootstrap, HermesCleanupState, Job, JobStatus, Preferences, Profile, Report, ScoutState, ServerEvent, Settings } from '@shared/types';
import { api } from './api';

interface State {
  loaded: boolean;
  connected: boolean;
  profile: Profile | null;
  preferences: Preferences | null;
  settings: Settings | null;
  jobs: Record<string, Job>;
  runs: AgentRun[];
  answers: AnswerBankItem[];
  reports: Report[];
  ai: AIStatus;
  signin: Record<string, AISignIn>; // in-app sign-ins in progress, by provider
  scout: ScoutState;
  hermesCleanup: HermesCleanupState | null; // removing Hermes Agent, once, in the background
}

export const useApp = create<State>(() => ({
  loaded: false,
  connected: false,
  profile: null,
  preferences: null,
  settings: null,
  jobs: {},
  runs: [],
  answers: [],
  reports: [],
  ai: { ok: false },
  signin: {},
  scout: { running: false },
  hermesCleanup: null,
}));

const set = useApp.setState;

export async function loadBootstrap() {
  const b = await api.get<Bootstrap>('/api/bootstrap', { quiet: true });
  set({
    loaded: true,
    profile: b.profile,
    preferences: b.preferences,
    settings: b.settings,
    jobs: Object.fromEntries(b.jobs.map(j => [j.id, j])),
    runs: b.runs,
    answers: b.answers,
    reports: b.reports,
    ai: b.ai,
    scout: b.scout,
  });
}

function apply(ev: ServerEvent) {
  switch (ev.type) {
    case 'job':
      set(s => ({ jobs: { ...s.jobs, [ev.job.id]: ev.job } }));
      break;
    case 'job:remove':
      set(s => {
        const jobs = { ...s.jobs };
        delete jobs[ev.id];
        return { jobs };
      });
      break;
    case 'run':
      set(s => {
        const idx = s.runs.findIndex(r => r.id === ev.run.id);
        const runs = idx >= 0 ? s.runs.map(r => (r.id === ev.run.id ? ev.run : r)) : [ev.run, ...s.runs].slice(0, 200);
        return { runs };
      });
      break;
    case 'profile':
      set({ profile: ev.profile });
      break;
    case 'preferences':
      set({ preferences: ev.preferences });
      break;
    case 'settings':
      set({ settings: ev.settings });
      break;
    case 'answers':
      set({ answers: ev.answers });
      break;
    case 'reports':
      set({ reports: ev.reports });
      break;
    case 'ai':
      set({ ai: ev.ai });
      break;
    case 'signin':
      set(s => ({ signin: { ...s.signin, [ev.signin.provider]: ev.signin } }));
      break;
    case 'scout':
      set({ scout: ev.scout });
      break;
    case 'hermes-cleanup':
      set({ hermesCleanup: ev.cleanup });
      break;
    case 'toast':
      if (ev.level === 'error') toast.error(ev.text);
      else if (ev.level === 'success') toast.success(ev.text);
      else toast(ev.text);
      break;
  }
}

let es: EventSource | null = null;
let retry = 0;

export function connectEvents() {
  if (es) return;
  es = new EventSource('/api/events');
  es.onopen = () => {
    retry = 0;
    set({ connected: true });
    // Anything that happened while we were disconnected (or before the first connection, such as the
    // AI check that runs as the server starts) only exists in a fresh snapshot.
    loadBootstrap().catch(() => {});
  };
  es.onerror = () => {
    set({ connected: false });
    // A proxy error while the API restarts makes EventSource give up for good — rebuild it ourselves.
    if (es && es.readyState === EventSource.CLOSED) {
      es = null;
      const delay = Math.min(10000, 500 * 2 ** retry++);
      setTimeout(connectEvents, delay);
    }
  };
  es.onmessage = e => {
    try {
      apply(JSON.parse(e.data));
    } catch {}
  };
}

export function applyProfileResult(r: { profile: Profile; preferences: Preferences }) {
  set({ profile: r.profile, preferences: r.preferences });
}

// ---------- optimistic helpers ----------

export function patchJobLocal(id: string, patch: Partial<Job>) {
  set(s => (s.jobs[id] ? { jobs: { ...s.jobs, [id]: { ...s.jobs[id], ...patch } } } : s));
}

export async function moveJob(id: string, status: JobStatus, extra: { reason?: string; index?: number } = {}) {
  const prev = useApp.getState().jobs[id];
  if (!prev) return;
  if (status !== 'preparing' && !(status === 'needs_input' && !prev.packet)) patchJobLocal(id, { status, order: extra.index ?? -1e9 });
  try {
    await api.post(`/api/jobs/${id}/move`, { status, ...extra });
  } catch {
    patchJobLocal(id, { status: prev.status, order: prev.order });
  }
}

export const jobActions = {
  analyze: (id: string, force = false) => api.post(`/api/jobs/${id}/analyze`, { force }),
  prepare: (id: string, opts: { refine?: boolean; instructions?: string } = {}) => api.post(`/api/jobs/${id}/prepare`, opts),
  approve: (id: string) => api.post(`/api/jobs/${id}/approve`),
  autoApply: (id: string) => api.post(`/api/jobs/${id}/auto-apply`),
  applied: (id: string, via: 'assisted' | 'manual' = 'manual') => api.post(`/api/jobs/${id}/applied`, { via }),
  answer: (id: string, answers: { id: string; answer: string; remember?: boolean; skip?: boolean }[], refine = true) => api.post(`/api/jobs/${id}/answers`, { answers, refine }),
  chat: (id: string, text: string) => api.post(`/api/jobs/${id}/chat`, { text }),
  draftNow: (id: string) => api.post(`/api/jobs/${id}/draft-now`),
  restore: (id: string, index: number) => api.post(`/api/jobs/${id}/restore`, { index }),
  pause: (id: string) => api.post(`/api/jobs/${id}/pause`),
  resume: (id: string) => api.post(`/api/jobs/${id}/resume`),
  finalize: (id: string) => api.post<{ mode: 'auto' | 'kit'; error?: string }>(`/api/jobs/${id}/finalize`),
  patch: (id: string, body: Record<string, unknown>) => api.patch(`/api/jobs/${id}`, body),
  remove: (id: string) => api.del(`/api/jobs/${id}`),
  archive: (id: string, reason: 'dismissed' | 'rejected' | 'withdrawn' | 'expired' = 'dismissed') => moveJob(id, 'archived', { reason }),
};

export async function startScout() {
  set(s => ({ scout: { ...s.scout, running: true, phase: 'Starting search', progress: 0.02 } }));
  try {
    await api.post('/api/scout');
  } catch {
    set(s => ({ scout: { ...s.scout, running: false } }));
  }
}

// Dev only: hot-swapping this module would orphan the live event stream from the store the UI reads.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
