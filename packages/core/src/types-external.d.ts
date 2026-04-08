declare module 'better-sqlite3' {
  interface Statement {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }

  interface Database {
    pragma(source: string): unknown
    exec(source: string): void
    prepare(source: string): Statement
    close(): void
  }

  interface BetterSqlite3Constructor {
    new (filename: string, options?: unknown): Database
  }

  const BetterSqlite3: BetterSqlite3Constructor
  export = BetterSqlite3
}

declare module 'adm-zip'
declare module 'js-yaml'
