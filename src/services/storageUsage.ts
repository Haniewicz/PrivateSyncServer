import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { config } from "../config.js";

export type StorageCleanupTarget = "stale_staging" | "npm_cache";

export type SizeInfo = {
  bytes: number;
  diskBytes: number;
};

export type ServerStorageUsage = {
  generatedAt: string;
  totals: SizeInfo & {
    dataDir: string;
    blobs: SizeInfo;
    staging: SizeInfo & { directories: number; files: number; staleDirectories: number };
    database: SizeInfo;
    npmCache: SizeInfo & { exists: boolean };
  };
  vaults: Array<{
    id: string;
    name: string;
    currentRevision: number;
    revisions: number;
    filesEver: number;
    liveFiles: number;
    deletedFiles: number;
    historyBytes: number;
    liveBytes: number;
    uniqueBlobBytes: number;
  }>;
  cleanup: {
    safeTargets: Array<{
      target: StorageCleanupTarget;
      label: string;
      description: string;
      bytes: number;
      count: number;
      available: boolean;
    }>;
  };
};

export type StorageCleanupResult = {
  ok: true;
  cleaned: Array<{ target: StorageCleanupTarget; removedBytes: number; removedCount: number }>;
  usage: ServerStorageUsage;
};

const STAGING_CLEANUP_MIN_AGE_MS = 60 * 60 * 1000;

export function getStorageUsage(db: Database.Database): ServerStorageUsage {
  const dataSize = directorySize(config.dataDir);
  const blobSize = directorySize(config.blobDir);
  const stagingInfo = stagingSize(db);
  const databaseSize = databaseFilesSize();
  const npmCachePath = path.join(config.dataDir, ".npm");
  const npmCacheSize = directorySize(npmCachePath);
  const staleStaging = findStaleStagingBatchDirs(db);

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      dataDir: config.dataDir,
      ...dataSize,
      blobs: blobSize,
      staging: { ...stagingInfo, staleDirectories: staleStaging.length },
      database: databaseSize,
      npmCache: { ...npmCacheSize, exists: fs.existsSync(npmCachePath) }
    },
    vaults: getVaultBreakdown(db),
    cleanup: {
      safeTargets: [
        {
          target: "stale_staging",
          label: "Stale staging",
          description: "Old upload staging directories for committed, failed, aborted, or missing batches.",
          bytes: staleStaging.reduce((sum, item) => sum + item.size.bytes, 0),
          count: staleStaging.length,
          available: staleStaging.length > 0
        },
        {
          target: "npm_cache",
          label: "npm cache",
          description: "Package-manager cache under the Private Sync data directory.",
          bytes: npmCacheSize.bytes,
          count: fs.existsSync(npmCachePath) ? 1 : 0,
          available: fs.existsSync(npmCachePath) && npmCacheSize.bytes > 0
        }
      ]
    }
  };
}

export function cleanupStorage(db: Database.Database, targets: StorageCleanupTarget[]): StorageCleanupResult {
  const cleaned: StorageCleanupResult["cleaned"] = [];
  const uniqueTargets = new Set(targets);

  if (uniqueTargets.has("stale_staging")) {
    const staleDirs = findStaleStagingBatchDirs(db);
    let removedBytes = 0;
    let removedCount = 0;
    for (const item of staleDirs) {
      if (!isInside(path.join(config.dataDir, "staging"), item.path)) continue;
      removedBytes += item.size.bytes;
      fs.rmSync(item.path, { recursive: true, force: true });
      removedCount += 1;
    }
    cleaned.push({ target: "stale_staging", removedBytes, removedCount });
  }

  if (uniqueTargets.has("npm_cache")) {
    const npmCachePath = path.join(config.dataDir, ".npm");
    const size = directorySize(npmCachePath);
    if (isInside(config.dataDir, npmCachePath)) {
      fs.rmSync(npmCachePath, { recursive: true, force: true });
    }
    cleaned.push({ target: "npm_cache", removedBytes: size.bytes, removedCount: size.bytes > 0 ? 1 : 0 });
  }

  return { ok: true, cleaned, usage: getStorageUsage(db) };
}

export function cleanupBatchStaging(batchId: string): void {
  const batchPath = path.join(config.dataDir, "staging", batchId);
  if (!isInside(path.join(config.dataDir, "staging"), batchPath)) return;
  fs.rmSync(batchPath, { recursive: true, force: true });
}

function getVaultBreakdown(db: Database.Database): ServerStorageUsage["vaults"] {
  const vaults = db
    .prepare(
      `SELECT id, name, current_revision AS currentRevision
         FROM vaults
        ORDER BY name COLLATE NOCASE, id`
    )
    .all() as Array<{ id: string; name: string; currentRevision: number }>;

  return vaults.map((vault) => {
    const files = db
      .prepare(
        `SELECT COUNT(*) AS filesEver,
                SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS liveFiles,
                SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END) AS deletedFiles
           FROM files
          WHERE vault_id = ?`
      )
      .get(vault.id) as { filesEver: number | null; liveFiles: number | null; deletedFiles: number | null };
    const revisions = db
      .prepare(
        `SELECT COUNT(*) AS revisions,
                COALESCE(SUM(size), 0) AS historyBytes
           FROM file_revisions
          WHERE vault_id = ?`
      )
      .get(vault.id) as { revisions: number | null; historyBytes: number | null };
    const live = db
      .prepare(
        `SELECT COALESCE(SUM(fr.size), 0) AS liveBytes
           FROM files f
           JOIN file_revisions fr ON fr.id = f.current_file_revision_id
          WHERE f.vault_id = ? AND f.deleted = 0`
      )
      .get(vault.id) as { liveBytes: number | null };
    const blobPaths = db
      .prepare("SELECT DISTINCT blob_path AS blobPath FROM file_revisions WHERE vault_id = ? AND blob_path IS NOT NULL")
      .all(vault.id) as Array<{ blobPath: string }>;

    return {
      id: vault.id,
      name: vault.name,
      currentRevision: vault.currentRevision,
      revisions: revisions.revisions ?? 0,
      filesEver: files.filesEver ?? 0,
      liveFiles: files.liveFiles ?? 0,
      deletedFiles: files.deletedFiles ?? 0,
      historyBytes: revisions.historyBytes ?? 0,
      liveBytes: live.liveBytes ?? 0,
      uniqueBlobBytes: blobPaths.reduce((sum, item) => sum + fileSize(path.join(config.blobDir, item.blobPath)), 0)
    };
  });
}

function stagingSize(db: Database.Database): SizeInfo & { directories: number; files: number } {
  const stagingPath = path.join(config.dataDir, "staging");
  const size = directorySize(stagingPath);
  return { ...size, ...countDirectoryEntries(stagingPath) };
}

function databaseFilesSize(): SizeInfo {
  const candidates = [config.databasePath, `${config.databasePath}-wal`, `${config.databasePath}-shm`];
  return candidates.reduce(
    (sum, candidate) => {
      const size = fileSizeInfo(candidate);
      return { bytes: sum.bytes + size.bytes, diskBytes: sum.diskBytes + size.diskBytes };
    },
    { bytes: 0, diskBytes: 0 }
  );
}

function findStaleStagingBatchDirs(db: Database.Database): Array<{ path: string; size: SizeInfo }> {
  const stagingPath = path.join(config.dataDir, "staging");
  if (!fs.existsSync(stagingPath)) return [];
  const cutoff = Date.now() - STAGING_CLEANUP_MIN_AGE_MS;
  const rows = db.prepare("SELECT id, status FROM sync_batches").all() as Array<{ id: string; status: string }>;
  const batchStatus = new Map(rows.map((row) => [row.id, row.status]));
  const terminalStatuses = new Set(["committed", "failed", "aborted"]);
  const stale: Array<{ path: string; size: SizeInfo }> = [];

  for (const entry of fs.readdirSync(stagingPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(stagingPath, entry.name);
    const stats = safeStat(dirPath);
    if (!stats || stats.mtimeMs > cutoff) continue;
    const status = batchStatus.get(entry.name);
    if (status && !terminalStatuses.has(status)) continue;
    stale.push({ path: dirPath, size: directorySize(dirPath) });
  }
  return stale;
}

function directorySize(root: string): SizeInfo {
  const stats = safeStat(root);
  if (!stats) return { bytes: 0, diskBytes: 0 };
  if (stats.isFile()) return statSize(stats);
  if (!stats.isDirectory()) return { bytes: 0, diskBytes: 0 };

  let total = statSize(stats);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = directorySize(path.join(root, entry.name));
    total = { bytes: total.bytes + child.bytes, diskBytes: total.diskBytes + child.diskBytes };
  }
  return total;
}

function countDirectoryEntries(root: string): { directories: number; files: number } {
  const stats = safeStat(root);
  if (!stats || !stats.isDirectory()) return { directories: 0, files: 0 };
  let directories = 1;
  let files = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const childPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const child = countDirectoryEntries(childPath);
      directories += child.directories;
      files += child.files;
    } else if (entry.isFile()) {
      files += 1;
    }
  }
  return { directories, files };
}

function fileSize(filePath: string): number {
  return fileSizeInfo(filePath).bytes;
}

function fileSizeInfo(filePath: string): SizeInfo {
  const stats = safeStat(filePath);
  return stats ? statSize(stats) : { bytes: 0, diskBytes: 0 };
}

function statSize(stats: fs.Stats): SizeInfo {
  return { bytes: stats.size, diskBytes: typeof stats.blocks === "number" ? stats.blocks * 512 : stats.size };
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
