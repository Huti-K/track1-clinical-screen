// Types, not interfaces: Pi Durable documents hold these, and only type aliases satisfy JsonObject.

export type DocumentInfo = {
  id: string;
  title: string;
  date: string;
  type: string;
  department: string;
  /** The issuing hospital, for the letterhead. */
  hospital?: string;
  /** The hospital stay the document belongs to; `type` is "inpatient" or "outpatient". */
  stay?: { id: string; type: string };
};

/** One citable unit of a document: a sentence, a list line or a table row. */
export type Passage = {
  id: string;
  documentId: string;
  /** The heading the passage sits under, such as `Entlassungsmedikation`. */
  section: string;
  text: string;
};

/** A table row of a letter, such as one drug of the discharge medication, cut into its cells. */
export type LetterRow = { passageId: string; cells: string[] };

/**
 * A run of lines the letter sets together, in reading order, so a viewer can draw the page as it
 * prints. `lines` holds each line's passage IDs; a long line holds several sentences.
 */
export type LetterBlock = {
  /** A blank line stands before the block in the letter. */
  spaced: boolean;
  /** The block starts a page, as an enclosure after the signature does. */
  newPage?: boolean;
} & (
  | {
      kind: "address" | "date" | "title" | "heading" | "text" | "closing" | "signature";
      lines: string[][];
    }
  | { kind: "table"; head: LetterRow; rows: LetterRow[] }
);

export type PatientDocument = DocumentInfo & { passages: Passage[]; layout?: LetterBlock[] };

export type PatientSummary = {
  id: string;
  name: string;
  sex: string;
  dateOfBirth: string;
  /** Present-tense questions mean this date, the date of the latest document. */
  asOf: string;
  ageAsOf: number;
  documents: DocumentInfo[];
  /** Situations the start page offers as examples for this patient, from `situations.json`. */
  situations?: string[];
};

/** A fact's link to the exact words it rests on. */
export type Source = {
  passageId: string;
  documentId: string;
  documentTitle: string;
  documentDate: string;
  quote: string;
};

/** A drug line cut into the parts the medication table shows. */
export type Drug = {
  /** The generic name in English, such as "Aspirin". */
  name: string;
  /** The brand as the letter writes it, such as "Thrombo ASS". */
  brand?: string;
  /** One intake, such as "100 mg". */
  dose?: string;
  /** Morning-midday-evening, optionally night, such as "1-0-1"; or a phrase such as "weekly". */
  schedule?: string;
  /** Such as "oral" or "subcutaneous". */
  route?: string;
};

export type Fact = {
  label: string;
  /** The answer in a few words, such as "60 %" or "Aspirin 100 mg". */
  value: string;
  /** What qualifies the value, in a few words, such as "normal systolic function". */
  detail?: string;
  /** YYYY-MM-DD the fact refers to; without it, the screen dates it by its newest source. */
  date?: string;
  /** For a drug of the medication list, its parts. */
  drug?: Drug;
  /** For a fact taken from the fact index, its category there, such as "diagnosis". */
  category?: string;
  sources: Source[];
};

export type Need = {
  title: string;
  status: "documented" | "not_documented";
  facts: Fact[];
  note?: string;
  /** For not_documented: one step that would close the gap, such as asking the patient. */
  action?: string;
};

/** A topic the record documents that the screen left out because the task does not need it. */
export type LeftOut = { topic: string; sources: Source[] };

/** One side of a contradiction: what some passages say, such as "Right". */
export type Claim = {
  label: string;
  /** How many passages say it; `passages` shows a few of them. */
  total: number;
  /** Each with `term`, the words in its quote that say it, such as "Rechts". */
  passages: (Source & { term: string })[];
};

export type Contradiction = {
  id: string;
  summary: string;
  passages: Source[];
  /** `rule`: found by arithmetic or a fixed check on the passages; `model`: found by the LLM. */
  method?: "rule" | "model";
  /** For a check that knows what each passage says, the passages split by it. */
  claims?: Claim[];
};

/** One documented value of a measurement, with the passage that states it. */
export type TrendPoint = {
  value: number;
  /** The second number of a pair, such as the diastolic of a blood pressure. */
  secondary?: number;
  display: string;
  date: string;
  sources: Source[];
};

/** A measurement over time, such as weight; screens carry only those documented at least twice. */
export type Trend = {
  kind: string;
  label: string;
  unit: string;
  points: TrendPoint[];
  /** Latest minus earliest, such as "−12 kg since Jun 2019". */
  change: string;
};

export type Screen = {
  situation: string;
  role: string;
  task: string;
  /** What the task is for, such as "Hip replacement, 12 March 2021". */
  occasion?: string;
  needs: Need[];
  leftOut?: LeftOut[];
  /** Facts the model cited from passages that do not say them, left off the screen. */
  rejected: number;
  model: string;
  elapsedMs: number;
};

/**
 * Green: documented, current and consistent. Yellow: documented, but older than six months or
 * cited from a passage in a contradiction. Red: the task needs it and no document has it.
 */
export type Light = "green" | "yellow" | "red";

export type AssessedFact = Fact & { light: Light; reason: string };

export type AssessedNeed = Omit<Need, "facts"> & {
  facts: AssessedFact[];
  light: Light;
  reason: string;
};

/**
 * `surgery`: drugs to review before an operation. `contrast`: what matters before CT or MRI.
 * `sickDay`: drugs to stop while dehydrated, on every task.
 */
export type CheckKind = "surgery" | "contrast" | "sickDay";

/** A documented fact a check lists, with the class or topic that matched, such as "Sartan". */
export type CheckItem = AssessedFact & { tag: string };

/** Something a check asks for that no document has, with one step to close the gap. */
export type CheckGap = { title: string; note: string; action: string };

/**
 * A fixed rule the task triggers. The rule is hard-coded general knowledge; every item it lists is
 * a documented fact with its sources, and every gap is checked against all documents.
 */
export type SafetyCheck = {
  kind: CheckKind;
  title: string;
  /** What the rule covers, shown as a rule rather than as a fact about the patient. */
  rule: string;
  items: CheckItem[];
  gaps: CheckGap[];
  /** Every passage that documents an item, so the screen can mark the facts it lists. */
  passages: string[];
};

/** Who can close an open point: the patient, a test or measurement, or another clinician's records. */
export type ClarifyFrom = "patient" | "test" | "records";

/**
 * Something the screen leaves open, with one step that would close it. Each comes from the record:
 * a need no document has, a contradiction in a passage the screen cites, or a value too old to rely on.
 */
export type Clarification = {
  /** Stays the same across requests, so a note can say which point it answers. */
  id: string;
  /** What is open, such as "Kidney function". */
  topic: string;
  /** Why it is open, such as "Creatinine, eGFR" or the contradiction's summary. */
  reason: string;
  /** The question or step that would close it, such as "Ask about earlier anaesthesia". */
  step: string;
  from: ClarifyFrom;
  trigger: "gap" | "contradiction" | "old";
  /** The passages that raised it; a gap has none. */
  sources: Source[];
  /** For a contradiction, its ID, so the screen can compare its passages. */
  contradictionId?: string;
};

/** What every screen shows about the patient, whatever the task. */
export type Basics = {
  /** The latest height, weight and BMI. */
  measures: AssessedFact[];
  allergies: AssessedFact[];
  /** Diagnoses the documents name, the most often named first. */
  problems: AssessedFact[];
  medication: AssessedFact[];
};

export type ScreenResponse = {
  /** The same situation for the same patient has the same ID; two patients never share one. */
  id: string;
  patient: PatientSummary;
  screen: Omit<Screen, "needs"> & { needs: AssessedNeed[] };
  /** Needs per light, for the status strip. */
  summary: Record<Light, number>;
  /** Contradictions with a passage the screen cites come first, flagged `relevant`. */
  contradictions: (Contradiction & { relevant: boolean })[];
  /** Measurements on this screen documented more than once, oldest point first. */
  trends: Trend[];
  /** The fixed safety rules this task triggers, such as drugs to review before surgery. */
  checks: SafetyCheck[];
  basics: Basics;
  /** Open points, the fixed checks' gaps first, then the screen's gaps, contradictions and old values. */
  clarify: Clarification[];
  /** Full text and section of every passage the screen cites, for previews. */
  passages: Record<string, { text: string; section: string }>;
  cached: boolean;
};

/** The start page's overview of a patient, from the documents alone: no screen is built for it. */
export type OverviewResponse = {
  /** Every measurement the documents state, oldest point first; one point when stated once. */
  vitals: Trend[];
  basics: Basics;
  contradictions: Contradiction[];
};

/** A follow-up question about the record, answered under the screen's rules: cited facts or a gap. */
export type Answer = {
  /** The same question in the same situation has the same ID and comes from the store. */
  id: string;
  question: string;
  /** What the answer is about, in a few words, such as "Carotid duplex follow-up". */
  topic: string;
  facts: AssessedFact[];
  /** The part of the question no document answers, with one step that would close it. */
  missing?: { note: string; action?: string };
  /** Facts the model cited from passages that do not say them, left out. */
  rejected: number;
  /** Full text and section of every passage the answer cites. */
  passages: Record<string, { text: string; section: string }>;
  model: string;
  elapsedMs: number;
  cached: boolean;
};

/** What a clinician recorded after the documents: what the patient said or what they found. */
export type Note = {
  id: string;
  /** What it is about, such as "Kidney function". */
  topic: string;
  text: string;
  /** `patient`: the patient said it. `clinician`: a clinician measured, found or checked it. */
  source: "patient" | "clinician";
  /** The ID of the open point it answers. */
  clarifies?: string;
  /** The signed-in account that recorded it, where the sign-in names one. */
  author?: string;
  /** ISO timestamp. */
  recordedAt: string;
};

export type ErrorResponse = { error: string };

/** One sign-in attempt as the web app shows it. */
export type LoginStep = {
  done: boolean;
  error?: string;
  /** The provider's sign-in page; the browser login returns to a local callback. */
  authUrl?: string;
  deviceCode?: { userCode: string; verificationUri: string };
  /** Text the flow waits for, such as the redirect URL when the local callback is taken. */
  prompt?: { message: string; placeholder?: string };
};

export type AuthStatus = {
  signedIn: boolean;
  providerName: string;
  model: string;
  /** False for providers that sign in with an API key from .env. */
  subscription: boolean;
  account?: string;
  /** Signed in through this app, so signing out here ends it; false for a key from .env. */
  stored: boolean;
  login: LoginStep | null;
};
