import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, expect, request } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const resetSql = readFileSync(`${root}/database/reset.sql`);

// Для запуска без Docker: DB_RESET_CMD="psql -v ON_ERROR_STOP=1 -q" (SQL подаётся в stdin).
const resetCommand = process.env.DB_RESET_CMD
  || 'docker compose exec -T db psql -U assessment -d airnet_assessment -v ON_ERROR_STOP=1 -q';

export function resetDb() {
  execSync(resetCommand, { cwd: root, input: resetSql, stdio: ['pipe', 'ignore', 'inherit'] });
}

async function apiSession(baseURL, role) {
  const context = await request.newContext({ baseURL });
  const response = await context.post('/api/demo/login', { data: { role } });
  expect(response.status()).toBe(200);
  const { csrf } = await response.json();
  return {
    context,
    get: path => context.get(`/api${path}`),
    // body: объект (отправляется как JSON) или строка (отправляется как есть).
    changeSource: (id, body) => context.post(`/api/tickets/${id}/source`, {
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      data: body,
    }),
    ticket: async id => (await context.get(`/api/tickets/${id}`)).json(),
  };
}

export const test = base.extend({
  freshDb: [async ({}, use) => {
    resetDb();
    await use();
  }, { auto: true }],
  editor: async ({ baseURL }, use) => {
    const session = await apiSession(baseURL, 'editor');
    await use(session);
    await session.context.dispose();
  },
  viewer: async ({ baseURL }, use) => {
    const session = await apiSession(baseURL, 'viewer');
    await use(session);
    await session.context.dispose();
  },
  guest: async ({ baseURL }, use) => {
    const context = await request.newContext({ baseURL });
    await use(context);
    await context.dispose();
  },
});

export { expect };

export async function expectJsonError(response, status) {
  expect(response.status()).toBe(status);
  expect(response.headers()['content-type']).toContain('application/json');
  const body = await response.json();
  expect(typeof body.error).toBe('string');
  return body;
}
