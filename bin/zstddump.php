#!/usr/bin/env php
<?php
/**
 * CLI decoder used when in-process FFI is unavailable.
 *
 * PHP-FPM runs with `ffi.enable=preload`, so libzstd cannot be called from a web
 * request; the CLI SAPI allows it. This helper reads a compressed segment on
 * stdin and writes:
 *
 *   {"offset":<input bytes consumed>}\n<decoded text>
 *
 * The offset marks the last complete frame, which lets the caller resume from
 * there on the next poll instead of re-decoding the whole log. Bytes arrive over
 * stdin, so the helper performs no filesystem access of its own.
 */
require __DIR__ . '/../lib/Zstd.php';

$raw = stream_get_contents(STDIN);
if ($raw === false) {
    fwrite(STDERR, "zstddump: cannot read stdin\n");
    exit(1);
}

try {
    [$text, $consumed] = Zstd::decompressCounted($raw, true);
} catch (Throwable $e) {
    fwrite(STDERR, 'zstddump: ' . $e->getMessage() . "\n");
    exit(2);
}

echo json_encode(['offset' => $consumed]), "\n", $text;
