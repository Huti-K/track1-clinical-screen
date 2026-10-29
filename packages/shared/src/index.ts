// Types, not interfaces: Pi Durable documents hold these, and only type aliases satisfy JsonObject.

export type DocumentInfo = {
  id: string;
  title: string;
  date: string;
  type: string;
  department: string;
};

/** One citable unit of a document: a sentence, a list line or a table row. */
export type Passage = {
  id: string;
  documentId: string;
  /** The heading the passage sits under, such as `Entlassungsmedikation`. */
  section: string;
  text: string;
};

export type PatientDocument = DocumentInfo & { passages: Passage[] };

export type PatientSummary = {
  id: string;
  name: string;
  sex: string;
  dateOfBirth: string;
  /** Present-tense questions mean this date, the date of the latest document. */
  asOf: string;
  ageAsOf: number;
  documents: DocumentInfo[];
};

/** A fact's link to the exact words it rests on. */
export type Source = {
  passageId: string;
  documentId: string;
  documentTitle: string;
  documentDate: string;
  quote: string;
};

export type Fact = {
  label: string;
  value: string;
  sources: Source[];
};

export type Need = {
  title: string;
  status: "documented" | "not_documented";
  facts: Fact[];
  note?: string;
};

export type Contradiction = {
  id: string;
  summary: string;
  passages: Source[];
};

export type Screen = {
  situation: string;
  role: string;
  task: string;
  needs: Need[];
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

export type ScreenResponse = {
  id: string;
  patient: PatientSummary;
  screen: Omit<Screen, "needs"> & { needs: AssessedNeed[] };
  /** Needs per light, for the status strip. */
  summary: Record<Light, number>;
  /** Contradictions with a passage the screen cites come first, flagged `relevant`. */
  contradictions: (Contradiction & { relevant: boolean })[];
  cached: boolean;
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
