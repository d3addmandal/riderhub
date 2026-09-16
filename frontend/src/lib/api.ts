import { getIdToken } from './firebase';

const API_URL = import.meta.env.VITE_API_URL || '';

async function getHeaders(): Promise<HeadersInit> {
  const token = await getIdToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = await getHeaders();
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(typeof err.error === 'string' ? err.error : 'Request failed');
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

/**
 * Fetch binary content as an object URL.
 *
 * Place photos are proxied through our own API so the Google key never reaches the
 * browser — which means the request needs an Authorization header, and a plain
 * `<img src>` cannot send one. So the bytes are fetched here and handed to the image
 * tag as a blob URL instead. Callers must revoke the URL when they are done with it.
 */
async function blobUrl(path: string): Promise<string> {
  const token = await getIdToken();
  const res = await fetch(`${API_URL}/api${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Image failed (${res.status})`);
  return URL.createObjectURL(await res.blob());
}

export const api = {
  blobUrl,
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

