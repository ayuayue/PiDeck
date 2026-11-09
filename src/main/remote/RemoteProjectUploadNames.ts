/**
 * Names reserved by PiDeck's upload transaction.
 *
 * A killed process can leave a staged leaf behind before helper cleanup runs. Every user-visible
 * remote directory/search projection hides only this exact shape, never a user's similar suffix.
 */
export const REMOTE_UPLOAD_TEMP_NAME = /^\.[a-f0-9]{32}\.pideck-put$/;
