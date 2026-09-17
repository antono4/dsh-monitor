<?php
/**
 * JSON API for the Mission Control UI.
 *
 *   GET /api.php?action=live[&id=<root-session-id>]
 *
 * Without ?id it reports the newest root session — one that nobody delegated.
 */
declare(strict_types=1);

require __DIR__ . '/lib/Zstd.php';
require __DIR__ . '/lib/LiveMonitor.php';

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

// DSH writes its logs to $HOME/.dsh. PHP-FPM does not always export HOME, so fall
// back to the account's home directory out of the password database.
$home = getenv('HOME');
if ($home === false || $home === '') {
    $home = (string) (posix_getpwuid(posix_geteuid())['dir'] ?? '');
}

try {
    $action = (string) ($_GET['action'] ?? 'live');
    if ($action !== 'live') {
        // A bad parameter is the caller's mistake, not a server fault: 400, not 500.
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => "Unknown action: $action"]);
        exit;
    }

    $id = (string) ($_GET['id'] ?? '');
    if ($id === '') {
        // Default to the newest root session (a session nobody delegated).
        $monitor = new LiveMonitor($home);
        $roots = array_filter($monitor->headers(), fn($h) => $h['parentId'] === null);
        usort($roots, fn($a, $b) => ($b['createdAt'] ?? 0) <=> ($a['createdAt'] ?? 0));
        $id = $roots[0]['id'] ?? '';
    }
    if ($id === '') {
        http_response_code(404);
        echo json_encode(['ok' => false, 'error' => 'No session logs found.']);
        exit;
    }

    // The id is only ever used as a key into the header map, never a path, so
    // there is no traversal surface here.
    $snapshot = (new LiveMonitor($home))->snapshot($id);
    if (!($snapshot['ok'] ?? false)) {
        http_response_code(404);
    }

    // JSON_HEX_TAG | JSON_HEX_AMP so the output stays safe if a caller ever inlines
    // it in a <script> block — the payload carries session text, which is untrusted.
    echo json_encode(
        $snapshot,
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
        | JSON_INVALID_UTF8_SUBSTITUTE | JSON_HEX_TAG | JSON_HEX_AMP
    );
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}
