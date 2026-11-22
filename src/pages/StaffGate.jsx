import React, { useState } from 'react';
import { LockKeyhole, ShieldCheck, LogOut } from 'lucide-react';
import { api } from '../api.js';

export default function StaffGate({section, children}) {
  const [token, setToken] = useState(()=>sessionStorage.getItem('kiosk-staff-token')||'');
  const [username,setUsername]=useState('manager');
  const [pin,setPin]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  async function login(e){
    e.preventDefault();setBusy(true);setError('');
    try{
      const data=await api.login(username,pin);
      sessionStorage.setItem('kiosk-staff-token',data.accessToken);
      sessionStorage.setItem('kiosk-staff-user',data.employee.displayName);
      setToken(data.accessToken);setPin('');
    }catch(err){setError(err.message);}finally{setBusy(false);}
  }
  function clear(){sessionStorage.removeItem('kiosk-staff-token');sessionStorage.removeItem('kiosk-staff-user');setToken('');}
  async function logout(){try{await api.logout(token);}catch{}clear();}
  if(token)return <div>
    <div className="staff-session"><ShieldCheck size={16}/><span>{sessionStorage.getItem('kiosk-staff-user')||'Employee'} — {section}</span><button onClick={logout}><LogOut size={15}/> Sign out</button></div>
    {children(token,clear)}
  </div>;
  return <div className="staff-login-screen"><form className="staff-login-card" onSubmit={login}>
    <div className="staff-login-icon"><LockKeyhole size={35}/></div>
    <div className="eyebrow">EMPLOYEE ACCESS</div><h1>{section}</h1>
    <p>Sign in to access orders, payments and employee activity.</p>
    <label htmlFor="username">Username</label>
    <input id="username" value={username} autoComplete="username" maxLength={40} onChange={e=>setUsername(e.target.value)}/>
    <label htmlFor="staffPin">Staff PIN</label>
    <input id="staffPin" value={pin} onChange={e=>setPin(e.target.value)} type="password" inputMode="numeric" pattern="[0-9]{6,12}" autoComplete="current-password" minLength={6} maxLength={12} required/>
    {error&&<div className="error-box" role="alert">{error}</div>}
    <button className="primary-button full-button" disabled={busy}>{busy?'Signing in…':'Sign in'}</button>
    <small>Development demo: manager / 123456. Change before real use. The admin and kitchen pages must not be exposed publicly.</small>
  </form></div>;
}
