<?php
/**
 * Reader for DSH session logs (`session.vN.jsonl.zstd`).
 *
 * DSH writes these as a series of *concatenated* zstd frames, one per append.
 * PHP has no zstd extension, and node's decoder stops at the first frame, so we
 * drive the already-installed libzstd (1.5.5) through FFI and walk frame by frame
 * with ZSTD_findFrameCompressedSize().
 *
 * PHP-FPM ships `ffi.enable=preload`, which forbids FFI::cdef() in a normal
 * request, so when in-process FFI is unavailable we fall back to a CLI helper
 * (bin/zstddump.php) that uses the very same library. No packages installed and
 * no PHP configuration changed.
 */
final class Zstd
{
    /** ZSTD_error_dstSize_tooSmall — a frame bigger than our buffer, not a truncated log. */
    private const ERR_DST_TOO_SMALL = 70;

    private static ?FFI $ffi = null;
    private static ?bool $inProcessOk = null;

    /** Per-request memo: path -> [byte size, decoded text]. */
    private static array $textMemo = [];

    private static function ffi(): FFI
    {
        if (self::$ffi instanceof FFI) {
            return self::$ffi;
        }
        if (!extension_loaded('FFI')) {
            throw new RuntimeException('PHP FFI extension is not loaded.');
        }
        $last = null;
        foreach (['libzstd.so.1', 'libzstd.so'] as $lib) {
            try {
                self::$ffi = FFI::cdef(<<<C
                    typedef unsigned long size_t;
                    size_t ZSTD_findFrameCompressedSize(const void *src, size_t srcSize);
                    size_t ZSTD_decompress(void *dst, size_t dstCapacity, const void *src, size_t compressedSize);
                    unsigned ZSTD_isError(size_t code);
                    int ZSTD_getErrorCode(size_t code);
                    const char *ZSTD_getErrorName(size_t code);
                C, $lib);
                return self::$ffi;
            } catch (Throwable $e) {
                $last = $e;
            }
        }
        throw new RuntimeException('Cannot load libzstd via FFI: ' . ($last?->getMessage() ?? 'unknown'));
    }

    /** True when this SAPI may call FFI::cdef() (CLI yes, FPM under ffi.enable=preload no). */
    public static function inProcessAvailable(): bool
    {
        if (self::$inProcessOk !== null) {
            return self::$inProcessOk;
        }
        try {
            self::ffi();
            return self::$inProcessOk = true;
        } catch (Throwable $e) {
            return self::$inProcessOk = false;
        }
    }

    /**
     * Decode every concatenated frame in $raw.
     *
     * Tolerant by default: a session log that is still being appended to can end
     * in a partial frame, so a trailing decode failure returns what was decoded
     * instead of throwing.
     */
    public static function decompress(string $raw, bool $tolerant = true): string
    {
        return self::decompressCounted($raw, $tolerant)[0];
    }

    /**
     * As decompress(), but also reports how many *input* bytes were consumed.
     *
     * The count always lands exactly on a frame boundary, so a reader of a log
     * that is still growing can resume from there instead of re-decoding the whole
     * file on every poll. On a tolerant failure the count stops at the first
     * incomplete frame, so that frame is retried next time rather than skipped.
     *
     * @return array{0: string, 1: int} [decoded text, consumed input bytes]
     */
    public static function decompressCounted(string $raw, bool $tolerant = true): array
    {
        $ffi = self::ffi();
        $len = strlen($raw);
        if ($len === 0) {
            return ['', 0];
        }

        // One *owned* buffer for the whole input, addressed per frame. A buffer
        // created with owned=false is never freed by PHP, which leaks once per frame.
        $src = $ffi->new("char[$len]");
        FFI::memcpy($src, $raw, $len);

        $cap = 1024 * 1024;
        $dst = $ffi->new("char[$cap]");

        $off = 0;
        $out = '';

        while ($off < $len) {
            $ptr = FFI::addr($src[$off]);
            $avail = $len - $off;

            $csize = $ffi->ZSTD_findFrameCompressedSize($ptr, $avail);
            if ($ffi->ZSTD_isError($csize)) {
                // Most likely the incomplete tail of a log still being written.
                if ($tolerant) {
                    return [$out, $off];
                }
                throw new RuntimeException(sprintf(
                    'zstd frame error at byte %d: %s',
                    $off,
                    $ffi->ZSTD_getErrorName($csize)
                ));
            }

            // A frame larger than the destination is NOT end-of-input: grow and
            // retry, otherwise that frame and every later one would be dropped and
            // the stalled offset cached permanently.
            while (true) {
                $got = $ffi->ZSTD_decompress($dst, $cap, $ptr, $csize);
                if (!$ffi->ZSTD_isError($got)) {
                    break;
                }
                if ($ffi->ZSTD_getErrorCode($got) === self::ERR_DST_TOO_SMALL) {
                    $cap *= 2;
                    $dst = $ffi->new("char[$cap]");
                    continue;
                }
                if ($tolerant) {
                    return [$out, $off];
                }
                throw new RuntimeException(sprintf(
                    'zstd decompress error at byte %d: %s',
                    $off,
                    $ffi->ZSTD_getErrorName($got)
                ));
            }

            $out .= FFI::string($dst, (int) $got);
            $off += (int) $csize;
        }

        return [$out, $off];
    }

    /**
     * Decode a compressed segment, preferring in-process FFI and falling back to
     * the CLI helper.
     *
     * @return array{0: string, 1: int} [decoded text, consumed input bytes]
     */
    public static function decodeSegment(string $raw, bool $tolerant = true): array
    {
        if (self::inProcessAvailable()) {
            return self::decompressCounted($raw, $tolerant);
        }
        return self::segmentViaCli($raw);
    }

    /**
     * The PHP *CLI* binary.
     *
     * Under FPM, PHP_BINARY points at the php-fpm executable, which would start a
     * second FPM instead of running our script — so resolve the CLI explicitly.
     */
    private static function cliBinary(): string
    {
        if (PHP_SAPI === 'cli') {
            return PHP_BINARY;
        }

        $candidates = [
            '/usr/bin/php' . PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
            '/usr/local/bin/php' . PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
            '/usr/bin/php',
        ];
        foreach ($candidates as $bin) {
            if (is_executable($bin)) {
                return $bin;
            }
        }

        $found = trim((string) shell_exec('command -v php 2>/dev/null'));
        if ($found !== '') {
            return $found;
        }
        throw new RuntimeException('No PHP CLI binary found for the zstd fallback.');
    }

    /**
     * Run the CLI helper, which shares this file's decoder but has FFI permitted.
     *
     * The bytes go over stdin, so the helper never touches the filesystem and
     * needs no path guard. It answers with a one-line header carrying the number
     * of input bytes consumed, then the decoded text.
     *
     * @return array{0: string, 1: int}
     */
    private static function segmentViaCli(string $raw): array
    {
        $helper = dirname(__DIR__) . '/bin/zstddump.php';
        if (!is_file($helper)) {
            throw new RuntimeException('CLI fallback helper missing: ' . $helper);
        }

        $cmd = escapeshellcmd(self::cliBinary()) . ' ' . escapeshellarg($helper);
        $proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($proc)) {
            throw new RuntimeException('Cannot start the CLI zstd helper.');
        }

        // fwrite may accept only part of a large buffer, so loop.
        $len = strlen($raw);
        $written = 0;
        while ($written < $len) {
            $n = fwrite($pipes[0], substr($raw, $written));
            if ($n === false || $n === 0) {
                break;
            }
            $written += $n;
        }
        fclose($pipes[0]);

        $out = stream_get_contents($pipes[1]);
        $err = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($proc);

        if ($code !== 0 || $out === false || $out === '') {
            throw new RuntimeException('CLI zstd helper failed (exit ' . $code . '): ' . trim((string) $err));
        }

        $nl = strpos($out, "\n");
        if ($nl === false) {
            throw new RuntimeException('CLI zstd helper returned malformed output.');
        }
        $meta = json_decode(substr($out, 0, $nl), true);
        if (!is_array($meta) || !array_key_exists('offset', $meta)) {
            throw new RuntimeException('CLI zstd helper returned no offset.');
        }

        return [substr($out, $nl + 1), (int) $meta['offset']];
    }

    /** Decode a log into an array of decoded JSON records. */
    public static function readJsonl(string $path): array
    {
        $text = self::decompressedCached($path);
        $records = [];
        foreach (explode("\n", $text) as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            $decoded = json_decode($line, true);
            if (is_array($decoded)) {
                $records[] = $decoded;
            }
        }
        return $records;
    }

    private static function cacheBase(string $path): string
    {
        $dir = dirname(__DIR__) . '/var/cache';
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        return $dir . '/' . sha1($path);
    }

    /**
     * Decoded text for a session log, cached and extended incrementally.
     *
     * Session logs are append-only and a live one grows continuously. Rather than
     * re-decoding megabytes on every poll, remember how many compressed bytes have
     * already been consumed and decode only the new tail. The offset always lands
     * on a frame boundary, so an incomplete trailing frame is simply retried.
     *
     * The text and its offset live in two files; any sign that they disagree (one
     * missing, an offset past EOF, an empty log) discards both and starts over
     * rather than risking duplicated or lost events.
     *
     * A request-scoped memo sits in front of that: a single monitor poll asks for
     * the same log twice (once for its header, once to scan it), and re-reading a
     * multi-megabyte decoded file each time is pure waste. The text is immutable
     * for a given byte size, so the size is all the invalidation needed.
     */
    public static function decompressedCached(string $path): string
    {
        $size = (int) @filesize($path);
        if (isset(self::$textMemo[$path]) && self::$textMemo[$path][0] === $size) {
            return self::$textMemo[$path][1];
        }
        $text = self::readThroughCache($path, $size);
        self::$textMemo[$path] = [$size, $text];
        return $text;
    }

    /** @see decompressedCached */
    private static function readThroughCache(string $path, int $size): string
    {
        $base = self::cacheBase($path);
        $textFile = $base . '.jsonl';
        $offFile = $base . '.offset';

        $hasText = is_file($textFile);
        $hasOff = is_file($offFile);

        // A truncated or brand-new log invalidates everything we cached.
        if ($size === 0) {
            if ($hasText) {
                @unlink($textFile);
            }
            if ($hasOff) {
                @unlink($offFile);
            }
            return '';
        }

        // Serialise read-modify-append so two concurrent requests cannot both
        // append the same tail.
        $lock = fopen($base . '.lock', 'c');
        if ($lock !== false) {
            flock($lock, LOCK_EX);
        }

        try {
            $text = $hasText ? (string) file_get_contents($textFile) : '';
            $offset = $hasOff ? (int) file_get_contents($offFile) : 0;

            if (($offset > 0 && $text === '') || $offset > $size) {
                // Inconsistent pair: we cannot tell where the text ends, so redo it.
                $text = '';
                $offset = 0;
                @file_put_contents($textFile, '');
                @file_put_contents($offFile, '0');
            } elseif ($offset === 0 && $text !== '') {
                // The offset was lost while text survived; replaying would duplicate.
                $text = '';
                @file_put_contents($textFile, '');
            }

            if ($offset < $size) {
                $fh = fopen($path, 'rb');
                if ($fh !== false) {
                    fseek($fh, $offset);
                    $chunk = (string) stream_get_contents($fh);
                    fclose($fh);

                    if ($chunk !== '') {
                        [$decoded, $consumed] = self::decodeSegment($chunk);
                        if ($decoded !== '') {
                            file_put_contents($textFile, $decoded, FILE_APPEND);
                            $text .= $decoded;
                        }
                        // Advance only past complete frames.
                        file_put_contents($offFile, (string) ($offset + $consumed));
                    }
                }
            }

            return $text;
        } finally {
            if ($lock !== false) {
                flock($lock, LOCK_UN);
                fclose($lock);
            }
        }
    }

    /**
     * Drop cached decodes whose session log no longer exists.
     *
     * Age-based eviction is deliberately avoided: it would discard a decode the
     * current request is about to reuse, forcing a full re-read. Removing only
     * orphans keeps the cache exactly in step with the logs on disk.
     *
     * @param list<string> $logPaths every session log currently present
     */
    public static function pruneOrphans(array $logPaths): void
    {
        $dir = dirname(__DIR__) . '/var/cache';
        $keep = [];
        foreach ($logPaths as $path) {
            $keep[sha1($path)] = true;
        }

        foreach (glob($dir . '/*') ?: [] as $file) {
            $name = basename($file);
            $dot = strrpos($name, '.');
            if ($dot === false) {
                continue;
            }
            if (!isset($keep[substr($name, 0, $dot)])) {
                // Remove the text/offset/lock trio together; nothing owns it now.
                @unlink($file);
            }
        }
    }
}
