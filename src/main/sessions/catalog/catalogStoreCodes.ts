/**
 * 写事务的三个稳定码（INV-5c，设计 §3.2）：busy / 令牌过期 / 锁不可写各自可行动，不合并。
 * 与 `PROJECT_STORE_*` 同形（两处的实现共用 `storeFileCas`）。
 */
export const SESSION_CATALOG_BUSY = "SESSION_CATALOG_BUSY";
export const SESSION_CATALOG_REVISION_CONFLICT = "SESSION_CATALOG_REVISION_CONFLICT";
export const SESSION_CATALOG_LOCK_UNWRITABLE = "SESSION_CATALOG_LOCK_UNWRITABLE";
