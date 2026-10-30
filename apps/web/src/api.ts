import type {
  Answer,
  AuthStatus,
  ErrorResponse,
  Note,
  PatientDocument,
  PatientSummary,
  ScreenResponse,
} from "@track1/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as T | ErrorResponse;
  init?.signal?.throwIfAborted();
  if (!response.ok)
    throw new ApiError(response.status, (body as ErrorResponse).error ?? response.statusText);
  return body as T;
}

const post = <T>(path: string, body: object = {}, signal?: AbortSignal) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body), signal });

/** Every patient route names its patient; the server answers it from that patient's record only. */
const of = (patientId: string, path = "") =>
  `/api/patients/${encodeURIComponent(patientId)}${path}`;

export const api = {
  auth: () => request<AuthStatus>("/api/auth"),
  login: (method: "browser" | "device") => post<AuthStatus>("/api/auth/login", { method }),
  loginInput: (value: string) => post<AuthStatus>("/api/auth/login/input", { value }),
  cancelLogin: () => post<AuthStatus>("/api/auth/cancel"),
  logout: () => post<AuthStatus>("/api/auth/logout"),
  patients: () => request<PatientSummary[]>("/api/patients"),
  document: (patientId: string, id: string) =>
    request<PatientDocument>(of(patientId, `/documents/${encodeURIComponent(id)}`)),
  screen: (patientId: string, situation: string, signal?: AbortSignal) =>
    post<ScreenResponse>(of(patientId, "/screens"), { situation }, signal),
  answer: (patientId: string, situation: string, question: string) =>
    post<Answer>(of(patientId, "/answers"), { situation, question }),
  notes: (patientId: string) => request<Note[]>(of(patientId, "/notes")),
  addNote: (patientId: string, note: Pick<Note, "topic" | "text" | "source" | "clarifies">) =>
    post<Note>(of(patientId, "/notes"), note),
  removeNote: (patientId: string, id: string) =>
    request<unknown>(of(patientId, `/notes/${encodeURIComponent(id)}`), { method: "DELETE" }),
};
