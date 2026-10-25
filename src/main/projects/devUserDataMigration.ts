import { join } from "node:path";
import type { UpdateChannel } from "../../shared/types/app";
import { DEFAULT_DEV_USER_DATA_NAME, LEGACY_DEV_USER_DATA_NAME } from "../devIsolation";
import { resolveChannelDevDataDir } from "../portableUserData";
import { runUserDataNameMigration, type UserDataNameMigration } from "./userDataNameMigration";

/** 在读取 Dev 决策指针之前迁移开发数据；显式目录和便携版保持原位置。 */
export function migrateDevUserData(input: { appDataDir: string; homeDir: string; devDirectoryName: string; isPackaged: boolean; channel: UpdateChannel; portableExeDir?: string; explicitDir?: string }) {
	let unpackagedDevDir = join(input.appDataDir, input.devDirectoryName);
	let channelDevDataDir = resolveChannelDevDataDir(input);
	const migrations: UserDataNameMigration[] = [];
	if (input.explicitDir) return { unpackagedDevDir, channelDevDataDir, migrations };
	if (!input.isPackaged) {
		const result = runUserDataNameMigration({
			appDataDir: input.appDataDir,
			homeDir: input.homeDir,
			legacyUserDataName: `${LEGACY_DEV_USER_DATA_NAME}${input.devDirectoryName.slice(DEFAULT_DEV_USER_DATA_NAME.length)}`,
			userDataPathOverride: unpackagedDevDir,
		});
		unpackagedDevDir = result.userDataPath;
		migrations.push(result);
	} else if (input.channel === "dev" && !input.portableExeDir) {
		const result = runUserDataNameMigration({
			appDataDir: input.appDataDir,
			homeDir: input.homeDir,
			legacyUserDataName: "pi-desktop-channel-dev",
			userDataPathOverride: channelDevDataDir,
		});
		channelDevDataDir = result.userDataPath;
		migrations.push(result);
	}
	return { unpackagedDevDir, channelDevDataDir, migrations };
}
