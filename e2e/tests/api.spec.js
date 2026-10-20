import { request } from '@playwright/test';
import { test, expect, expectJsonError } from './fixtures.js';

// Состояние заявки, по которому проверяем «отказ ничего не изменил».
async function snapshot(session, id) {
  const { ticket, history } = await session.ticket(id);
  return { source: ticket.source, updated_at: ticket.updated_at, history };
}

test.describe('Карточка без источника', () => {
  test('заявка 103 открывается, source = null', async ({ viewer }) => {
    const response = await viewer.get('/tickets/103');
    expect(response.status()).toBe(200);
    const { ticket, history } = await response.json();
    expect(ticket).toMatchObject({ id: 103, source: null });
    expect(history).toEqual([]);
  });

  test('в списке у заявки 103 source_name = null', async ({ viewer }) => {
    const { tickets } = await (await viewer.get('/tickets')).json();
    expect(tickets.find(row => row.id === 103).source_name).toBeNull();
  });
});

test.describe('Права', () => {
  test('просмотр видит список, карточку и историю', async ({ viewer }) => {
    for (const path of ['/tickets', '/sources', '/tickets/101', '/tickets/104']) {
      expect((await viewer.get(path)).status(), path).toBe(200);
    }
  });

  test('просмотр не может изменить источник', async ({ viewer }) => {
    const before = await snapshot(viewer, 105);
    await expectJsonError(await viewer.changeSource(105, { source_id: 2 }), 403);
    expect(await snapshot(viewer, 105)).toEqual(before);
  });

  test('клиентские поля сотрудника и прав не дают полномочий', async ({ viewer }) => {
    const before = await snapshot(viewer, 105);
    const forged = { source_id: 2, employee_id: 2, employee: { id: 2, role: 'editor' }, role: 'editor', permissions: ['FUNC_TICKETS_SOURCE_EDIT'] };
    await expectJsonError(await viewer.changeSource(105, forged), 403);
    expect(await snapshot(viewer, 105)).toEqual(before);
  });

  test('право проверяется раньше заявки и ввода', async ({ viewer }) => {
    await expectJsonError(await viewer.changeSource(999, { source_id: 2 }), 403);
    await expectJsonError(await viewer.changeSource(105, { source_id: 'x' }), 403);
  });

  test('без сессии — 401', async ({ guest }) => {
    for (const path of ['/me', '/tickets', '/sources', '/tickets/101']) {
      await expectJsonError(await guest.get(`/api${path}`), 401);
    }
    await expectJsonError(await guest.post('/api/tickets/105/source', { data: { source_id: 2 } }), 401);
  });
});

test.describe('Архивная заявка', () => {
  test('редактор не может изменить архивную заявку', async ({ editor }) => {
    const before = await snapshot(editor, 104);
    await expectJsonError(await editor.changeSource(104, { source_id: 1 }), 403);
    expect(await snapshot(editor, 104)).toEqual(before);
  });
});

test.describe('Проверка нового источника', () => {
  const invalid = [
    ['строка', { source_id: '2' }],
    ['дробь', { source_id: 2.5 }],
    ['дробь с нулём', '{"source_id": 2.0}'],
    ['null', { source_id: null }],
    ['поле отсутствует', {}],
    ['ноль', { source_id: 0 }],
    ['отрицательный', { source_id: -1 }],
    ['boolean', { source_id: true }],
    ['массив', { source_id: [2] }],
    ['неизвестный id', { source_id: 99 }],
    ['не JSON', 'source_id=2'],
    ['JSON не объект', '[2]'],
  ];
  for (const [name, body] of invalid) {
    test(`400: ${name}`, async ({ editor }) => {
      const before = await snapshot(editor, 105);
      await expectJsonError(await editor.changeSource(105, body), 400);
      expect(await snapshot(editor, 105)).toEqual(before);
    });
  }
});

test.describe('Порядок проверок для редактора', () => {
  test('нет заявки → 404 раньше проверки источника', async ({ editor }) => {
    await expectJsonError(await editor.changeSource(999, { source_id: 'x' }), 404);
    await expectJsonError(await editor.changeSource(999, { source_id: 2 }), 404);
  });

  test('архив → 403 раньше проверки источника', async ({ editor }) => {
    await expectJsonError(await editor.changeSource(104, { source_id: 'x' }), 403);
    await expectJsonError(await editor.changeSource(104, '{bad json'), 403);
  });
});

test.describe('Успешная смена источника', () => {
  test('меняет источник и пишет историю с сотрудником из сессии', async ({ editor }) => {
    const response = await editor.changeSource(105, { source_id: 3, employee_id: 1, employee_name: 'Подделка' });
    expect(response.status()).toBe(200);
    const { ticket, history } = await response.json();
    expect(ticket.source).toEqual({ id: 3, name: 'Сотрудник' });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ employee_id: 2, employee_name: 'Илья Учебный', old_source_id: 1, new_source_id: 3 });
    expect(history[0].created_at).toMatch(/([+-]\d{2}(:?\d{2})?|Z)$/);

    expect(await editor.ticket(105)).toEqual({ ticket, history });
    const { tickets } = await (await editor.get('/tickets')).json();
    expect(tickets.find(row => row.id === 105).source_name).toBe('Сотрудник');
  });

  test('заявке без источника можно назначить источник', async ({ editor }) => {
    const response = await editor.changeSource(103, { source_id: 1 });
    expect(response.status()).toBe(200);
    const { ticket, history } = await response.json();
    expect(ticket.source).toEqual({ id: 1, name: 'Телефон' });
    expect(history[0]).toMatchObject({ old_source_id: null, new_source_id: 1 });
  });

  test('повторный выбор текущего источника — успех без записи истории', async ({ editor }) => {
    const before = await snapshot(editor, 102);
    const response = await editor.changeSource(102, { source_id: 2 });
    expect(response.status()).toBe(200);
    const { ticket, history } = await response.json();
    expect(ticket.source).toEqual({ id: 2, name: 'Личный кабинет' });
    expect(history).toEqual([]);
    expect(await snapshot(editor, 102)).toEqual(before);
  });

  test('параллельные изменения дают непрерывную цепочку истории', async ({ editor, baseURL }) => {
    // Вторая сессия того же редактора — отдельная PHP-сессия, запросы не сериализуются блокировкой сессии.
    const second = await request.newContext({ baseURL });
    const { csrf } = await (await second.post('/api/demo/login', { data: { role: 'editor' } })).json();
    for (let round = 0; round < 5; round++) {
      const [a, b] = await Promise.all([
        editor.changeSource(105, { source_id: 2 }),
        second.post('/api/tickets/105/source', { headers: { 'X-CSRF-Token': csrf }, data: { source_id: 3 } }),
      ]);
      expect([a.status(), b.status()]).toEqual([200, 200]);
    }
    await second.dispose();
    const { ticket, history } = await editor.ticket(105);
    expect(history[0].new_source_id).toBe(ticket.source.id);
    for (let i = 0; i < history.length - 1; i++) {
      expect(history[i].old_source_id, `запись ${history[i].id}`).toBe(history[i + 1].new_source_id);
      expect(history[i].old_source_id).not.toBe(history[i].new_source_id);
    }
  });
});

test.describe('Прочие ошибки', () => {
  test('нет заявки при просмотре — 404 JSON', async ({ viewer }) => {
    await expectJsonError(await viewer.get('/tickets/999'), 404);
  });

  test('неизвестный маршрут — 404 JSON', async ({ viewer }) => {
    await expectJsonError(await viewer.get('/nope'), 404);
  });

  test('без CSRF-токена изменение отклоняется', async ({ editor }) => {
    const before = await snapshot(editor, 105);
    const response = await editor.context.post('/api/tickets/105/source', { data: { source_id: 2 } });
    await expectJsonError(response, 403);
    expect(await snapshot(editor, 105)).toEqual(before);
  });
});
