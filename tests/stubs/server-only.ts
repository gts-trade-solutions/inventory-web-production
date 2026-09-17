// `server-only` throws when imported outside a React Server Component. Vitest
// runs plain Node, so it is aliased to this no-op. The guarantee it provides is
// a build-time one and still applies to the real app.
export {}
