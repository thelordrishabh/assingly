export type DemoUser = { id: string; display_name: string; role: 'STUDENT' | 'GUARDIAN' | 'MODERATOR'; age: number; campus: string | null; verified_at: string | null };

const selectedKey = 'assingly.demoUser';
export const selectedUserId = () => localStorage.getItem(selectedKey) || 'stu-aanya';
export const setSelectedUserId = (id: string) => localStorage.setItem(selectedKey, id);

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('X-Demo-User', selectedUserId());
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || 'Something went wrong.');
  return payload as T;
}

export const money = (value: number) => new Intl.NumberFormat('en-IN').format(value || 0);
export const date = (value: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
