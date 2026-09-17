<?php
/**
 * Live snapshot of an agent and everything it delegated to.
 *
 * Reads the DSH session logs and computes only what the monitor needs — counters,
 * current tool, recent events, status — so it stays cheap enough to poll. Sub-agent sessions are separate logs linked by the
 * `parentSession` field in the session header, and announced in the parent by
 * `subagent/catalog` events that carry a human label.
 */
final class LiveMonitor
{
    private const RECENT_PER_AGENT = 12;

    /**
     * How long an open turn may stay silent with no tool running before it is called
     * stalled. Well past the 20–60 s a model call can take, so it never fires on an
     * agent that is merely thinking.
     */
    private const STALLED_MS = 300000;

    /** Per-request memo of headers(), keyed by DSH home. */
    private static array $headersMemo = [];

    public function __construct(private string $home)
    {
    }

    private function sessionsRoot(): string
    {
        return $this->home . '/.dsh/sessions';
    }

    /**
     * Every session log on disk with its header facts.
     *
     * Memoised per request: index.php and api.php each ask for this more than
     * once (to pick a default root, then to walk the tree), and re-globbing plus
     * re-reading every header on a 1.5s poll is pure waste.
     *
     * @return array<string, array> keyed by session id
     */
    public function headers(): array
    {
        if (isset(self::$headersMemo[$this->home])) {
            return self::$headersMemo[$this->home];
        }

        $out = [];
        foreach (glob($this->sessionsRoot() . '/*/*/session.v*.jsonl.zstd') ?: [] as $file) {
            $id = basename(dirname($file));
            $head = [];
            try {
                $text = Zstd::decompressedCached($file);
                $nl = strpos($text, "\n");
                $head = json_decode($nl === false ? $text : substr($text, 0, $nl), true) ?: [];
            } catch (Throwable $e) {
                continue;
            }
            $out[$id] = [
                'id' => $id,
                'path' => $file,
                'parentId' => $head['parentSession'] ?? null,
                'depth' => (int) ($head['delegationDepth'] ?? 0),
                'origin' => $head['origin'] ?? 'root',
                'createdAt' => $head['createdAt'] ?? null,
                'cwd' => $head['cwd'] ?? null,
                'preset' => $head['agentPreset'] ?? null,
                'modifiedAt' => (int) @filemtime($file) * 1000,
                'sizeBytes' => (int) @filesize($file),
            ];
        }

        // Keep var/cache in step with the logs that actually exist: decoding a log
        // creates a cache trio, so a deleted session should remove it again. Runs at
        // most once per request because headers() is memoised.
        Zstd::pruneOrphans(array_column($out, 'path'));

        return self::$headersMemo[$this->home] = $out;
    }

    /**
     * Live snapshot rooted at $rootId: root summary, the agent tree and a merged
     * recent-event feed.
     */
    public function snapshot(string $rootId): array
    {
        $headers = $this->headers();
        if (!isset($headers[$rootId])) {
            return ['ok' => false, 'error' => 'Unknown session: ' . $rootId];
        }

        // Collect the root plus every descendant, following parentSession links.
        $ids = [$rootId];
        $changed = true;
        while ($changed) {
            $changed = false;
            foreach ($headers as $id => $h) {
                if (!in_array($id, $ids, true) && in_array($h['parentId'], $ids, true)) {
                    $ids[] = $id;
                    $changed = true;
                }
            }
        }

        $agents = [];
        $labels = [];
        $feed = [];

        foreach ($ids as $id) {
            $agent = $this->scanAgent($headers[$id]);
            $agents[$id] = $agent;
            foreach ($agent['childLabels'] as $childId => $label) {
                $labels[$childId] = $label;
            }
            unset($agent['childLabels']);
            $agents[$id] = $agent;

            foreach ($agent['recent'] as $ev) {
                $ev['agentId'] = $id;
                $feed[] = $ev;
            }
        }

        // Prefer the label announced by the parent; fall back to the child's own.
        foreach ($agents as $id => &$a) {
            if (isset($labels[$id])) {
                $a['label'] = $labels[$id];
            }
            $a['isChild'] = $id !== $rootId;
        }
        unset($a);

        // Newest first, capped.
        usort($feed, fn($x, $y) => ($y['time'] ?? 0) <=> ($x['time'] ?? 0));
        $feed = array_slice($feed, 0, 40);

        $now = (int) round(microtime(true) * 1000);
        foreach ($agents as &$a) {
            // quietMs must be set before statusFor(): "stalled" is a judgement about
            // how long the log has been silent, so the status depends on it.
            $a['elapsedMs'] = $a['createdAt'] ? $now - $a['createdAt'] : null;
            $a['quietMs'] = $a['lastEventAt'] ? $now - $a['lastEventAt'] : null;
            $a['status'] = $this->statusFor($a);
        }
        unset($a);

        $root = $agents[$rootId];
        $childIds = array_values(array_filter($ids, fn($i) => $i !== $rootId));
        $working = 0;
        $done = 0;
        $stalled = 0;
        foreach ($childIds as $cid) {
            if ($agents[$cid]['status'] === 'working') {
                $working++;
            } elseif ($agents[$cid]['status'] === 'done') {
                $done++;
            } elseif ($agents[$cid]['status'] === 'stalled') {
                $stalled++;
            }
        }

        return [
            'ok' => true,
            'now' => $now,
            'rootId' => $rootId,
            'root' => $root,
            'agents' => array_values($agents),
            'summary' => [
                'subagents' => count($childIds),
                'working' => $working,
                'done' => $done,
                'stalled' => $stalled,
                'children' => $childIds,
            ],
            'feed' => $feed,
        ];
    }

    /**
     * working | stalled | done | starting.
     *
     * A working agent writes nothing while it waits on the model, so silence alone
     * proves nothing — 20–60 s gaps are normal and must not read as a hang.
     *
     * Two things together do mean the turn is never coming back: a long silence AND
     * no tool in flight. A slow command holds `currentTool` for its whole run, so a
     * genuinely long tool call is never mislabelled; whereas an interrupted
     * continuable sub-agent can leave a turn/start behind with nothing running, and
     * no future event will ever balance the count. Without this the robot sits on
     * the constellation as "working" forever.
     */
    private function statusFor(array $a): string
    {
        if ($a['openTurn']) {
            if ($a['currentTool'] === null
                && $a['quietMs'] !== null
                && $a['quietMs'] > self::STALLED_MS) {
                return 'stalled';
            }
            return 'working';
        }
        return $a['turnEnds'] > 0 ? 'done' : 'starting';
    }

    /** Single pass over one session log producing monitor-sized facts. */
    private function scanAgent(array $h): array
    {
        $records = Zstd::readJsonl($h['path']);

        $agent = [
            'id' => $h['id'],
            'depth' => $h['depth'],
            'parentId' => $h['parentId'],
            'origin' => $h['origin'],
            'createdAt' => $h['createdAt'],
            'modifiedAt' => $h['modifiedAt'],
            'sizeBytes' => $h['sizeBytes'],
            'cwd' => $h['cwd'],
            'preset' => $h['preset'],
            'label' => null,
            'title' => null,
            'model' => null,
            'turnEnds' => 0,
            'turnStarts' => 0,
            'steps' => 0,
            'toolCalls' => 0,
            'errors' => 0,
            'byTool' => [],
            'tokens' => ['inputTokens' => 0, 'outputTokens' => 0, 'cacheReadTokens' => 0],
            'openTurn' => false,
            'lastEventAt' => null,
            'lastEventType' => null,
            'currentTool' => null,
            'lastText' => null,
            'filesTouched' => [],
            'childLabels' => [],
            'recent' => [],
        ];

        $recent = [];
        $pending = [];   // callId => index in $recent

        foreach ($records as $r) {
            $type = $r['type'] ?? '';
            $time = $r['time'] ?? null;
            $d = $r['data'] ?? [];
            if ($time !== null) {
                $agent['lastEventAt'] = $time;
            }
            $agent['lastEventType'] = $type;

            switch ($type) {
                case 'session':
                    $agent['createdAt'] ??= $r['createdAt'] ?? null;
                    $agent['cwd'] ??= $r['cwd'] ?? null;
                    break;

                case 'subagent/descriptor':
                    $agent['label'] = $d['label'] ?? $agent['label'];
                    $agent['model'] = $d['agentModel'] ?? $agent['model'];
                    break;

                case 'subagent/catalog':
                    if (!empty($d['childId'])) {
                        $agent['childLabels'][$d['childId']] = $d['label'] ?? $d['childId'];
                    }
                    break;

                case 'session/title':
                    if (!empty($d['title'])) {
                        $agent['title'] = $d['title'];
                    }
                    break;

                case 'request/context':
                    $agent['model'] = $d['model'] ?? $agent['model'];
                    break;

                case 'turn/start':
                    $agent['turnStarts']++;
                    break;

                case 'turn/end':
                    $agent['turnEnds']++;
                    break;

                case 'step/start':
                    $agent['steps']++;
                    break;

                case 'assistant/message':
                    if (is_array($d['usage'] ?? null)) {
                        foreach (['inputTokens', 'outputTokens', 'cacheReadTokens'] as $k) {
                            $agent['tokens'][$k] += (int) ($d['usage'][$k] ?? 0);
                        }
                    }
                    $txt = $this->lastTextPart($d['message']['content'] ?? []);
                    if ($txt !== '') {
                        $agent['lastText'] = mb_substr($txt, 0, 300);
                        $recent[] = [
                            'time' => $time, 'kind' => 'assistant',
                            'summary' => mb_substr(preg_replace('/\s+/', ' ', $txt) ?? '', 0, 160),
                            'status' => 'ok',
                        ];
                    }
                    break;

                case 'user/message':
                    $txt = $this->textOf($d['content'] ?? []);
                    if ($txt !== '') {
                        $injected = ($d['source']['kind'] ?? 'user') !== 'user';
                        $recent[] = [
                            'time' => $time, 'kind' => $injected ? 'injected' : 'user',
                            'summary' => mb_substr(preg_replace('/\s+/', ' ', $txt) ?? '', 0, 160),
                            'status' => 'ok',
                        ];
                    }
                    break;

                case 'tool/call':
                    $name = $d['name'] ?? '?';
                    $agent['toolCalls']++;
                    $agent['byTool'][$name] = ($agent['byTool'][$name] ?? 0) + 1;
                    $rawArgs = $d['arguments'] ?? '';
                    $args = is_string($rawArgs) ? json_decode($rawArgs, true) : $rawArgs;
                    if (is_array($args)) {
                        foreach (['file_path', 'path'] as $k) {
                            if (isset($args[$k]) && is_string($args[$k])) {
                                $agent['filesTouched'][$args[$k]] = true;
                            }
                        }
                    }
                    $idx = count($recent);
                    $recent[] = [
                        'time' => $time, 'kind' => 'tool', 'name' => $name,
                        'summary' => $this->argSummary($name, $args, $rawArgs),
                        'status' => 'running',
                    ];
                    if (!empty($d['callId'])) {
                        $pending[$d['callId']] = $idx;
                    }
                    break;

                case 'tool/result':
                    $callId = $d['message']['content'][0]['toolCallId'] ?? null;
                    $isError = (bool) ($d['message']['content'][0]['isError'] ?? false);
                    if ($isError) {
                        $agent['errors']++;
                    }
                    if ($callId !== null && isset($pending[$callId])) {
                        $recent[$pending[$callId]]['status'] = $isError ? 'error' : 'ok';
                        unset($pending[$callId]);
                    }
                    break;

                case 'deliverables/presented':
                    $n = count($d['files'] ?? []);
                    $recent[] = [
                        'time' => $time, 'kind' => 'deliverable',
                        'summary' => $n . ' file(s) presented', 'status' => 'ok',
                    ];
                    break;

                case 'approval/policy':
                case 'sandbox/mode':
                    $recent[] = [
                        'time' => $time, 'kind' => 'policy',
                        'summary' => str_replace('/', ' ', $type) . ': ' . ($d['policy'] ?? $d['mode'] ?? '?'),
                        'status' => 'ok',
                    ];
                    break;
            }
        }

        $agent['openTurn'] = $agent['turnStarts'] > $agent['turnEnds'];
        $agent['filesTouched'] = array_keys($agent['filesTouched']);

        // The newest still-open tool call is what the agent is doing right now.
        if ($pending) {
            $idx = max($pending);
            $agent['currentTool'] = [
                'name' => $recent[$idx]['name'] ?? '?',
                'summary' => $recent[$idx]['summary'] ?? '',
                'time' => $recent[$idx]['time'] ?? null,
            ];
        }

        $agent['recent'] = array_slice($recent, -self::RECENT_PER_AGENT);
        if ($agent['label'] === null) {
            $agent['label'] = $agent['title'] ?? $agent['id'];
        }

        return $agent;
    }

    private function textOf($content): string
    {
        if (is_string($content)) {
            return $content;
        }
        if (!is_array($content)) {
            return '';
        }
        $parts = [];
        foreach ($content as $c) {
            if (is_array($c) && isset($c['text']) && is_string($c['text'])) {
                $parts[] = $c['text'];
            }
        }
        return implode("\n", $parts);
    }

    /** The last visible (non-reasoning) text part of an assistant message. */
    private function lastTextPart($content): string
    {
        if (!is_array($content)) {
            return '';
        }
        $out = '';
        foreach ($content as $c) {
            if (is_array($c) && ($c['type'] ?? '') === 'text' && isset($c['text'])) {
                $out = (string) $c['text'];
            }
        }
        return $out;
    }

    private function argSummary(string $name, $args, $rawArgs): string
    {
        if (is_array($args)) {
            foreach (['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description'] as $k) {
                if (isset($args[$k]) && is_string($args[$k])) {
                    return mb_substr((string) preg_replace('/\s+/', ' ', $args[$k]), 0, 160);
                }
            }
            if ($name === 'present' && isset($args['files'])) {
                return count($args['files']) . ' file(s)';
            }
        }
        return mb_substr((string) preg_replace('/\s+/', ' ', (string) $rawArgs), 0, 160);
    }
}
