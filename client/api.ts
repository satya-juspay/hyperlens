import { useEffect, useState } from 'react';

export async function request<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request could not be completed.');
  return data as T;
}

export function useResource<T>(url: string | null, version?: string | null) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: '' });
  const key = url ? JSON.stringify([url, version]) : '';
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    request<T>(url, controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ key, data });
    }, error => {
      if (!controller.signal.aborted) setState({ key, error: error.message });
    });
    return () => controller.abort();
  }, [url, key]);
  return state.key === key ? { ...state, loading: false } : { data: undefined, error: undefined, loading: !!url };
}

export function useDebounced(text: string, delay = 160): string {
  const [value, setValue] = useState(text);
  useEffect(() => {
    const handle = setTimeout(() => setValue(text), delay);
    return () => clearTimeout(handle);
  }, [text, delay]);
  return value;
}
