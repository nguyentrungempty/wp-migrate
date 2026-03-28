<?php
/**
 * Plugin Name: WP Migrator Helper
 * Description: Migration helper plugin. Keep active for future migrations.
 * Version: 2.1
 */
if (!defined('ABSPATH')) exit;

// ── Auth ──────────────────────────────────────────────────────────────────────

function wpm_check_auth() {
    if (!current_user_can('manage_options')) {
        wp_send_json_error('Unauthorized', 403);
    }
}

// ── Ping ──────────────────────────────────────────────────────────────────────

add_action('wp_ajax_wpm_ping',        function() { wp_send_json_success('pong'); });
add_action('wp_ajax_nopriv_wpm_ping', function() { wp_send_json_success('pong'); });

// ── Nonce ─────────────────────────────────────────────────────────────────────

add_action('wp_ajax_wpm_get_nonce', function() {
    wpm_check_auth();
    wp_send_json_success(wp_create_nonce('wpm_nonce'));
});

// ── Create Backup ─────────────────────────────────────────────────────────────

add_action('wp_ajax_wpm_create_backup', function() {
    wpm_check_auth();
    @set_time_limit(0);
    @ini_set('memory_limit', '512M');

    if (!class_exists('ZipArchive')) wp_send_json_error('ZipArchive not available');

    $upload_dir = wp_upload_dir();
    if (!empty($upload_dir['error'])) wp_send_json_error('Upload dir error: ' . $upload_dir['error']);

    $backup_dir = $upload_dir['basedir'] . '/wpm-backups';
    wp_mkdir_p($backup_dir);
    file_put_contents($backup_dir . '/.htaccess', 'deny from all');

    $job_id   = sanitize_text_field($_POST['job_id'] ?? uniqid());
    $zip_name = 'wpm-backup-' . $job_id . '.zip';
    $zip_path = $backup_dir . '/' . $zip_name;

    if (file_exists($zip_path)) unlink($zip_path);

    $zip = new ZipArchive();
    if ($zip->open($zip_path, ZipArchive::CREATE) !== true) {
        wp_send_json_error('Cannot create zip at: ' . $zip_path);
    }

    // Database
    $db_sql = wpm_export_db();
    $zip->addFromString('database.sql', $db_sql);

    // Site info
    $zip->addFromString('wpm-info.json', json_encode([
        'siteurl'      => get_option('siteurl'),
        'home'         => get_option('home'),
        'active_plugins' => get_option('active_plugins', []),
        'template'     => get_option('template'),
        'stylesheet'   => get_option('stylesheet'),
        'blogname'     => get_option('blogname'),
        'db_prefix'    => $GLOBALS['wpdb']->prefix,
        'created_at'   => date('Y-m-d H:i:s'),
    ], JSON_PRETTY_PRINT));

    // wp-content files
    $content_base = WP_CONTENT_DIR;
    $skip_dirs    = ['wpm-backups', 'wpm-restore-', 'cache' . DIRECTORY_SEPARATOR . 'wpcache'];

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($content_base, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST
    );

    foreach ($iterator as $file) {
        $path = $file->getPathname();
        $skip = false;
        foreach ($skip_dirs as $sd) {
            if (strpos($path, $sd) !== false) { $skip = true; break; }
        }
        if ($skip) continue;

        $rel = 'wp-content' . str_replace('\\', '/', substr($path, strlen($content_base)));

        if ($file->isDir()) {
            $zip->addEmptyDir($rel);
        } else {
            $zip->addFile($path, $rel);
        }
    }

    $zip->close();

    if (!file_exists($zip_path) || filesize($zip_path) < 1000) {
        wp_send_json_error('Zip creation failed, size: ' . (file_exists($zip_path) ? filesize($zip_path) : 0));
    }

    wp_send_json_success([
        'file'    => $zip_name,
        'url'     => $upload_dir['baseurl'] . '/wpm-backups/' . $zip_name,
        'size'    => filesize($zip_path),
        'db_size' => strlen($db_sql),
        'db_tables' => substr_count($db_sql, 'DROP TABLE IF EXISTS'),
    ]);
});

// ── Export Database ───────────────────────────────────────────────────────────

function wpm_export_db() {
    global $wpdb;

    $sql  = "-- WP Migrator Export " . date('Y-m-d H:i:s') . "\n";
    $sql .= "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n";
    $sql .= "SET NAMES utf8mb4;\n";
    $sql .= "SET FOREIGN_KEY_CHECKS=0;\n\n";

    $tables = $wpdb->get_col('SHOW TABLES');

    foreach ($tables as $table) {
        $create = $wpdb->get_row("SHOW CREATE TABLE `{$table}`", ARRAY_N);
        $sql   .= "DROP TABLE IF EXISTS `{$table}`;\n";
        $sql   .= $create[1] . ";\n\n";

        $offset = 0;
        while (true) {
            $rows = $wpdb->get_results(
                $wpdb->prepare("SELECT * FROM `{$table}` LIMIT 200 OFFSET %d", $offset),
                ARRAY_A
            );
            if (empty($rows)) break;

            foreach ($rows as $row) {
                $cols   = '`' . implode('`, `', array_keys($row)) . '`';
                $values = array_map(function($v) {
                    if ($v === null) return 'NULL';
                    return "'" . addslashes($v) . "'";
                }, array_values($row));
                $sql .= "INSERT INTO `{$table}` ({$cols}) VALUES (" . implode(', ', $values) . ");\n";
            }

            $offset += 200;
            if (count($rows) < 200) break;
        }
        $sql .= "\n";
    }

    $sql .= "SET FOREIGN_KEY_CHECKS=1;\n";
    return $sql;
}

// ── Download Backup ───────────────────────────────────────────────────────────

add_action('wp_ajax_wpm_download_backup', function() {
    wpm_check_auth();
    $file = sanitize_file_name($_GET['file'] ?? '');
    if (!$file) wp_die('No file specified');
    $ud   = wp_upload_dir();
    $path = $ud['basedir'] . '/wpm-backups/' . $file;
    if (!file_exists($path)) wp_die('File not found: ' . $file);
    while (ob_get_level()) ob_end_clean();
    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="' . basename($file) . '"');
    header('Content-Length: ' . filesize($path));
    header('Cache-Control: no-store');
    readfile($path);
    exit;
});

// ── Restore Backup ────────────────────────────────────────────────────────────

add_action('wp_ajax_wpm_restore_backup', function() {
    wpm_check_auth();
    @set_time_limit(0);
    @ini_set('memory_limit', '512M');

    $log = [];

    // Check upload
    if (empty($_FILES['backup']) || $_FILES['backup']['error'] !== UPLOAD_ERR_OK) {
        $err = $_FILES['backup']['error'] ?? 'no file uploaded';
        wp_send_json_error('Upload error code: ' . $err);
    }

    $file_size = $_FILES['backup']['size'];
    $log[] = 'Uploaded file size: ' . round($file_size / 1024 / 1024, 1) . 'MB';

    $old_domain = rtrim(trim($_POST['old_domain'] ?? ''), '/');
    $new_domain = rtrim(trim($_POST['new_domain'] ?? ''), '/');
    $log[] = 'Domain: ' . $old_domain . ' → ' . $new_domain;

    $ud  = wp_upload_dir();
    $dir = $ud['basedir'] . '/wpm-restore-' . time();
    if (!wp_mkdir_p($dir)) {
        wp_send_json_error('Cannot create temp dir: ' . $dir);
    }

    // Move zip
    $zp = $dir . '/backup.zip';
    if (!move_uploaded_file($_FILES['backup']['tmp_name'], $zp)) {
        wp_send_json_error('Cannot save uploaded file to: ' . $zp);
    }
    $log[] = 'Saved zip: ' . round(filesize($zp)/1024/1024, 1) . 'MB';

    // Extract
    if (!class_exists('ZipArchive')) wp_send_json_error('ZipArchive not available');
    $zip = new ZipArchive();
    $open_result = $zip->open($zp);
    if ($open_result !== true) {
        wp_send_json_error('Cannot open zip, ZipArchive error code: ' . $open_result . ', file size: ' . filesize($zp));
    }

    $num_files = $zip->numFiles;
    $log[] = 'Zip contains ' . $num_files . ' files';

    // Check database.sql exists in zip
    $db_in_zip = $zip->locateName('database.sql');
    $log[] = 'database.sql in zip: ' . ($db_in_zip !== false ? 'YES (index ' . $db_in_zip . ')' : 'NO — MISSING!');

    // Check wpm-info
    $info_raw = $zip->getFromName('wpm-info.json');
    $info     = $info_raw ? json_decode($info_raw, true) : [];
    if ($info) $log[] = 'Backup from: ' . ($info['siteurl'] ?? 'unknown') . ' at ' . ($info['created_at'] ?? '?');

    $zip->extractTo($dir);
    $zip->close();
    $log[] = 'Extracted to: ' . $dir;

    // Restore files
    $wc_src = $dir . '/wp-content';
    if (is_dir($wc_src)) {
        wpm_copy_dir($wc_src, WP_CONTENT_DIR);
        $log[] = 'Files: wp-content copied OK';
    } else {
        $log[] = 'WARNING: wp-content not found in backup dir';
    }

    // Import database
    $db_file = $dir . '/database.sql';
    if (file_exists($db_file)) {
        $db_size = filesize($db_file);
        $log[] = 'DB file size: ' . round($db_size/1024, 1) . 'KB';
        if ($db_size > 100) {
            $result = wpm_import_db($db_file, $old_domain, $new_domain);
            $log[] = 'DB import: ' . $result;
        } else {
            $log[] = 'ERROR: DB file too small (' . $db_size . ' bytes), skipping import';
        }
    } else {
        $log[] = 'ERROR: database.sql not found at ' . $db_file;
        // List what IS in the dir
        $found = scandir($dir);
        $log[] = 'Files in restore dir: ' . implode(', ', $found);
    }

    // Activate plugins & theme from backup info
    if (!empty($info['active_plugins'])) {
        update_option('active_plugins', $info['active_plugins']);
        $log[] = 'Activated ' . count($info['active_plugins']) . ' plugins from backup';
    }
    if (!empty($info['template'])) {
        update_option('template',   $info['template']);
        update_option('stylesheet', $info['stylesheet'] ?? $info['template']);
        $log[] = 'Theme set to: ' . $info['template'];
    }

    // Cleanup
    wpm_rrmdir($dir);

    wp_send_json_success(['message' => 'Restore completed', 'log' => $log]);
});

// ── Import Database ───────────────────────────────────────────────────────────

function wpm_import_db($file, $old_domain, $new_domain) {
    global $wpdb;

    $sql = file_get_contents($file);
    if ($sql === false || strlen($sql) < 10) return 'ERROR: Cannot read SQL file';

    // ── Detect and replace table prefix ──────────────────────────────────────
    $src_prefix = '';
    if (preg_match('/DROP TABLE IF EXISTS `([a-zA-Z0-9_]+?)options`/i', $sql, $pm)) {
        $src_prefix = $pm[1];
    }
    $dst_prefix = $wpdb->prefix;

    if ($src_prefix && $src_prefix !== $dst_prefix) {
        // Replace table names: `wpur_tablename` → `wplp_tablename`
        $sql = preg_replace(
            '/`' . preg_quote($src_prefix, '/') . '([a-zA-Z0-9_]+)`/',
            '`' . $dst_prefix . '$1`',
            $sql
        );
        // Also replace prefix references inside option values
        $sql = str_replace("'" . $src_prefix, "'" . $dst_prefix, $sql);
    }

    // ── Domain replacement ────────────────────────────────────────────────────
    if ($old_domain && $new_domain && $old_domain !== $new_domain) {
        $sql = wpm_replace_domain($sql, $old_domain, $new_domain);
    }

    $wpdb->query('SET FOREIGN_KEY_CHECKS=0');
    $wpdb->query('SET NAMES utf8mb4');
    $wpdb->query('SET SQL_MODE=""');

    $statements = wpm_split_sql($sql);
    $ok = 0; $err = 0; $err_msgs = [];

    foreach ($statements as $stmt) {
        $stmt = trim($stmt);
        if (empty($stmt)) continue;
        if (preg_match('/^(--|\/\*)/', $stmt)) continue;

        $result = $wpdb->query($stmt);
        if ($result === false) {
            $err++;
            if ($err <= 5) $err_msgs[] = substr($wpdb->last_error, 0, 120);
        } else {
            $ok++;
        }
    }

    $wpdb->query('SET FOREIGN_KEY_CHECKS=1');

    $msg = "prefix:{$src_prefix}→{$dst_prefix} | {$ok} OK, {$err} errors";
    if ($err_msgs) $msg .= ' | Errors: ' . implode(' || ', $err_msgs);
    return $msg;
}

function wpm_split_sql($sql) {
    $statements  = [];
    $current     = '';
    $in_string   = false;
    $string_char = '';
    $len         = strlen($sql);

    for ($i = 0; $i < $len; $i++) {
        $c = $sql[$i];

        if ($in_string) {
            $current .= $c;
            if ($c === '\\' && $i + 1 < $len) {
                $current .= $sql[++$i];
            } elseif ($c === $string_char) {
                $in_string = false;
            }
        } elseif ($c === "'" || $c === '"') {
            $in_string   = true;
            $string_char = $c;
            $current    .= $c;
        } elseif ($c === '-' && $i + 1 < $len && $sql[$i+1] === '-') {
            while ($i < $len && $sql[$i] !== "\n") $i++;
        } elseif ($c === '/' && $i + 1 < $len && $sql[$i+1] === '*') {
            $i += 2;
            while ($i + 1 < $len && !($sql[$i] === '*' && $sql[$i+1] === '/')) $i++;
            $i++;
        } elseif ($c === ';') {
            $s = trim($current);
            if ($s !== '') $statements[] = $s;
            $current = '';
        } else {
            $current .= $c;
        }
    }

    if (trim($current) !== '') $statements[] = trim($current);
    return $statements;
}

function wpm_replace_domain($sql, $old, $new) {
    // Replace in regular strings
    $sql = str_replace($old, $new, $sql);

    // Fix serialized string lengths that may have changed
    $old_len = strlen($old);
    $new_len = strlen($new);
    if ($old_len !== $new_len) {
        $diff = $new_len - $old_len;
        // Find s:N:"...new..." patterns and fix N
        $sql = preg_replace_callback(
            '/s:(\d+):"([^"]*' . preg_quote($new, '/') . '[^"]*)"/',
            function($m) {
                return 's:' . strlen($m[2]) . ':"' . $m[2] . '"';
            },
            $sql
        );
    }
    return $sql;
}

// ── File Helpers ──────────────────────────────────────────────────────────────

function wpm_copy_dir($src, $dst) {
    if (!is_dir($dst)) @mkdir($dst, 0755, true);
    $items = @scandir($src);
    if (!$items) return;
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') continue;
        $s = $src . '/' . $item;
        $d = $dst . '/' . $item;
        if (is_dir($s)) wpm_copy_dir($s, $d);
        else @copy($s, $d);
    }
}

function wpm_rrmdir($dir) {
    if (!is_dir($dir)) return;
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($it as $f) {
        $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
    }
    @rmdir($dir);
}

// ── Cleanup backup files ──────────────────────────────────────────────────────

add_action('wp_ajax_wpm_cleanup_files', function() {
    wpm_check_auth();
    $ud = wp_upload_dir();
    $bd = $ud['basedir'] . '/wpm-backups';
    $n  = 0;
    if (is_dir($bd)) {
        foreach (glob($bd . '/wpm-backup-*.zip') ?: [] as $f) {
            unlink($f); $n++;
        }
    }
    wp_send_json_success('Deleted ' . $n . ' backup files');
});

