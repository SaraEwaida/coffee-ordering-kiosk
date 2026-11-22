/* Quick, read-only SQLite inspector in the VS Code terminal. */
import {db,dbFile} from './db.js';
console.log('\nSQLite database:',dbFile);
const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
console.log('\nTables:',tables.join(', '));
const views={
  products:'SELECT id,name,price_cents,available FROM products ORDER BY rowid',
  orders:'SELECT sequence,created_at,payment_status,status,total_cents,loyalty_redeemed_points,loyalty_earned_points FROM orders ORDER BY created_at DESC LIMIT 10',
  payments:'SELECT method,status,amount_cents,recorded_at FROM payments ORDER BY recorded_at DESC LIMIT 10',
  employees:'SELECT username,display_name,role,active FROM employees',
  loyalty_accounts:'SELECT substr(code,1,3)||"••••"||substr(code,-4) AS masked_code,points_balance,total_earned,created_at FROM loyalty_accounts LIMIT 10',
  loyalty_transactions:'SELECT order_id,kind,points_delta,created_at FROM loyalty_transactions ORDER BY id DESC LIMIT 15',
  events:'SELECT actor_type,event_type,created_at FROM events ORDER BY id DESC LIMIT 10',
};
for(const [title,sql] of Object.entries(views)){
  console.log(`\n${title.toUpperCase()}`);
  console.table(db.prepare(sql).all());
}
db.close();
