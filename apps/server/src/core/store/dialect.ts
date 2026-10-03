// Kysely on Node's own `node:sqlite`: Kysely builds the query, node:sqlite
// runs it on the connection Rufi opened (and set up) itself.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
} from "kysely";

export class NodeSqliteDialect implements Dialect {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  createAdapter = () => new SqliteAdapter();
  createDriver = (): Driver => new NodeSqliteDriver(this.#db);
  createQueryCompiler = () => new SqliteQueryCompiler();
  // oxlint-disable-next-line typescript/no-explicit-any -- Kysely's own signature
  createIntrospector = (db: Kysely<any>) => new SqliteIntrospector(db);
}

/**
 * One connection, used by one query or transaction at a time. The connection
 * belongs to the caller: closing Kysely doesn't close it.
 */
class NodeSqliteDriver implements Driver {
  readonly #connection: NodeSqliteConnection;
  #queue: Promise<void> = Promise.resolve();
  #release: (() => void) | undefined;

  constructor(db: DatabaseSync) {
    this.#connection = new NodeSqliteConnection(db);
  }

  init = () => Promise.resolve();

  acquireConnection = async (): Promise<DatabaseConnection> => {
    const previous = this.#queue;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#queue = previous.then(() => promise);
    await previous;
    this.#release = resolve;
    return this.#connection;
  };

  releaseConnection = () => {
    this.#release?.();
    this.#release = undefined;
    return Promise.resolve();
  };

  beginTransaction = (connection: DatabaseConnection) =>
    run(connection, "BEGIN");
  commitTransaction = (connection: DatabaseConnection) =>
    run(connection, "COMMIT");
  rollbackTransaction = (connection: DatabaseConnection) =>
    run(connection, "ROLLBACK");

  destroy = () => Promise.resolve();
}

async function run(connection: DatabaseConnection, sql: string) {
  await connection.executeQuery(CompiledQuery.raw(sql));
}

class NodeSqliteConnection implements DatabaseConnection {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.#db.prepare(query.sql);
    const parameters = query.parameters as readonly SQLInputValue[];
    // A statement that returns rows (a SELECT, or a write with RETURNING)
    // gives all its rows; any other gives what it changed.
    if (statement.columns().length > 0) {
      return Promise.resolve({ rows: statement.all(...parameters) as R[] });
    }
    const { changes, lastInsertRowid } = statement.run(...parameters);
    return Promise.resolve({
      rows: [],
      numAffectedRows: BigInt(changes),
      insertId: BigInt(lastInsertRowid),
    });
  }

  /** Rufi doesn't stream rows yet: this gives one read's rows one by one. */
  async *streamQuery<R>(
    query: CompiledQuery,
  ): AsyncIterableIterator<QueryResult<R>> {
    const { rows } = await this.executeQuery<R>(query);
    for (const row of rows) yield { rows: [row] };
  }
}
