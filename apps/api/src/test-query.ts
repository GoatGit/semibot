/* eslint-disable no-console -- 调试脚本 */
import { sql } from './lib/db';

async function test() {
  const orgId = 'a9f78670-756f-4ba4-aff2-1c4e29de0748';
  
  // 简单查询
  const result1 = await sql`SELECT id, name, org_id FROM agents WHERE org_id = ${orgId}`;
  console.log('Direct query result:', result1.length, 'agents');
  if (result1.length > 0) {
    console.log('First agent:', result1[0]);
  }
  
  // 使用动态 WHERE 子句
  const whereClause = sql`org_id = ${orgId}`;
  const result2 = await sql`SELECT id, name FROM agents WHERE ${whereClause}`;
  console.log('Dynamic WHERE result:', result2.length, 'agents');
  
  await sql.end();
}

test().catch(e => { console.error(e); process.exit(1); });
