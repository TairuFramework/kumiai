import type { TestProject } from 'vitest/node'

type PostgresServer = { url: string; stop: () => Promise<void> }

let server: PostgresServer | null = null

async function startPostgres(): Promise<PostgresServer | null> {
  const url = process.env.HOZON_POSTGRES_URL?.trim()
  if (url) return { url, stop: async () => {} }
  try {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql')
    const container = await new PostgreSqlContainer('postgres:18-alpine').start()
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop()
      },
    }
  } catch (cause) {
    if (process.env.CI === 'true') {
      throw new Error('Postgres is required when CI=true: set HOZON_POSTGRES_URL or run Docker', {
        cause,
      })
    }
    const reason = cause instanceof Error ? cause.message : String(cause)
    console.warn(
      `[integration] Postgres tests SKIPPED: HOZON_POSTGRES_URL is unset and no container could start (${reason})`,
    )
    return null
  }
}

export async function setup(project: TestProject): Promise<void> {
  server = await startPostgres()
  project.provide('postgresURL', server?.url ?? null)
}

export async function teardown(): Promise<void> {
  await server?.stop()
  server = null
}
