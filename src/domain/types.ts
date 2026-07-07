export type DeviceType = "desktop" | "mobile" | "tablet" | "unknown";

export type OperationType = "create" | "update" | "delete" | "rename" | "move";

export type BatchStatus =
  | "created"
  | "uploading"
  | "validating"
  | "committed"
  | "aborted"
  | "failed"
  | "waiting_for_decision";

export type RequestType =
  | "device_pairing"
  | "conflict_resolution"
  | "mass_delete_approval"
  | "suspicious_operation"
  | "restore_version"
  | "device_removal";

export type RequestStatus = "pending" | "approved" | "rejected" | "resolved" | "expired";

export type ConflictStatus = "pending" | "resolved" | "cancelled";

export type SyncOperation = {
  clientChangeId: string;
  type: OperationType;
  path: string;
  targetPath?: string;
  baseRevisionId: number | null;
  contentHash?: string;
  size?: number;
  encrypted?: boolean;
  encryptedFileKey?: string | null;
};
