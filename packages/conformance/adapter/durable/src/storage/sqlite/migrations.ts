import { applySqliteMigrations as apply, CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_MIGRATIONS } from "../../../../../../kernel/src/index.ts";
import { run } from "../../../../kernel.ts";
import { kernelDatabase } from "./storage.ts";
import { unimplemented } from "../../../../../unimplemented.ts";

export { CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_MIGRATIONS };

export function applySqliteMigrations(database: never, migrations = SQLITE_MIGRATIONS): Promise<void> {
	return run(apply(kernelDatabase(database), migrations));
}

// Schemas for a table prefix, which D5 removes.
export const applySqliteMigrationsForSchema = unimplemented("applySqliteMigrationsForSchema", "nobody: D5 removes the table prefix");
export const createSqliteMigrations = unimplemented("createSqliteMigrations", "nobody: D5 removes the table prefix");
