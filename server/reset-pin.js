/** Usage: STAFF_PIN=654321 node server/reset-pin.js (PowerShell: $env:STAFF_PIN="654321"; node server/reset-pin.js) */
import { randomBytes, scryptSync } from 'node:crypto';
import { db, transaction, logEvent } from './db.js';
const newPin=process.env.STAFF_PIN||'';
if (!/^\d{6,12}$/.test(newPin)) {
  console.error('Set STAFF_PIN to a private 6–12 digit PIN before running this command.');
  process.exit(1);
}
const employee=db.prepare("SELECT * FROM employees WHERE username='manager'").get();
if(!employee)throw new Error('Manager account not found');
const salt=randomBytes(16).toString('hex');
const hash=scryptSync(newPin,salt,32).toString('hex');
transaction(()=>{
  db.prepare('UPDATE employees SET pin_salt=?,pin_hash=? WHERE id=?').run(salt,hash,employee.id);
  logEvent('system',null,'staff.pin_changed','employee',employee.id);
});
console.log('Manager PIN changed. Restart the API server.');
