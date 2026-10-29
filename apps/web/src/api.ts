import type {
  AuthStatus,
  ErrorResponse,
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
  if (!response.ok)
    throw new ApiError(response.status, (body as ErrorResponse).error ?? response.statusText);
  return body as T;
}

const post = <T>(path: string, body: object = {}) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  auth: () => request<AuthStatus>("/api/auth"),
  login: (method: "browser" | "device") => post<AuthStatus>("/api/auth/login", { method }),
  loginInput: (value: string) => post<AuthStatus>("/api/auth/login/input", { value }),
  cancelLogin: () => post<AuthStatus>("/api/auth/cancel"),
  logout: () => post<AuthStatus>("/api/auth/logout"),
  patient: () => request<PatientSummary>("/api/patient"),
  document: (id: string) => request<PatientDocument>(`/api/documents/${encodeURIComponent(id)}`),
  screen: (situation: string) => post<ScreenResponse>("/api/screens", { situation }),
};
