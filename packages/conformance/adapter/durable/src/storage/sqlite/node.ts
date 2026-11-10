import { NodeSqliteDatabase, openNodeSqliteDatabase } from "../../../../chord/src/sqlite/node.ts";
import { SqliteStorage } from "./storage.ts";

export { NodeSqliteDatabase, openNodeSqliteDatabase };

export async function openNodeSqliteStorage(
	path: string,
	options: { readonly prefix?: string; readonly walAutoCheckpointPages?: number } = {},
): Promise<SqliteStorage> {
	const { prefix, ...databaseOptions } = options;
	if (prefix !== undefined) throw new Error("conformance adapter: the table prefix is removed (D5)");
	return SqliteStorage.open(await openNodeSqliteDatabase(path, databaseOptions));
}
