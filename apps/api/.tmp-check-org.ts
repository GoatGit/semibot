import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false })

async function main() {
  const users = await sql.unsafe(`
    select id, email, org_id
    from users
    order by created_at desc
    limit 20
  `)

  const orgIds = Array.from(new Set(users.map((u: any) => u.org_id).filter(Boolean)))
  let orgs: any[] = []
  if (orgIds.length > 0) {
    const inList = orgIds.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(',')
    orgs = await sql.unsafe(`select id, name, slug from organizations where id in (${inList})`)
  }

  const orgSet = new Set(orgs.map((o: any) => o.id))
  const orphans = users.filter((u: any) => u.org_id && !orgSet.has(u.org_id))

  console.log(JSON.stringify({
    users,
    orgs,
    orphanUsers: orphans,
  }, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(async () => { await sql.end() })
