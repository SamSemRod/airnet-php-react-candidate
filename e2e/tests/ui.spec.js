import { test, expect } from './fixtures.js';

async function login(page, role) {
  await page.goto('/');
  await page.getByLabel('Учебная роль').selectOption(role);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(row(page, 105)).toBeVisible();
}

const row = (page, id) => page.getByRole('button', { name: new RegExp(`^#${id}\\D`) });
const card = page => page.getByRole('region', { name: 'Карточка заявки' });
const title = page => card(page).getByRole('heading', { level: 2 });

// Задерживает ответ на запрос до вызова release(), независимо от DEMO_LATENCY на сервере.
async function hold(page, method, pathname) {
  let release;
  const released = new Promise(resolve => { release = resolve; });
  const delivered = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === pathname);
  await page.route(url => url.pathname === pathname, async route => {
    if (route.request().method() !== method) return route.fallback();
    const response = await route.fetch();
    await released;
    await route.fulfill({ response });
  });
  return async () => {
    release();
    await delivered;
    // Даём React обработать поздний ответ.
    await page.waitForTimeout(300);
  };
}

test('поздний ответ загрузки не подменяет выбранную карточку', async ({ page }) => {
  await login(page, 'viewer');
  const release101 = await hold(page, 'GET', '/api/tickets/101');
  await row(page, 101).click();
  await row(page, 102).click();
  await expect(title(page)).toHaveText('Настроить роутер');
  await release101();
  await expect(title(page)).toHaveText('Настроить роутер');
  await expect(card(page)).toContainText('Заявка #102');
});

test('ответ сохранения предыдущей заявки не подменяет текущую карточку', async ({ page }) => {
  await login(page, 'editor');
  await row(page, 105).click();
  await expect(title(page)).toHaveText('Перенести точку подключения');
  await card(page).getByLabel('Источник заявки').selectOption({ label: 'Сотрудник' });

  const releaseSave = await hold(page, 'POST', '/api/tickets/105/source');
  await card(page).getByRole('button', { name: 'Сохранить' }).click();
  await row(page, 102).click();
  await expect(title(page)).toHaveText('Настроить роутер');
  await releaseSave();

  await expect(title(page)).toHaveText('Настроить роутер');
  await expect(card(page).getByLabel('Источник заявки')).toHaveValue('2');
  await expect(card(page)).not.toContainText('Источник сохранён');
  // Список при этом обновлён по сохранённой заявке.
  await expect(row(page, 105)).toContainText('Сотрудник');
});

test('во время сохранения повторная отправка невозможна', async ({ page }) => {
  await login(page, 'editor');
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/tickets/105/source')) posts++; });
  await row(page, 105).click();
  await card(page).getByLabel('Источник заявки').selectOption({ label: 'Сотрудник' });

  const releaseSave = await hold(page, 'POST', '/api/tickets/105/source');
  const button = card(page).getByRole('button', { name: /Сохран/ });
  await button.click();
  await expect(button).toBeDisabled();
  await expect(button).toHaveText('Сохранение…');
  await releaseSave();
  await expect(card(page)).toContainText('Источник сохранён');
  expect(posts).toBe(1);
});

test('заявка без источника показывает «Не указан»', async ({ page }) => {
  await login(page, 'viewer');
  await row(page, 103).click();
  await expect(title(page)).toHaveText('Нет изображения с камеры');
  await expect(card(page).locator('.source-box')).toContainText('Не указан');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(row(page, 103)).toContainText('Не указан');
});

test('после сохранения обновляются карточка, список и история', async ({ page }) => {
  await login(page, 'editor');
  await row(page, 105).click();
  await expect(card(page)).toContainText('Изменений пока нет.');
  await card(page).getByLabel('Источник заявки').selectOption({ label: 'Сотрудник' });
  await card(page).getByRole('button', { name: 'Сохранить' }).click();

  await expect(card(page)).toContainText('Источник сохранён');
  await expect(card(page).getByLabel('Источник заявки')).toHaveValue('3');
  const history = card(page).locator('.history li');
  await expect(history).toHaveCount(1);
  await expect(history.first()).toContainText('Илья Учебный');
  await expect(history.first()).toContainText('Телефон → Сотрудник');
  await expect(row(page, 105)).toContainText('Сотрудник');
});

test('просмотр и архив доступны только для чтения', async ({ page }) => {
  await login(page, 'viewer');
  await row(page, 105).click();
  await expect(title(page)).toHaveText('Перенести точку подключения');
  await expect(card(page).getByRole('button', { name: 'Сохранить' })).toHaveCount(0);

  await login(page, 'editor');
  await row(page, 104).click();
  await expect(title(page)).toHaveText('Заменить блок питания');
  await expect(card(page).getByRole('button', { name: 'Сохранить' })).toHaveCount(0);
  await expect(card(page)).toContainText('Архивная заявка доступна только для чтения.');
});

test('ошибка загрузки карточки показывается пользователю', async ({ page }) => {
  await login(page, 'viewer');
  await page.route(url => url.pathname === '/api/tickets/102', route => route.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error', message: 'Не удалось обработать запрос' }),
  }));
  await row(page, 102).click();
  await expect(card(page).getByRole('alert')).toHaveText('Не удалось обработать запрос');
  await expect(card(page)).not.toContainText('Загрузка карточки');
});
