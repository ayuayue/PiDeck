import { Agent } from "node:https";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
	type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { ProviderAccount, S3Config } from "../../../shared/types/cloudSync.ts";
import {
	assertSafeCloudObjectKey,
	CloudSyncConditionalWriteError,
	type CloudSyncObjectDeleteOptions,
	type CloudSyncObjectReadResult,
	type CloudSyncObjectStorageCapabilities,
	type CloudSyncObjectWriteOptions,
	type CloudSyncObjectWriteResult,
	type PiDeckCloudObjectStorage,
} from "../objectStorage.ts";
import { normalizeS3Config } from "../providerConfig.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStatusCode(error: unknown): number | undefined {
	if (!isRecord(error) || !isRecord(error.$metadata)) return undefined;
	const status = error.$metadata.httpStatusCode;
	return typeof status === "number" ? status : undefined;
}

function isNotFound(error: unknown): boolean {
	return getStatusCode(error) === 404;
}

function isConditionalFailure(error: unknown): boolean {
	return getStatusCode(error) === 409 || getStatusCode(error) === 412;
}

function normalizeRevision(value: string | undefined): string | undefined {
	return value?.replace(/^"|"$/g, "");
}

function toIfMatch(revision: string): string {
	return `"${revision.replace(/^"|"$/g, "")}"`;
}

function hasByteArrayTransform(value: unknown): value is { transformToByteArray: () => Promise<Uint8Array> } {
	return isRecord(value) && typeof value.transformToByteArray === "function";
}

async function toBytes(body: unknown): Promise<Buffer> {
	if (body == null) return Buffer.alloc(0);
	if (Buffer.isBuffer(body)) return Buffer.from(body);
	if (body instanceof Uint8Array) return Buffer.from(body);
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
	if (hasByteArrayTransform(body)) return Buffer.from(await body.transformToByteArray());
	throw new TypeError("S3 returned an unsupported object body");
}

function buildAccount(config: S3Config): ProviderAccount {
	return {
		id: `${config.bucket}@${config.endpoint}`,
		name: `${config.bucket} (${config.region})`,
	};
}

/** S3-compatible encrypted object storage for MinIO, R2 and standard S3. */
export class S3ObjectStorage implements PiDeckCloudObjectStorage {
	readonly providerId = "s3" as const;

	private readonly config: S3Config;
	private readonly account: ProviderAccount;
	private readonly client: S3Client;
	private connected = false;

	constructor(config: unknown, client?: S3Client) {
		this.config = normalizeS3Config(config);
		this.account = buildAccount(this.config);
		this.client = client ?? this.createClient(this.config);
	}

	async connect(): Promise<{ account: ProviderAccount }> {
		try {
			await this.client.send(new HeadObjectCommand({
				Bucket: this.config.bucket,
				Key: this.objectKey("pideck-index.json"),
			}));
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		this.connected = true;
		return { account: { ...this.account } };
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		this.client.destroy();
	}

	async getAccount(): Promise<ProviderAccount | null> {
		return this.connected ? { ...this.account } : null;
	}

	async getCapabilities(): Promise<CloudSyncObjectStorageCapabilities> {
		return {
			revisions: true,
			conditionalWrites: true,
			atomicReplacement: true,
		};
	}

	async readObject(key: string, options?: { signal?: AbortSignal }): Promise<CloudSyncObjectReadResult> {
		this.requireConnected();
		const objectKey = this.objectKey(key);
		try {
			const response = await this.client.send(new GetObjectCommand({
				Bucket: this.config.bucket,
				Key: objectKey,
				ResponseCacheControl: "no-cache",
			}), { abortSignal: options?.signal });
			return {
				found: true,
				key,
				bytes: await toBytes(response.Body),
				revision: normalizeRevision(response.ETag),
				contentType: response.ContentType,
			};
		} catch (error) {
			if (isNotFound(error)) return { found: false, key, bytes: null };
			throw error;
		}
	}

	async writeObject(
		key: string,
		bytes: Uint8Array,
		options?: CloudSyncObjectWriteOptions,
	): Promise<CloudSyncObjectWriteResult> {
		this.requireConnected();
		const objectKey = this.objectKey(key);
		const current = await this.headObject(key, options?.signal);
		if (options?.expectedRevision === null && current.found) {
			throw new CloudSyncConditionalWriteError("S3 object already exists");
		}
		if (
			typeof options?.expectedRevision === "string" &&
			(!current.found || current.revision !== options.expectedRevision)
		) {
			throw new CloudSyncConditionalWriteError("S3 object revision does not match");
		}

		const input: PutObjectCommandInput = {
			Bucket: this.config.bucket,
			Key: objectKey,
			Body: Buffer.from(bytes),
			ContentType: "application/octet-stream",
		};
		if (options?.expectedRevision === null) input.IfNoneMatch = "*";
		if (typeof options?.expectedRevision === "string") input.IfMatch = toIfMatch(options.expectedRevision);
		try {
			const response = await this.client.send(new PutObjectCommand(input), {
				abortSignal: options?.signal,
			});
			return {
				created: !current.found,
				revision: normalizeRevision(response.ETag),
			};
		} catch (error) {
			if (isConditionalFailure(error)) {
				throw new CloudSyncConditionalWriteError("S3 conditional write was rejected");
			}
			throw error;
		}
	}

	async deleteObject(key: string, options?: CloudSyncObjectDeleteOptions): Promise<{ deleted: boolean }> {
		this.requireConnected();
		const current = await this.headObject(key, options?.signal);
		if (!current.found) return { deleted: false };
		if (options?.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
			throw new CloudSyncConditionalWriteError("S3 object revision does not match");
		}
		try {
			await this.client.send(new DeleteObjectCommand({
				Bucket: this.config.bucket,
				Key: this.objectKey(key),
				IfMatch: options?.expectedRevision === undefined
					? undefined
					: toIfMatch(options.expectedRevision),
			}), { abortSignal: options?.signal });
			return { deleted: true };
		} catch (error) {
			if (isNotFound(error)) return { deleted: false };
			if (isConditionalFailure(error)) {
				throw new CloudSyncConditionalWriteError("S3 conditional delete was rejected");
			}
			throw error;
		}
	}

	private async headObject(
		key: string,
		signal?: AbortSignal,
	): Promise<{ found: boolean; revision?: string }> {
		const objectKey = this.objectKey(key);
		try {
			const response = await this.client.send(new HeadObjectCommand({
				Bucket: this.config.bucket,
				Key: objectKey,
			}), { abortSignal: signal });
			return { found: true, revision: normalizeRevision(response.ETag) };
		} catch (error) {
			if (isNotFound(error)) return { found: false };
			throw error;
		}
	}

	private requireConnected(): void {
		if (!this.connected) throw new Error("S3 storage is not connected");
	}

	private objectKey(key: string): string {
		assertSafeCloudObjectKey(key);
		return this.config.prefix ? `${this.config.prefix}/${key}` : key;
	}

	private createClient(config: S3Config): S3Client {
		const clientConfig: ConstructorParameters<typeof S3Client>[0] = {
			region: config.region,
			endpoint: config.endpoint,
			forcePathStyle: config.forcePathStyle ?? true,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
				sessionToken: config.sessionToken,
			},
		};
		if (config.allowInsecure) {
			clientConfig.requestHandler = new NodeHttpHandler({
				httpsAgent: new Agent({ rejectUnauthorized: false }),
			});
		}
		return new S3Client(clientConfig);
	}
}
