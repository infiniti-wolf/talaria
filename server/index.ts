import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import type { Bootstrap, HermesCleanupState, Job, JobStatus, Packet, Preferences, Profile, Settings, SetupStatus } from '../shared/types.ts';
import { DIST_DIR, UPLOAD_DIR } from './lib/paths.ts';
import { addClient, emit, toast } from './lib/events.ts';
import * as store from './lib/store.ts';
import { askJson, checkAI, connectProvider, finishRun, getAIStatus, listAccounts, listProviderModels, rateLimitedUntil, startRun, tryModel } from './lib/ai/index.ts';
import { cancelSignIn, providerInfo, saveApiKey, signInState, signOut, startSignIn } from './lib/ai/providers.ts';
import { importHermesSignIns } from './lib/ai/migrate.ts';
import { findHermes, folderSize, removeHermes } from './lib/ai/hermesLegacy.ts';
import { buildProfileFromResume, canRereadResume, extractResumeText, rereadResume } from './agents/profile.ts';
import { filterAndRank, getScoutState, runScout } from './agents/scout.ts';
import { analyzeJob, answerQuestions, applyGapNotes, chatWithHermes, coverage, resumeText as resumePlainText, markApplied, moveJob, pauseJob, prepareApplication, refreshStaleDrafts, reorderColumn, restoreVersion, resumeJob, reviseCoverLetter, setGapNote, startDrafting } from './agents/pipeline.ts';
import { followUpOnDiscoveries, startAutopilot } from './agents/autopilot.ts';
import { checkBeforeApply, checkLiveness } from './agents/liveness.ts';
import { generateReport } from './agents/report.ts';
import { saveStory, sortStory } from './agents/story.ts';
import { coverLetterPdf, resumePdf } from './lib/resumePdf.tsx';
import { hydrateFromUrl, verifyBoard } from './sources/index.ts';
import { detectBoard } from './sources/boards.ts';
import { fetchHtml, fromJsonLd, readableText, renderHtml } from './sources/jobpage.ts';
import { cleanHtml, guessRemote, htmlToText, textToHtml } from './lib/text.ts';
import { mountMcp } from './mcp.ts';
import { applyTarget, autoApply } from './agents/applier.ts';
import { resolveCompany, suggestCompanies } from './agents/companyFinder.ts';
import { phdSearch, phdSearchRunning } from './agents/phd.ts';
import { connectLinkedIn, disconnectLinkedIn } from './agents/linkedin.ts';
import { checkMail, connectGmail, disconnectGmail, startMailWatch } from './agents/mail.ts';
import { connectGemini, disconnectGemini, transcribeWav, vocabulary } from './lib/voice.ts';
import { playwrightReady } from './lib/browser.ts';
import { compileLatex, findPdflatex, isLatexName, latexToText, readLatexUpload, splitLatex } from './lib/latex.ts';

const PORT = Number(process.env.TALARIA_PORT || 5178);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 12 * 1024 * 1024 } });

const job404 = (res: Response) => res.status(404).json({ error: 'Job not found' });
const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');

// ---------------- bootstrap & events ----------------

app.get('/api/bootstrap', (_req, res) => {
  const body: Bootstrap = {
    profile: store.getProfile(),
    preferences: store.getPreferences(),
    settings: store.getSettings(),
    jobs: store.listJobs(),
    runs: store.listRuns().slice(0, 120),
    answers: store.listAnswers(),
    reports: store.listReports(),
    ai: getAIStatus(),
    scout: getScoutState(),
    tools: { pdflatex: Boolean(findPdflatex()) },
  };
  res.json(body);
});

app.get('/api/events', (_req, res) => addClient(res));

app.get('/api/setup/status', async (_req, res) => {
  const status: SetupStatus = { platform: process.platform, pdflatex: Boolean(findPdflatex()), browser: await playwrightReady() };
  res.json(status);
});

// ---------------- AI ----------------

app.get('/api/ai/providers', (_req, res) => {
  res.json(providerInfo());
});

app.post('/api/ai/check', async (req, res) => {
  res.json(await checkAI(req.query.deep !== '0'));
});

app.post('/api/ai/try', async (req, res) => {
  const { provider, model } = req.body || {};
  if (!provider || !model) return res.status(400).json({ error: 'provider and model are required' });
  res.json(await tryModel(String(provider), String(model)));
});

app.get('/api/ai/models', async (_req, res) => {
  res.json(await listProviderModels());
});

app.get('/api/ai/accounts', async (_req, res) => {
  res.json(await listAccounts());
});

/** Make a tested provider and model the ones Talaria uses. */
function useProvider(provider: string, model: string) {
  const ai = store.getSettings().ai;
  // A writing model from another provider wouldn't work after the switch.
  store.setSettings({ ai: { ...ai, provider, model, tailorModel: provider === ai.provider ? ai.tailorModel : undefined } });
  checkAI(true).catch(() => {});
}

// Test a provider and, when it answers, make it the one Talaria uses. Without a model, Talaria picks one the account accepts.
app.post('/api/ai/connect', async (req, res) => {
  const { provider, model } = req.body || {};
  if (!provider) return res.status(400).json({ error: 'provider is required' });
  const r = await connectProvider(String(provider), model ? String(model) : undefined);
  if (r.ok && r.model) useProvider(String(provider), r.model);
  res.json(r);
});

// Sign in to ChatGPT (in your browser) or GitHub Copilot (with a code). Progress also arrives as "signin" events.
app.post('/api/ai/signin', async (req, res) => {
  const provider = String(req.body?.provider || '');
  try {
    res.json(await startSignIn(provider));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/ai/signin/:provider', (req, res) => {
  res.json(signInState(req.params.provider) ?? null);
});

app.post('/api/ai/signin/:provider/cancel', (req, res) => {
  cancelSignIn(req.params.provider);
  res.json({ ok: true });
});

// Save an API key, test it and, when it answers, switch Talaria to it.
app.post('/api/ai/key', async (req, res) => {
  const provider = String(req.body?.provider || '');
  const key = String(req.body?.key || '').trim();
  if (!provider || !key) return res.status(400).json({ error: 'provider and key are required' });
  try {
    saveApiKey(provider, key);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
  const r = await connectProvider(provider, req.body?.model ? String(req.body.model) : undefined);
  if (r.ok && r.model) useProvider(provider, r.model);
  // A key that doesn't work isn't kept (one that works but lacks a model is: another model will do).
  else if (!r.modelRejected) signOut(provider);
  res.json(r);
});

// ---------------- removing Hermes Agent (existing users, once) ----------------

let hermesSize: { home: string; bytes: Promise<number> } | null = null;
/** Counting a Hermes folder takes a while (often 5 GB in many small files), so it starts once and is shared. */
function measureHermes(home: string) {
  if (hermesSize?.home !== home) hermesSize = { home, bytes: folderSize(home) };
  return hermesSize.bytes;
}

/** Whether to show the one-time offer, and how much removing Hermes Agent would free. */
// Removal runs in the background (it can take many minutes on a slow PC), so the notice can be closed
// meanwhile; every change is sent to the app, which shows a notification when it's done.
let hermesCleanup: HermesCleanupState = { removing: false };
function setHermesCleanup(next: HermesCleanupState) {
  hermesCleanup = next;
  emit({ type: 'hermes-cleanup', cleanup: next });
}

app.get('/api/hermes-cleanup', async (_req, res) => {
  if (hermesCleanup.removing) return res.json({ show: true, ...hermesCleanup, home: hermesSize?.home });
  if (store.getSettings().hermesCleanup !== 'offer') return res.json({ show: false });
  const found = findHermes();
  if (!found) {
    store.setSettings({ hermesCleanup: 'done' }); // already gone: nothing to offer, now or later
    return res.json({ show: false });
  }
  res.json({ show: true, home: found.home, sizeBytes: await measureHermes(found.home) });
});

app.post('/api/hermes-cleanup/dismiss', (_req, res) => {
  store.setSettings({ hermesCleanup: 'done' });
  res.json({ ok: true });
});

app.post('/api/hermes-cleanup/remove', (_req, res) => {
  if (hermesCleanup.removing) return res.json(hermesCleanup);
  // Bring over any sign-ins not taken yet, before they're gone.
  try {
    importHermesSignIns();
  } catch {}
  const found = findHermes();
  const h = startRun('test', 'Removing Hermes Agent');
  const stage = (text: string) => setHermesCleanup({ removing: true, stage: text });
  stage('Getting ready');
  res.json(hermesCleanup);
  removeHermes(t => h.log(t), { stage, knownSize: found && hermesSize?.home === found.home ? hermesSize.bytes : undefined })
    .then(r => {
      finishRun(h, r.ok, r.message, r.ok ? undefined : r.message);
      return r;
    })
    .catch((err: any) => {
      finishRun(h, false, undefined, err.message);
      return { ok: false, freedBytes: 0, message: `Couldn't remove Hermes Agent: ${err.message}` };
    })
    .then(result => {
      hermesSize = null;
      store.setSettings({ hermesCleanup: 'done' });
      setHermesCleanup({ removing: false, result });
    });
});

app.post('/api/ai/signout', (req, res) => {
  signOut(String(req.body?.provider || ''));
  checkAI(false).catch(() => {});
  res.json({ ok: true });
});

// ---------------- profile ----------------

app.post('/api/resume', upload.single('file'), async (req, res) => {
  let text = typeof req.body?.text === 'string' ? req.body.text : '';
  let fileName: string | undefined;
  let latex: string | undefined;
  if (!req.file && text.includes('\\begin{document}')) {
    latex = text;
    text = latexToText(text);
  }
  if (req.file) {
    fileName = req.file.originalname;
    try {
      if (isLatexName(req.file.originalname)) {
        latex = readLatexUpload(req.file.path, req.file.originalname);
        if (!splitLatex(latex)) throw new Error('That LaTeX file has no \\begin{document}…\\end{document}.');
        text = latexToText(latex);
      } else text = await extractResumeText(req.file.path, req.file.originalname);
      const keep = path.join(UPLOAD_DIR, `resume${path.extname(req.file.originalname).toLowerCase()}`);
      fs.renameSync(req.file.path, keep);
    } catch (err: any) {
      fs.rm(req.file.path, { force: true }, () => {});
      return res.status(400).json({ error: err.message });
    }
  }
  if (!text || text.trim().length < 80) return res.status(400).json({ error: "That resume looks empty — if it's a scanned PDF, paste the text instead." });
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  // Onboarding carries on while Hermes reads; the profile and the run's outcome arrive as events.
  if (req.query.background === '1') {
    // A failure is recorded on the run, which onboarding shows in place.
    buildProfileFromResume(text, fileName, latex, model).catch(() => {});
    return res.json({ started: true });
  }
  const result = await buildProfileFromResume(text, fileName, latex, model);
  res.json(result);
});

// Read the same resume again with another model, e.g. a faster one when the first is slow.
app.post('/api/resume/reread', (req, res) => {
  if (!canRereadResume()) return res.status(400).json({ error: 'Upload your resume again to read it with another model.' });
  rereadResume(typeof req.body?.model === 'string' ? req.body.model.trim() : '').catch(() => {});
  res.json({ started: true });
});

app.put('/api/profile', (req, res) => {
  const current = store.getProfile();
  const next = { ...(current || {}), ...(req.body as Partial<Profile>) } as Profile;
  res.json(store.setProfile(next));
});

// Your answers to the story questions: saved now, woven into your story by Hermes in the background.
app.post('/api/profile/story', (req, res) => {
  const answers = req.body?.answers;
  if (!answers || typeof answers !== 'object') return res.status(400).json({ error: 'answers are required' });
  try {
    saveStory(Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, String(v ?? '')])), req.body?.again === true);
    res.json(store.getProfile());
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// A story written before the questions existed, sorted into them from your own sentences (once).
app.post('/api/profile/story/sort', async (_req, res) => {
  try {
    res.json(await sortStory());
  } catch (err: any) {
    res.status(400).json({ error: `Hermes couldn't sort your story: ${err.message.split('\n')[0]}` });
  }
});

app.put('/api/preferences', (req, res) => {
  res.json(store.setPreferences(req.body as Partial<Preferences>));
});

app.post('/api/preferences/verify-company', async (req, res) => {
  const { ats, slug: s, name } = req.body || {};
  try {
    const count = await verifyBoard({ ats, slug: s, name: name || s });
    res.json({ ok: true, count });
  } catch (err: any) {
    res.json({ ok: false, error: err.message });
  }
});

// Look up any company by name or careers link: where it posts jobs, and how many are open.
app.post('/api/preferences/resolve-company', async (req, res) => {
  const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
  if (!input) return res.status(400).json({ error: 'Type a company name or paste its careers link.' });
  try {
    res.json(await resolveCompany(input, typeof req.body?.name === 'string' ? req.body.name : undefined));
  } catch (err: any) {
    res.status(400).json({ error: err.message === 'NEEDS_URL' ? 'Paste the link to their jobs page.' : err.message });
  }
});

// Add any job board by its link: how Talaria will read it (feed, listing page, or a search within it).
app.post('/api/preferences/resolve-board', async (req, res) => {
  const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
  if (!input) return res.status(400).json({ error: 'Paste the link to the job board.' });
  try {
    res.json(await detectBoard(input, typeof req.body?.name === 'string' ? req.body.name : undefined, store.getPreferences()));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/preferences/suggest-companies', async (_req, res) => {
  try {
    res.json({ companies: await suggestCompanies() });
  } catch (err: any) {
    res.status(400).json({ error: `Hermes couldn't suggest companies: ${err.message.split('\n')[0]}` });
  }
});

app.put('/api/settings', (req, res) => {
  const before = store.getSettings().ai;
  const next = store.setSettings(req.body as Partial<Settings>);
  if (before.model !== next.ai.model || before.provider !== next.ai.provider) checkAI(true).catch(() => {});
  res.json(next);
});

app.get('/api/answers', (_req, res) => res.json(store.listAnswers()));
app.get('/api/latex/status', (_req, res) => res.json({ pdflatex: findPdflatex() }));

app.post('/api/latex/test', async (_req, res) => {
  const tex = store.getProfile()?.latexSource;
  if (!tex) return res.status(400).json({ error: 'No LaTeX resume on your profile.' });
  const r = await compileLatex(tex);
  res.json({ ok: r.ok, pages: r.pages, error: r.error });
});

app.put('/api/answers', (req, res) => {
  store.setAnswers(Array.isArray(req.body) ? req.body : []);
  res.json(store.listAnswers());
});

// ---------------- scout ----------------

app.post('/api/scout', (req, res) => {
  if (getScoutState().running) return res.status(409).json({ error: 'A search is already running.' });
  if (!store.getProfile()) return res.status(400).json({ error: 'Add your resume first.' });
  runScout({ maxNew: req.body?.maxNew })
    .then(() => followUpOnDiscoveries())
    .catch(err => toast('error', `Search failed: ${err.message}`));
  res.json({ started: true });
});

app.post('/api/scout/phd', (_req, res) => {
  if (!store.getProfile()) return res.status(400).json({ error: 'Add your resume first.' });
  if (phdSearchRunning()) return res.status(409).json({ error: 'A PhD search is already running.' });
  phdSearch().catch(err => toast('error', `PhD search failed: ${err.message}`));
  res.json({ started: true });
});

app.post('/api/scout/reset-skipped', (_req, res) => {
  store.clearSkipped();
  res.json({ ok: true });
});

// ---------------- jobs ----------------

app.get('/api/jobs/:id', (req, res) => {
  const j = store.getJob(req.params.id);
  return j ? res.json(j) : job404(res);
});

app.post('/api/jobs', async (req, res) => {
  const { url, title, company, description, location } = req.body || {};
  let raw = url ? await hydrateFromUrl(url) : null;
  if (!raw && url && !description) {
    // Read the page from this computer first: many career sites block remote extraction services
    // (reCAPTCHA), but serve the page — often with schema.org JobPosting markup — to a normal visit.
    const h = startRun('hermes_web', `Reading a job link`);
    h.log(url);
    let pageText = '';
    try {
      let html = await fetchHtml(url).catch(() => '');
      raw = html ? fromJsonLd(html, url) : null;
      if (raw) h.log('Read the posting from its JobPosting markup');
      if (!raw) {
        pageText = html ? readableText(html) : '';
        if (pageText.length < 600) {
          h.log('Page needs a browser to render — opening it in a hidden window');
          html = await renderHtml(url).catch(() => '');
          raw = html ? fromJsonLd(html, url) : null;
          if (!raw && html) pageText = readableText(html);
        }
      }
    } catch {}

    if (!raw) {
      const paused = rateLimitedUntil();
      if (paused) {
        finishRun(h, false, undefined, 'The AI is paused by a rate limit');
        const at = new Date(paused).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return res.status(429).json({ error: `Your AI provider has Talaria paused until ${at}, so it can't read that page yet. Switch to “Paste details” to add it now — the fit analysis will run as soon as the pause ends.` });
      }
      try {
        // We have the page text ourselves → the AI only structures it (no web access needed).
        // Otherwise the AI gets the web tools, to find the posting another way.
        const got = await askJson<any>({
          prompt:
            pageText.length >= 600
              ? `Here is the text of a job posting page (${url}). Extract the job.
Return ONLY JSON: {"title": string, "company": string, "location": string, "remote": "remote"|"hybrid"|"onsite"|"unknown", "salary": string, "description": string}
"description" = the full posting (responsibilities, requirements, benefits) as clean Markdown with bullet points; leave out site navigation, cookie notices and unrelated jobs. If this isn't a job posting, return {"error": "<why>"}.

PAGE TEXT
${pageText.slice(0, 14000)}`
              : `Use web_extract to read this job posting: ${url}
Return ONLY JSON: {"title": string, "company": string, "location": string, "remote": "remote"|"hybrid"|"onsite"|"unknown", "salary": string, "description": string}
"description" = the full posting text (responsibilities, requirements, benefits) as clean Markdown with bullet points. If the page can't be read, return {"error": "<why>"}.`,
          web: pageText.length < 600,
          handle: h,
          timeoutSec: 240,
          priority: 1,
        });
        if (got?.error || !got?.title) throw new Error(got?.error || 'Could not read that page.');
        raw = {
          source: 'manual',
          sourceId: url,
          url,
          applyUrl: url,
          title: String(got.title),
          company: String(got.company || 'Unknown company'),
          location: String(got.location || 'Unspecified'),
          remote: ['remote', 'hybrid', 'onsite'].includes(got.remote) ? got.remote : guessRemote(got.location),
          salary: got.salary || undefined,
          descriptionHtml: textToHtml(String(got.description || '').replace(/^#+\s*/gm, '')),
          descriptionText: String(got.description || ''),
          tags: [],
        };
      } catch (err: any) {
        finishRun(h, false, undefined, err.message);
        return res.status(400).json({ error: `Couldn't read that link (${err.message}). Paste the description instead.` });
      }
    }
    finishRun(h, true, `${raw.title} @ ${raw.company}`);
  }
  if (!raw) {
    if (!title || !company) return res.status(400).json({ error: 'Give me a job link, or a title, company and description.' });
    const html = /<\/?[a-z][\s\S]*>/i.test(description || '') ? cleanHtml(description) : textToHtml(description || '');
    raw = {
      source: 'manual',
      sourceId: store.newId(),
      url: url || '',
      applyUrl: url || undefined,
      title,
      company,
      location: location || 'Unspecified',
      remote: guessRemote(location, description),
      descriptionHtml: html,
      descriptionText: htmlToText(html),
      tags: [],
    };
  }
  const ts = store.now();
  const existing = store.listJobs().find(j => store.dedupeKey(j.company, j.title) === store.dedupeKey(raw!.company, raw!.title));
  if (existing) return res.json(existing);
  const [ranked] = filterAndRank([raw], { ...store.getPreferences(), roles: [], seniority: [], locations: [], remote: 'any', excludeKeywords: [], excludeCompanies: [], maxAgeDays: 3650 }, store.getProfile());
  const job: Job = {
    ...raw,
    id: store.newId(),
    status: 'discovered',
    statusChangedAt: ts,
    order: store.nextOrder('discovered'),
    localScore: ranked?.localScore,
    questions: [],
    work: {},
    timeline: [{ at: ts, text: 'Added by you', kind: 'user' }],
    notes: '',
    starred: false,
    createdAt: ts,
    updatedAt: ts,
  };
  store.insertJob(job);
  if (store.getProfile()) analyzeJob(job.id, { priority: 1 }).catch(() => {});
  res.json(job);
});

app.patch('/api/jobs/:id', (req, res) => {
  const body = req.body || {};
  const j = store.updateJob(req.params.id, job => {
    if (typeof body.notes === 'string') job.notes = body.notes;
    if (typeof body.starred === 'boolean') job.starred = body.starred;
    if (body.packet && job.packet) {
      const p = body.packet as Partial<Packet>;
      if (typeof p.coverLetter === 'string') job.packet.coverLetter = p.coverLetter;
      if (p.resume) job.packet.resume = { ...job.packet.resume, ...p.resume };
      if (Array.isArray(p.answers)) job.packet.answers = p.answers;
    }
  });
  return j ? res.json(j) : job404(res);
});

app.delete('/api/jobs/:id', (req, res) => {
  res.json({ ok: store.deleteJob(req.params.id) });
});

app.post('/api/jobs/:id/move', (req, res) => {
  const { status, reason, index } = req.body || {};
  res.json(moveJob(req.params.id, status as JobStatus, { reason, index }));
});

app.post('/api/jobs/reorder', (req, res) => {
  const { status, ids } = req.body || {};
  reorderColumn(status, ids || []);
  res.json({ ok: true });
});

app.post('/api/jobs/:id/analyze', (req, res) => {
  if (!store.getJob(req.params.id)) return job404(res);
  analyzeJob(req.params.id, { force: Boolean(req.body?.force), priority: 1 }).catch(err => toast('error', `Analysis failed: ${err.message}`));
  res.json({ started: true });
});

app.post('/api/jobs/:id/prepare', (req, res) => {
  if (!store.getJob(req.params.id)) return job404(res);
  const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : undefined;
  prepareApplication(req.params.id, { refine: Boolean(req.body?.refine || instructions), instructions }).catch(() => {});
  res.json({ started: true });
});

// Re-draft Needs you drafts that were tailored from an older resume (all of them, or the ids given).
app.post('/api/jobs/refresh-stale', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : undefined;
  const started = refreshStaleDrafts(ids);
  if (started.length > 1) toast('info', `Refreshing ${started.length} drafts with your new resume`);
  res.json({ started });
});

// Check whether postings are still open (every job you haven't applied to, or the ids given).
app.post('/api/jobs/check-live', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : undefined;
  res.json(await checkLiveness(ids));
});

app.post('/api/jobs/:id/pause', (req, res) => {
  if (!store.getJob(req.params.id)) return job404(res);
  res.json(pauseJob(req.params.id));
});

app.post('/api/jobs/:id/resume', async (req, res) => {
  if (!store.getJob(req.params.id)) return job404(res);
  res.json(await resumeJob(req.params.id));
});

app.post('/api/jobs/:id/answers', async (req, res) => {
  const { answers, refine } = req.body || {};
  res.json(await answerQuestions(req.params.id, answers || [], refine !== false));
});

// ---------------- voice typing (test) ----------------

// You paste your Gemini key into Talaria yourself; it's stored only in data/gemini.json.
app.post('/api/voice/connect', async (req, res) => {
  try {
    res.json(await connectGemini(String(req.body?.key || '')));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/voice/disconnect', (_req, res) => res.json(disconnectGemini()));

// Body: a WAV recording from the browser.
app.post('/api/voice/transcribe', express.raw({ type: ['audio/wav', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
  const wav = req.body as Buffer;
  if (!Buffer.isBuffer(wav) || wav.length < 2000) return res.status(400).json({ error: 'That recording was empty.' });
  try {
    res.json(await transcribeWav(wav));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/voice/vocabulary', (_req, res) => res.json({ words: vocabulary() }));

// ---------------- workspace ----------------

app.post('/api/jobs/:id/chat', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!store.getJob(req.params.id)) return job404(res);
  if (!text) return res.status(400).json({ error: 'Say something first.' });
  chatWithHermes(req.params.id, text).catch(() => {});
  res.json({ started: true });
});

app.post('/api/jobs/:id/draft-now', (req, res) => {
  if (!store.getJob(req.params.id)) return job404(res);
  startDrafting(req.params.id).catch(() => {});
  res.json({ started: true });
});

app.post('/api/jobs/:id/restore', (req, res) => {
  const j = restoreVersion(req.params.id, Number(req.body?.index));
  return j ? res.json(j) : job404(res);
});

// Approve and send: Talaria submits supported forms itself, otherwise the Apply kit takes over.
app.post('/api/jobs/:id/finalize', async (req, res) => {
  const j = store.getJob(req.params.id);
  if (!j?.packet) return job404(res);
  // Same rule as the UI's pendingQuestions: a question you left to Hermes ("Draft without answering") isn't open.
  const open = j.questions.filter(q => q.required && !q.answer?.trim() && !q.skipped).length;
  if (open) return res.status(400).json({ error: `Answer the ${open} open question${open > 1 ? 's' : ''} first.` });
  // One careful look at the posting first, so you never land on a closed form.
  if (!req.body?.skipLiveCheck) {
    const live = await checkBeforeApply(j);
    store.updateJob(j.id, x => void (x.liveCheck = { at: store.now(), ...live }), live.live === false ? { at: store.now(), text: `Posting closed: ${live.reason}`, kind: 'agent' } : undefined);
    if (live.live === false) return res.status(409).json({ error: `${j.company} has closed this posting. ${live.reason}.`, closed: true, reason: live.reason });
  }
  store.updateJob(j.id, x => (x.packet!.approvedAt = store.now()), { at: store.now(), text: 'You finalized the application', kind: 'user' });
  if (!store.getSettings().apply.autoSubmit || !applyTarget(j)) return res.json({ mode: 'kit' });
  const ready = await playwrightReady();
  if (!ready.ok) return res.json({ mode: 'kit', error: ready.error });
  store.updateJob(j.id, x => (x.work.submit = { state: 'running', step: 'Starting', at: store.now() }));
  autoApply(j.id).catch(err => toast('error', `${j.company}: ${err.message.split('\n')[0]}`));
  res.json({ mode: 'auto' });
});

// Your own resume, as it is on your profile (for side-by-side comparison).
app.get('/api/profile/resume.pdf', async (_req, res) => {
  const p = store.getProfile();
  if (!p) return res.status(404).json({ error: 'No resume on your profile yet.' });
  let buf: Buffer | undefined;
  if (p.latexSource) {
    const r = await compileLatex(p.latexSource);
    if (r.ok) buf = r.pdf;
  }
  if (!buf)
    buf = await resumePdf({
      name: p.name,
      headline: p.headline,
      contact: { email: p.email, phone: p.phone, location: p.location, links: p.links },
      summary: p.summary,
      skills: p.skills.length ? [{ group: 'Skills', items: p.skills }] : [],
      experience: p.experience,
      projects: p.projects,
      education: p.education,
      extras: p.extras,
    });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="Original_resume.pdf"');
  res.send(buf);
});

app.put('/api/jobs/:id/gap-notes', (req, res) => {
  const { point, response, remember } = req.body || {};
  if (typeof point !== 'string' || typeof response !== 'string') return res.status(400).json({ error: 'point and response are required' });
  res.json(setGapNote(req.params.id, point, response, remember !== false));
});

// ---------------- auto-apply & LinkedIn ----------------

app.post('/api/jobs/:id/auto-apply', async (req, res) => {
  const j = store.getJob(req.params.id);
  if (!j?.packet) return job404(res);
  if (!j.packet.approvedAt) return res.status(400).json({ error: 'Approve the application first.' });
  if (!applyTarget(j)) return res.status(400).json({ error: 'This job has no web address to open. Use the Apply kit for this one.' });
  const ready = await playwrightReady();
  if (!ready.ok) return res.status(500).json({ error: ready.error });
  store.updateJob(j.id, x => (x.work.submit = { state: 'running', step: 'Starting', at: store.now() }));
  autoApply(j.id).catch(err => toast('error', `${j.company}: ${err.message.split('\n')[0]}`));
  res.json({ started: true });
});

app.get('/api/linkedin/status', async (_req, res) => {
  res.json(store.getSettings().linkedin);
});

app.post('/api/linkedin/connect', async (_req, res) => {
  const ready = await playwrightReady();
  if (!ready.ok) return res.status(500).json({ error: ready.error });
  // Opens the sign-in page in Talaria's browser window; you type your password there yourself.
  connectLinkedIn()
    .then(r => toast(r.connected ? 'success' : 'info', r.connected ? 'LinkedIn connected' : 'LinkedIn sign-in timed out — try again'))
    .catch(err => toast('error', `LinkedIn: ${err.message.split('\n')[0]}`));
  res.json({ started: true });
});

app.post('/api/linkedin/disconnect', async (_req, res) => {
  await disconnectLinkedIn().catch(() => {});
  res.json(store.getSettings().linkedin);
});

// ---------------- Gmail ----------------

// You paste the app password into Talaria yourself; it's stored only in data/gmail.json on this PC.
app.post('/api/gmail/connect', async (req, res) => {
  const { email, appPassword } = req.body || {};
  if (typeof email !== 'string' || typeof appPassword !== 'string') return res.status(400).json({ error: 'Email and app password are required.' });
  try {
    res.json(await connectGmail(email, appPassword));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/gmail/disconnect', (_req, res) => res.json(disconnectGmail()));

app.post('/api/gmail/check', async (_req, res) => {
  try {
    res.json({ result: await checkMail() });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Rewrite just one document from scratch: the tailored resume, or the cover letter.
app.post('/api/jobs/:id/rewrite', (req, res) => {
  const j = store.getJob(req.params.id);
  if (!j?.packet) return job404(res);
  const part = req.body?.part;
  if (part === 'cover') reviseCoverLetter(j.id, 'Write a new cover letter from scratch', 1, { fresh: true }).catch(() => {});
  else if (part === 'resume') prepareApplication(j.id, { refine: true, fresh: true, keepCoverLetter: true, priority: 1, note: 'Resume rewritten from scratch' }).catch(() => {});
  else return res.status(400).json({ error: 'part must be "resume" or "cover"' });
  res.json({ started: true });
});

app.post('/api/jobs/:id/weave-keywords', (req, res) => {
  const j = store.getJob(req.params.id);
  if (!j?.packet) return job404(res);
  // Recount with today's matcher, and never retry keywords an earlier pass found don't fit.
  const kws = j.analysis?.keywords || [];
  const cov = j.packet.keywordCoverage;
  const unfit = new Set(cov?.unfit || []);
  const keywords = coverage(kws, resumePlainText(j.packet.resume)).missing.filter(k => !unfit.has(k));
  if (!keywords.length) return res.status(400).json({ error: unfit.size ? "The keywords left don't match your experience, so there's nothing more to work in honestly." : 'No missing keywords to work in.' });
  prepareApplication(req.params.id, { refine: true, priority: 1, keywords, instructions: 'Work the missing ATS keywords in where they are true for the candidate.' }).catch(() => {});
  res.json({ started: true, keywords });
});

app.post('/api/jobs/:id/apply-gap-notes', (req, res) => {
  if (!store.getJob(req.params.id)) return job404(res);
  applyGapNotes(req.params.id).catch(err => toast('error', `Couldn't rewrite: ${err.message}`));
  res.json({ started: true });
});

app.post('/api/jobs/:id/approve', (req, res) => {
  const j = store.updateJob(
    req.params.id,
    job => {
      if (job.packet) job.packet.approvedAt = store.now();
    },
    { at: store.now(), text: 'You approved the application', kind: 'user' },
  );
  return j ? res.json(j) : job404(res);
});

app.post('/api/jobs/:id/applied', (req, res) => {
  res.json(markApplied(req.params.id, req.body?.via || 'manual'));
});

app.get('/api/jobs/:id/resume.tex', (req, res) => {
  const j = store.getJob(req.params.id);
  if (!j?.packet?.latex) return job404(res);
  res.setHeader('Content-Type', 'application/x-tex; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slug(j.packet.resume.name || 'Resume')}_${slug(j.company)}.tex"`);
  res.send(j.packet.latex);
});

app.get('/api/jobs/:id/resume.pdf', async (req, res) => {
  const j = store.getJob(req.params.id);
  if (!j?.packet) return job404(res);
  let buf: Buffer | undefined;
  if (j.packet.latex && req.query.engine !== 'builtin') {
    const r = await compileLatex(j.packet.latex);
    if (r.ok) buf = r.pdf;
  }
  if (!buf) buf = await resumePdf(j.packet.resume);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${slug(j.packet.resume.name || 'Resume')}_${slug(j.company)}.pdf"`);
  res.send(buf);
});

app.get('/api/jobs/:id/cover-letter.pdf', async (req, res) => {
  const j = store.getJob(req.params.id);
  if (!j?.packet) return job404(res);
  const buf = await coverLetterPdf(j.packet.resume, j.packet.coverLetter, j.company);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${slug(j.packet.resume.name || 'Cover_letter')}_Cover_Letter_${slug(j.company)}.pdf"`);
  res.send(buf);
});

// ---------------- reports & export ----------------

app.post('/api/reports', async (req, res) => {
  res.json(await generateReport(Number(req.body?.days) || 7));
});

app.get('/api/export.csv', (_req, res) => {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = store
    .listJobs()
    .filter(j => j.appliedAt)
    .sort((a, b) => Date.parse(b.appliedAt!) - Date.parse(a.appliedAt!))
    .map(j => [j.appliedAt!.slice(0, 10), j.company, j.title, j.location, j.status === 'archived' ? j.archivedReason : j.status, j.analysis?.score ?? j.quick?.score ?? '', j.salary ?? '', j.applyUrl || j.url].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="applications_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(['Applied,Company,Role,Location,Status,Fit,Salary,Link', ...rows].join('\n'));
});

app.post('/api/reset', (req, res) => {
  if (req.body?.confirm !== 'RESET') return res.status(400).json({ error: 'Confirmation missing' });
  store.resetAll();
  res.json({ ok: true });
});

// ---------------- MCP ----------------

mountMcp(app);

// ---------------- static (production build) ----------------

if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  app.use(express.static(DIST_DIR, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/mcp')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api]', err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: err?.message || 'Something went wrong' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ☤ Talaria API on http://127.0.0.1:${PORT}`);
  if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) console.log(`  Open http://127.0.0.1:${PORT} in your browser\n`);
  try {
    const brought = importHermesSignIns();
    if (brought.length) console.log(`  Brought over your sign-ins from Hermes: ${brought.join(', ')}`);
  } catch (err: any) {
    console.warn(`  Couldn't bring over sign-ins from Hermes: ${err.message}`);
  }
  if (store.getSettings().hermesCleanup === 'offer') {
    const found = findHermes();
    if (found) measureHermes(found.home);
  }
  checkAI(true).then(s => console.log(`  AI: ${s.ok ? `ready (${s.provider} · ${s.model})` : s.message}`));
  startAutopilot();
  startMailWatch();
});
