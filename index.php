<?php
/**
 * DSH Mission Control — a live, visual monitor of an agent and the sub-agents it
 * delegates to.
 *
 *   https://harness-demo.test/
 *
 * This is the site root. Renders the shell plus an initial snapshot, then polls
 * api.php?action=live and redraws. Read-only with respect to ~/.dsh.
 *
 * Layout: one screen, no page scroll. A gapless mosaic — panels are separated by
 * 1px rules rather than gaps, tinted by hue, and only the feed scrolls.
 */
declare(strict_types=1);

require __DIR__ . '/lib/Zstd.php';
require __DIR__ . '/lib/LiveMonitor.php';

// DSH writes its logs to $HOME/.dsh. PHP-FPM does not always export HOME, so fall
// back to the account's home directory out of the password database.
$home = getenv('HOME');
if ($home === false || $home === '') {
    $home = (string) (posix_getpwuid(posix_geteuid())['dir'] ?? '');
}
$monitor = new LiveMonitor($home);

// Default to the newest root session — one that nobody delegated.
$roots = array_values(array_filter($monitor->headers(), fn($h) => $h['parentId'] === null));
usort($roots, fn($a, $b) => ($b['createdAt'] ?? 0) <=> ($a['createdAt'] ?? 0));

$requested = (string) ($_GET['id'] ?? '');
$rootId = $requested !== '' ? $requested : ($roots[0]['id'] ?? '');
$snapshot = $rootId !== '' ? $monitor->snapshot($rootId) : ['ok' => false, 'error' => 'No session logs found.'];

function h(?string $s): string
{
    return htmlspecialchars((string) $s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Mission Control</title>
<link rel="stylesheet" href="assets/monitor.css?v=4">
</head>
<body>
<div class="mc">

    <header class="mc-top">
        <span class="mc-logo"></span>
        <div class="mc-brand">
            <h1>DSH Mission Control</h1>
            <p id="root-title"><?= h((string) ($snapshot['root']['label'] ?? 'no session')) ?></p>
        </div>
        <div class="mc-controls">
            <span class="mc-live" id="live-dot"><i></i><b>LIVE</b></span>
            <span class="mc-clock" id="clock">--:--:--</span>
            <button class="mc-btn" id="follow" title="Hop to a newer session when one starts">follow: —</button>
            <button class="mc-btn" id="finished" title="Show or hide agents that have finished">finished: —</button>
            <button class="mc-btn" id="pause">pause</button>
        </div>
    </header>

    <section class="tiles" id="tiles"></section>

    <section class="stage">
        <div class="panel p-graph">
            <div class="panel-head">
                <span class="ph-dot"></span>agent constellation
                <span class="panel-hint" id="graph-hint"></span>
            </div>
            <div class="graph-wrap">
                <svg id="graph" preserveAspectRatio="xMidYMid meet"></svg>
            </div>
            <div class="legend">
                <span><i class="lg-robot" style="color:#ffb454"></i>working</span>
                <span><i class="lg-robot" style="color:#37c98b"></i>done</span>
                <span><i class="lg-robot" style="color:#4fa3ff"></i>starting</span>
                <span class="lg-sep"></span>
                <span class="lg-note">
                    <b class="lg-sig">●▸</b> signal flows to an agent while it works,
                    and back to <b>main</b> when it hands in its result
                </span>
            </div>
            <div class="now" id="now"><span class="now-label">now</span><span class="now-text">waiting…</span></div>
        </div>

        <div class="panel p-feed">
            <div class="panel-head">
                <span class="ph-dot"></span>live activity
                <span class="panel-hint" id="feed-hint"></span>
            </div>
            <ol class="feed" id="feed"></ol>
        </div>
    </section>

    <section class="panel p-roster">
        <div class="panel-head">
            <span class="ph-dot"></span>agents
            <span class="panel-hint">delegated work</span>
        </div>
        <div class="roster" id="agent-cards"></div>
    </section>

</div>

<script>
window.__MONITOR_INIT__ = <?= json_encode($snapshot, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP) ?>;
// Loaded without an explicit ?id → follow whichever session is newest.
window.__MONITOR_FOLLOW__ = <?= $requested === '' ? 'true' : 'false' ?>;
</script>
<script src="assets/monitor.js?v=4"></script>
</body>
</html>
