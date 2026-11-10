// Shared domain types for the Talaria server and web client.

export type JobStatus =
  | 'discovered'
  | 'preparing'
  | 'needs_input'
  | 'applied'
  | 'interviewing'
  | 'offer'
  | 'archived';

export const BOARD_COLUMNS: JobStatus[] = [
  'discovered',
  'preparing',
  'needs_input',
  'applied',
  'interviewing',
  'offer',
];

export type ArchiveReason = 'dismissed' | 'rejected' | 'withdrawn' | 'expired' | 'duplicate';

export type SourceId =
  | 'remotive'
  | 'remoteok'
  | 'himalayas'
  | 'jobicy'
  | 'arbeitnow'
  | 'themuse'
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workday'
  | 'workable'
  | 'smartrecruiters'
  | 'recruitee'
  | 'company_site'
  | 'custom_board'
  | 'academic'
  | 'hermes_web'
  | 'linkedin'
  | 'manual';

export type RemoteMode = 'remote' | 'hybrid' | 'onsite' | 'unknown';

export interface Link {
  label: string;
  url: string;
}

export interface ExperienceItem {
  company: string;
  title: string;
  location?: string;
  start?: string;
  end?: string;
  bullets: string[];
}

export interface ProjectItem {
  name: string;
  link?: string;
  tech?: string[];
  bullets: string[];
}

export interface EducationItem {
  school: string;
  degree?: string;
  field?: string;
  start?: string;
  end?: string;
  details?: string;
}

export interface ExtraSection {
  label: string;
  items: string[];
}

export interface Profile {
  name: string;
  email: string;
  phone: string;
  location: string;
  headline: string;
  summary: string;
  links: Link[];
  yearsExperience?: number;
  skills: string[];
  experience: ExperienceItem[];
  projects: ProjectItem[];
  education: EducationItem[];
  extras: ExtraSection[];
  resumeText: string;
  resumeFileName?: string;
  latexSource?: string; // the user's own LaTeX resume, kept as the template for tailoring
  story?: string; // who you are beyond the resume, woven by Hermes from your answers: the material for cover letters
  storyAnswers?: Record<string, string>; // your answers to the story questions, keyed by question id
  storyWovenAt?: string; // when Hermes last wove the answers into the story (unset: the story is the answers as written)
  ideas?: ProfileIdeas; // suggestions from the resume, offered (never filled in) across the app
  updatedAt?: string;
}

export type Seniority = 'intern' | 'entry' | 'mid' | 'senior' | 'lead';
export type WorkKind = 'full_time' | 'internship' | 'phd';
export type RemotePreference = 'remote_only' | 'remote_or_hybrid' | 'any' | 'onsite';

/** A company you want watched. "site" = its own careers website (read from the page, or searched within it). */
export interface TargetCompany {
  name: string;
  ats: 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'workable' | 'smartrecruiters' | 'recruitee' | 'site';
  slug: string;
  url?: string; // careers page (Workday board or the company's own site)
  domain?: string;
}

/** A job board you added: any site that lists jobs. Read from its RSS feed, from its listing page, or, when
 * neither gives Talaria anything to read, searched by Hermes within that site. */
export interface CustomBoard {
  id: string;
  name: string;
  url: string; // the page you pasted; {query} in it is replaced by each of your roles
  how: 'feed' | 'page' | 'search';
  feedUrl?: string;
  domain: string;
  enabled: boolean;
}

export interface Preferences {
  roles: string[];
  seniority: Seniority[];
  locations: string[];
  remote: RemotePreference;
  minSalary?: number | null;
  currency?: string;
  needsSponsorship?: boolean | null;
  includeKeywords: string[];
  excludeKeywords: string[];
  excludeCompanies: string[];
  targetCompanies: TargetCompany[];
  customBoards: CustomBoard[];
  sources: Partial<Record<SourceId, boolean>>;
  maxAgeDays: number;
  phd?: { enabled: boolean; fields: string[]; countries: string[] }; // PhD positions: research fields and where
  lookingFor?: WorkKind[]; // what kind of work you want; unset means jobs, as before onboarding asked
}

export interface AnswerBankItem {
  id: string;
  question: string;
  answer: string;
  updatedAt: string;
  uses: number;
}

export interface QuickScore {
  score: number;
  reason: string;
  at: string;
}

export interface Analysis {
  score: number;
  verdict: string;
  summary: string;
  whyYes: { point: string; evidence?: string }[];
  whyNo: { point: string; severity: 'high' | 'medium' | 'low'; detail?: string }[];
  improve: { action: string; impact: 'high' | 'medium' | 'low'; effort?: 'quick' | 'moderate' | 'significant'; detail?: string }[];
  mustHaves: { requirement: string; met: 'yes' | 'partial' | 'no'; note?: string }[];
  keywords: string[];
  generatedAt: string;
  model?: string;
}

export interface TailoredResume {
  name: string;
  headline: string;
  contact: { email?: string; phone?: string; location?: string; links: Link[] };
  summary: string;
  skills: { group: string; items: string[] }[];
  experience: ExperienceItem[];
  projects: ProjectItem[];
  education: EducationItem[];
  extras: ExtraSection[];
}

export interface Packet {
  resume: TailoredResume;
  coverLetter: string;
  answers: { question: string; answer: string }[];
  changes: { what: string; why: string }[];
  keywordCoverage?: { before: number; after: number; missing: string[]; unfit?: string[] }; // unfit: tried, and they don't match your experience
  generatedAt: string;
  model?: string;
  approvedAt?: string;
  note?: string; // what produced this version ("First draft", "Warmer cover letter", â€¦)
  resumeHash?: string; // fingerprint of the resume this draft was tailored from (shared/resume.ts)
  latex?: string;
  latexStatus?: 'compiled' | 'uncompiled' | 'error';
  latexError?: string;
  latexPages?: number;
}

export type QuestionKind = 'text' | 'longtext' | 'choice' | 'yesno' | 'number';

export interface AgentQuestion {
  id: string;
  question: string;
  why?: string;
  kind: QuestionKind;
  options?: string[];
  suggested?: string;
  answer?: string;
  required: boolean;
  fromBank?: boolean;
  /** interview = asked before drafting to personalise it; draft = raised while drafting; form = the application form needs it */
  stage?: 'interview' | 'draft' | 'form';
  skipped?: boolean; // "use your judgment"
  reusable?: boolean; // worth remembering for future applications (logistics), vs. specific to this job
}

/** One message in the collaborative workspace between you and Hermes. */
export interface ChatMessage {
  id: string;
  at: string;
  from: 'hermes' | 'you';
  text: string;
  kind?: 'interview' | 'questions' | 'draft' | 'revision' | 'reply' | 'status' | 'error';
  questionIds?: string[];
  changes?: { what: string; why: string }[];
  snippet?: string; // a piece of text Hermes wrote on request (a form answer, a pitch), shown with a copy button
}

export type MailKind = 'rejection' | 'interview' | 'next_step' | 'offer' | 'received' | 'other';

/** An email about one of your applications, as Hermes read it. */
export interface MailItem {
  id: string;
  at: string;
  from: string;
  subject: string;
  kind: MailKind;
  summary: string;
}

/** How a draft is (re)written: see prepareApplication in server/agents/pipeline.ts. */
export interface PrepareOptions {
  refine?: boolean;
  instructions?: string;
  keywords?: string[];
  keepCoverLetter?: boolean;
  skipInterview?: boolean;
  note?: string;
  fresh?: boolean; // with refine: rewrite from your original resume instead of revising the current draft
}

export interface PacketVersion {
  at: string;
  note: string;
  packet: Packet;
}

export type TaskKind = 'analyze' | 'tailor' | 'submit' | 'chat';

export interface TaskState {
  state: 'queued' | 'running' | 'done' | 'error';
  step?: string;
  error?: string;
  at: string;
}

/** The candidate's reply to one of Hermes's "why you might not" points. */
export interface GapNote {
  point: string;
  response: string;
  at: string;
}

export interface TimelineEvent {
  at: string;
  text: string;
  kind?: 'status' | 'agent' | 'user' | 'note';
}

export interface Job {
  id: string;
  source: SourceId;
  sourceId: string;
  via?: string; // the job board you added that it was found on
  url: string;
  applyUrl?: string;
  title: string;
  company: string;
  companyLogo?: string;
  companyDomain?: string;
  location: string;
  remote: RemoteMode;
  employmentType?: string;
  track?: 'job' | 'phd'; // full-time role or PhD position (see shared/track.ts)
  deadline?: string; // application deadline, when the posting gives one
  seniority?: string;
  salary?: string;
  postedAt?: string;
  descriptionHtml: string;
  descriptionText: string;
  tags: string[];

  status: JobStatus;
  statusChangedAt: string;
  archivedReason?: ArchiveReason;
  archivedFrom?: JobStatus;
  order: number;

  localScore?: number;
  quick?: QuickScore;
  analysis?: Analysis;
  packet?: Packet;
  questions: AgentQuestion[];
  work: Partial<Record<TaskKind, TaskState>>;
  timeline: TimelineEvent[];
  notes: string;
  starred: boolean;
  appliedAt?: string;
  appliedVia?: 'assisted' | 'auto' | 'manual';
  gapNotes?: GapNote[];
  chat?: ChatMessage[];
  interview?: { askedAt: string; doneAt?: string };
  packetHistory?: PacketVersion[]; // earlier drafts, newest first
  paused?: { at: string; redo?: 'tailor' | 'analyze'; opts?: PrepareOptions }; // you paused Hermes on this job; redo is what Resume restarts
  liveCheck?: { at: string; live: boolean | null; reason: string }; // is the posting still open? null = couldn't tell
  mail?: MailItem[]; // replies found in your Gmail
  mailSeen?: string[]; // Gmail message ids already read
  outcome?: { kind: MailKind; at: string; summary: string; subject: string; from: string }; // the latest decisive reply

  createdAt: string;
  updatedAt: string;
}

export type RunKind = 'profile' | 'story' | 'scout' | 'score' | 'analyze' | 'tailor' | 'summary' | 'submit' | 'test' | 'hermes_web' | 'chat' | 'mail';

export interface AgentRun {
  id: string;
  kind: RunKind;
  jobId?: string;
  title: string;
  status: 'queued' | 'running' | 'done' | 'error';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  model?: string;
  usage?: { apiCalls?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number };
  detail?: string;
  error?: string;
  log: { at: string; text: string }[];
}

export interface AISettings {
  provider: string;
  model: string;
  tailorModel?: string; // optional stronger model just for resume/cover-letter writing
  concurrency: number;
  timeoutSec: number;
  webSearch: boolean;
}

export interface AutopilotSettings {
  enabled: boolean;
  scoutEveryHours: number;
  autoAnalyzeAbove: number;
  autoPrepareAbove: number | null;
  maxPreparePerRun: number;
  lastScoutAt?: string;
}

export interface Settings {
  ai: AISettings;
  autopilot: AutopilotSettings;
  onboarded: boolean;
  toured?: boolean; // false = the first-visit board tour hasn't been seen yet
  apply: { autoSubmit: boolean; interviewFirst?: boolean }; // interviewFirst: Hermes asks you questions before drafting
  linkedin: { connected: boolean; name?: string; checkedAt?: string; lastScoutAt?: string };
  gmail?: { connected: boolean; email?: string; autoCheck?: boolean; lastCheckAt?: string; lastResult?: string; error?: string };
  voice?: { connected: boolean; model?: string }; // voice typing via your own Gemini key (being tested)
  theme?: 'light' | 'dark' | 'system';
  onboarding?: OnboardingProgress;
  hermesCleanup?: 'offer' | 'done'; // existing users: offer once to remove Hermes Agent, which Talaria no longer needs
}

/** Where you are in first-time setup, so closing the window halfway doesn't lose anything. */
export interface OnboardingProgress {
  step?: string;
  resumeName?: string; // the file Hermes is reading (or read)
  story?: Record<string, string>; // answers to the "your story" questions, keyed by question id
  confirmedPrefs?: (keyof Preferences)[]; // set by you already, so resume suggestions mustn't overwrite them
}

export interface Report {
  id: string;
  generatedAt: string;
  from: string;
  to: string;
  markdown: string;
}

export interface AIStatus {
  ok: boolean;
  provider?: string;
  model?: string;
  message?: string;
  checkedAt?: string;
  latencyMs?: number;
  checking?: boolean;
  rateLimitedUntil?: string; // provider rate limit: queue paused until this time
}

/** Ideas Hermes draws from a resume, shown as suggestions and examples so they fit this person's field. */
export interface ProfileIdeas {
  roles: string[]; // more job titles worth a look, beyond the ones filled in
  topics: string[]; // domains, products and technologies they might love
  dealBreakers: string[]; // what people in this field often rule out
  locations: string[]; // cities, countries or regions that hire this profile and suit them
}

/** The AI accounts Talaria is signed in to, so setup can fill itself in. */
export interface AIAccounts {
  signedIn: string[]; // providers with a saved sign-in or key
  models: Record<string, string[]>; // models each provider offers, best first
  defaults: Record<string, string>; // the model Talaria picks for each provider
}

/** A provider Talaria can sign in to, and how. */
export interface AIProviderInfo {
  id: string;
  label: string;
  auth: 'chatgpt' | 'copilot' | 'key';
  keyUrl?: string; // where to get a key
  keyHint?: string;
  webSearch: 'native' | 'talaria'; // the provider's own web search, or Talaria's
}

/** An in-app sign-in in progress (ChatGPT in the browser, or GitHub's device code). */
export interface AISignIn {
  provider: string;
  state: 'waiting' | 'done' | 'error';
  url?: string; // open this to sign in
  userCode?: string; // GitHub: type this code on the page
  message?: string;
}

export interface ScoutState {
  running: boolean;
  phase?: string;
  progress?: number;
  found?: number;
  added?: number;
  startedAt?: string;
  finishedAt?: string;
  lastResult?: string;
}

/** What the first-run setup checks on this computer. */
export interface SetupStatus {
  platform: string;
  pdflatex: boolean;
  browser: { ok: boolean; error?: string };
}

export interface Bootstrap {
  profile: Profile | null;
  preferences: Preferences;
  settings: Settings;
  jobs: Job[];
  runs: AgentRun[];
  answers: AnswerBankItem[];
  reports: Report[];
  ai: AIStatus;
  scout: ScoutState;
  tools: { pdflatex: boolean };
}

export type ServerEvent =
  | { type: 'job'; job: Job }
  | { type: 'job:remove'; id: string }
  | { type: 'run'; run: AgentRun }
  | { type: 'profile'; profile: Profile | null }
  | { type: 'preferences'; preferences: Preferences }
  | { type: 'settings'; settings: Settings }
  | { type: 'answers'; answers: AnswerBankItem[] }
  | { type: 'reports'; reports: Report[] }
  | { type: 'ai'; ai: AIStatus }
  | { type: 'signin'; signin: AISignIn }
  | { type: 'scout'; scout: ScoutState }
  | { type: 'toast'; level: 'info' | 'success' | 'error'; text: string }
  | { type: 'hermes-cleanup'; cleanup: HermesCleanupState };

/** Removing Hermes Agent runs in the background, so the notice can be closed while it works. */
export interface HermesCleanupState {
  removing: boolean;
  stage?: string; // what it's doing right now
  result?: { ok: boolean; freedBytes: number; message: string; leftover?: string };
}
