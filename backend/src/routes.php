<?php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'];

if ($path === '/api/health' && $method === 'GET') {
    query('SELECT 1');
    respond(200, array('status' => 'ok', 'php' => PHP_VERSION));
}

if ($path === '/api/demo/login' && $method === 'POST') {
    $body = requestBody();
    $role = isset($body['role']) ? $body['role'] : '';
    if (!in_array($role, array('viewer', 'editor'), true)) {
        respond(400, array('error' => 'invalid_role', 'message' => 'Неизвестная учебная роль'));
    }
    $employee = pg_fetch_assoc(query('SELECT id FROM employees WHERE role=$1', array($role)));
    session_regenerate_id(true);
    $_SESSION['employee_id'] = (int) $employee['id'];
    $_SESSION['csrf'] = bin2hex(random_bytes(24));
    respond(200, array('employee' => currentEmployee(), 'csrf' => $_SESSION['csrf']));
}

$employee = currentEmployee();

if ($path === '/api/me' && $method === 'GET') {
    respond(200, array('employee' => $employee, 'csrf' => $_SESSION['csrf']));
}

requirePermission($employee, 'FUNC_TICKETS_VIEW');
$repository = new TicketRepository();

if ($path === '/api/tickets' && $method === 'GET') {
    respond(200, array('tickets' => $repository->all()));
}
if ($path === '/api/sources' && $method === 'GET') {
    respond(200, array('sources' => $repository->sources()));
}
if (preg_match('~^/api/tickets/([1-9][0-9]*)$~', $path, $matches) && $method === 'GET') {
    $id = (int) $matches[1];
    session_write_close();
    if (getenv('DEMO_LATENCY') === '1') {
        usleep($id === 101 ? 1100000 : 100000);
    }
    $ticket = $id > PG_INT_MAX ? null : $repository->find($id);
    if (!$ticket) {
        respond(404, array('error' => 'not_found', 'message' => 'Заявка не найдена'));
    }
    respond(200, array('ticket' => $ticket, 'history' => $repository->history($id)));
}
if (preg_match('~^/api/tickets/([1-9][0-9]*)/source$~', $path, $matches) && $method === 'POST') {
    // Право проверяется до чтения заявки и тела запроса; полномочия берутся только из серверной сессии.
    requirePermission($employee, 'FUNC_TICKETS_SOURCE_EDIT');
    requireCsrf();
    $id = (int) $matches[1];
    if ($id > PG_INT_MAX) {
        respond(404, array('error' => 'not_found', 'message' => 'Заявка не найдена'));
    }
    // Некорректный ввод (не JSON, нет поля, строка, дробь, null...) превращается в null,
    // а 400 возвращает репозиторий после проверок заявки и архива.
    $body = json_decode(file_get_contents('php://input'), true);
    $sourceId = is_array($body) && isset($body['source_id']) ? $body['source_id'] : null;
    if (!is_int($sourceId) || $sourceId <= 0 || $sourceId > PG_INT_MAX) {
        $sourceId = null;
    }
    $ticket = $repository->changeSource($id, $sourceId, $employee);
    respond(200, array('ticket' => $ticket, 'history' => $repository->history($ticket['id'])));
}
respond(404, array('error' => 'not_found', 'message' => 'Маршрут не найден'));
