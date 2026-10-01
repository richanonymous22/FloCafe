/* ============================================================================
 * 05c-licence.js — activation, licence status and the "sales paused" screen
 * ----------------------------------------------------------------------------
 * Everything here is the till server's answer (GET /activation/status): whether this device is activated, its
 * licence, and whether trading is allowed. When trading is not allowed the till says why in plain words and, if
 * the device has never been activated, takes the owner's activation code. Records, reports and backups stay
 * available; the server refuses only the sales calls (402), so this screen can be dismissed to view them.
 * ==========================================================================*/
U.lic=U.lic||{status:null,err:null,busy:false,dismissed:false,timer:null};
const licEsc=esc;
const licWhen=s=>s?fmtD(Date.parse(String(s).replace(' ','T')+(/[zZ]|[+-]\d\d:?\d\d$/.test(String(s))?'':'Z'))):'never';

async function licenceCheck(){
  if(!window.PlemmoAPI||!PlemmoAPI.isAuthenticated())return;
  try{U.lic.status=await PlemmoAPI.get('/activation/status');U.lic.err=null;}
  catch(e){U.lic.err=e&&e.status===403?'You don’t have permission to see licence details.':null;return;}
  if(U.lic.status.trading_allowed)U.lic.dismissed=false;
  drawLicenceGate();
  if(U.view==='settings'&&U.set.tab==='licence')renderView();
}
// Checked a moment after the page loads and then every minute; a no-op until someone has signed in.
setTimeout(licenceCheck,800);
if(!U.lic.timer)U.lic.timer=setInterval(licenceCheck,60000);
window.addEventListener('plemmo-licence-blocked',()=>{U.lic.dismissed=false;licenceCheck();});

const LIC_TITLES={unactivated:'Activate this till',suspended:'Sales are paused',revoked:'This account is closed',expired:'The licence has expired',unlicensed:'The licence could not be checked',device_revoked:'This device was removed'};
function licenceGateHTML(st){
  const reason=st.activated?(st.license?st.license.status:'unlicensed'):'unactivated';
  const why=st.trading_blocked_reason||'This till is not licensed.';
  const key=st.trading_blocked_reason&&/removed from the account/.test(st.trading_blocked_reason)?'device_revoked':reason;
  const owner=!!(me()&&me().plemmoRole==='owner');
  const form=!st.activated?(owner?`<label class="pl-field"><span>Activation code</span><input class="input" id="licCode" autocomplete="off" spellcheck="false" placeholder="Paste the code you were given"></label>
     <p class="pl-err" id="licErr" aria-live="polite"></p><button class="pl-btn" data-act="licActivate">Activate</button>`
    :`<p class="muted">Ask the account owner to sign in on this till and enter the activation code.</p>`)
    :`<button class="pl-btn" data-act="licRefresh">Check again</button>`;
  return`<div class="pl-card"><h2>${licEsc(LIC_TITLES[key]||'Sales are paused')}</h2><p class="pl-sub">${licEsc(why)}</p>${form}
    <p style="text-align:center;margin:14px 0 0"><button class="btn btn-ghost" data-act="licDismiss">View records only</button></p>
    ${BRAND().supportEmail?`<p class="pl-foot">Support: ${licEsc(BRAND().supportEmail)}</p>`:''}</div>`;
}
function drawLicenceGate(){
  let el=document.getElementById('licence-gate');
  const st=U.lic.status;
  const show=!!st&&!st.trading_allowed&&!U.lic.dismissed&&PlemmoAPI.isAuthenticated();
  if(!show){if(el)el.hidden=true;return;}
  if(!el){el=document.createElement('div');el.id='licence-gate';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');document.body.appendChild(el);}
  el.hidden=false;el.innerHTML=licenceGateHTML(st);
  const i=el.querySelector('#licCode');if(i)i.focus();
}
A.licDismiss=()=>{U.lic.dismissed=true;drawLicenceGate();toast('Sales stay paused. You can still view records and reports.','info',{ms:4200});};
A.licRefresh=async()=>{
  if(U.lic.busy)return;U.lic.busy=true;
  try{const r=await PlemmoAPI.post('/activation/refresh',{},{idempotent:false});U.lic.status=r.status;toast(r.status.trading_allowed?'Licence checked: sales are open':'Licence checked','ok');}
  catch(e){toast(e&&e.data&&e.data.error?e.data.error:'Could not check the licence','warn',{ms:5200});await licenceCheck();}
  finally{U.lic.busy=false;drawLicenceGate();if(U.view==='settings')renderView();}
};
A.licActivate=async()=>{
  const code=((document.getElementById('licCode')||document.getElementById('licCode2')||{}).value||'').trim();
  const err=document.getElementById('licErr')||document.getElementById('licErr2');
  if(!code){if(err)err.textContent='Enter the activation code.';return;}
  if(U.lic.busy)return;U.lic.busy=true;if(err)err.textContent='Activating…';
  try{
    const r=await PlemmoAPI.post('/activation',{code:code},{idempotent:false});
    U.lic.status=r.status;U.lic.dismissed=false;
    try{await PlemmoCatalogue.load(S);}catch(e){/* refreshed on next load */}
    toast(`Activated: ${r.plan} plan`,'ok',{ms:4200});
  }catch(e){if(err)err.textContent=(e&&e.data&&e.data.error)||'Activation failed. Check the code and your connection.';U.lic.busy=false;return;}
  U.lic.busy=false;drawLicenceGate();if(U.view==='settings')renderView();
};

function licenceHTML(){
  const st=U.lic.status;
  if(U.lic.err)return`<div class="panel"><div class="panel-b"><p class="muted">${licEsc(U.lic.err)}</p></div></div>`;
  if(!st)return`<div class="panel"><div class="panel-b"><p class="muted">Reading licence status…</p></div></div>`;
  const L=st.license,owner=!!(me()&&me().plemmoRole==='owner');
  const row=(t,sub,ctl)=>`<div class="set-row"><div class="sr-t"><b>${t}</b>${sub?`<small>${sub}</small>`:''}</div>${ctl||''}</div>`;
  const badge=(ok,text)=>`<span class="badge ${ok?'ok':'warn'}">${licEsc(text)}</span>`;
  const label={active:'Active',grace:'Expired, in grace period',needs_verification:'Active: needs a check',suspended:'Suspended',revoked:'Closed',expired:'Expired',unlicensed:'Not verified'};
  return`<div class="panel"><div class="panel-b">
   ${row('Trading',st.trading_allowed?'Sales are open on this till':licEsc(st.trading_blocked_reason||''),badge(st.trading_allowed,st.trading_allowed?'Open':'Paused'))}
   ${L?row('Licence',`Plan: <b>${licEsc(L.plan)}</b>${L.features&&L.features.length?'. Includes '+licEsc(L.features.join(', ')):''}`,badge(L.status==='active',label[L.status]||L.status)):row('Licence',st.requires_activation?'This till has not been activated':'No licence on this till (not required for this build)','')}
   ${L?row('Valid until',L.expires_at?licWhen(L.expires_at)+(L.grace_days?` (then ${L.grace_days} days of grace)`:''):'No expiry',''):''}
   ${L?row('Limits',`${L.device_limit==null?'Any number of':L.device_limit} devices, ${L.location_limit==null?'any number of':L.location_limit} locations`,''):''}
   ${L?row('Last checked with the cloud',licWhen(L.last_verified_at),owner||true?`<button class="btn" data-act="licRefresh">Check now</button>`:''):''}
   ${st.activated?row('Cloud account',`Connected to ${licEsc(st.cloud_host||'')}, activated ${licWhen(st.activated_at)}. Sales sync to the cloud${st.sync&&st.sync.pending?` (${st.sync.pending} waiting to send)`:''}.`,''):''}
   ${row('This device',`<span class="num">${licEsc(st.device_id)}</span>`,'')}
  </div></div>
  ${!st.activated?`<div class="panel mt"><div class="panel-h"><h3>Activate this till</h3></div><div class="panel-b">${owner?`<p class="muted" style="margin-top:0">Enter the activation code your supplier gave you. It connects this till to your cloud account and fetches your licence.</p>
    <label class="field"><span>Activation code</span><input class="input" id="licCode2" autocomplete="off" spellcheck="false"></label><p class="pl-err" id="licErr2" aria-live="polite"></p>
    <button class="btn btn-primary" data-act="licActivate">Activate</button>`:'<p class="muted">Only the account owner can activate this till.</p>'}</div></div>`:''}`;
}

/* ---------- Updates (Settings → Updates) ----------
 * The till server decides when an update may be installed: never mid-sale, always after a verified backup. This
 * screen shows what it says and lets the owner choose how updates happen. */
U.upd=U.upd||{status:null,err:null,busy:false};
async function updatesCheck(){
  if(!window.PlemmoAPI||!PlemmoAPI.isAuthenticated())return;
  try{U.upd.status=await PlemmoAPI.get('/updates/status');U.upd.err=null;}
  catch(e){U.upd.err=(e&&e.data&&e.data.error)||'The update status could not be read.';}
  if(U.view==='settings'&&U.set.tab==='updates')renderView();
}
function updatesHTML(){
  const st=U.upd.status;
  if(U.upd.err)return`<div class="panel"><div class="panel-b"><p class="muted">${licEsc(U.upd.err)}</p></div></div>`;
  if(!st)return`<div class="panel"><div class="panel-b"><p class="muted">Reading update status…</p></div></div>`;
  const owner=!!(me()&&me().plemmoRole==='owner'),mgr=owner||!!(me()&&me().plemmoRole==='manager');
  const row=(t,sub,ctl)=>`<div class="set-row"><div class="sr-t"><b>${t}</b>${sub?`<small>${sub}</small>`:''}</div>${ctl||''}</div>`;
  const s=st.settings;
  const line=st.downloaded?`Version ${licEsc(st.downloaded)} is ready to install`:st.available?`Version ${licEsc(st.available)} is downloading`:st.checking?'Checking…':'You are up to date';
  const hrs=(sel,k)=>`<select class="input" style="width:auto" data-ch="updHour" data-k="${k}" ${owner?'':'disabled'}>${[...Array(24)].map((_,h)=>`<option value="${h}" ${sel===h?'selected':''}>${String(h).padStart(2,'0')}:00</option>`).join('')}</select>`;
  return`<div class="panel"><div class="panel-b">
   ${row('Version',`This till is running <b>${licEsc(st.current)}</b>. ${line}.${st.last_checked_at?` Last checked ${licWhen(st.last_checked_at)}.`:''}${st.last_error?` <span style="color:var(--bad-text)">${licEsc(st.last_error)}</span>`:''}`,mgr?`<button class="btn" data-act="updCheck">Check now</button>`:'')}
   ${st.downloaded?row('Install',st.can_install_now?'Your data is backed up and checked first, then the till restarts into the new version.':`Not right now: ${licEsc(st.blockers.join('; '))}.`,mgr?`<span class="row" style="gap:8px"><button class="btn btn-primary" data-act="updInstall" ${st.can_install_now?'':'disabled'}>Install now</button><select class="input" style="width:auto" data-ch="updDefer"><option value="">Remind me later…</option><option value="60">in 1 hour</option><option value="240">in 4 hours</option><option value="1440">tomorrow</option></select></span>`:''):''}
   ${st.deferred&&s.deferred_until?row('Reminder paused',`Until ${licWhen(s.deferred_until)}`,''):''}
   ${row('How updates happen',s.mode==='ask'?'Updates are downloaded for you. Nothing installs until someone presses Install.':s.mode==='quiet_hours'?'Installed by itself in the quiet window below, and only when nothing is open. Each till waits a different few minutes so they never restart together.':'Never prompts or installs. Use "Check now" when you want to update.',`<select class="input" style="width:auto" data-ch="updMode" ${owner?'':'disabled'}>${[['ask','Ask me'],['quiet_hours','Install in quiet hours'],['manual','Only when I check']].map(([v,l])=>`<option value="${v}" ${s.mode===v?'selected':''}>${l}</option>`).join('')}</select>`)}
   ${s.mode==='quiet_hours'?row('Quiet window','Closed for business and nobody is selling',`<span class="row" style="gap:6px">${hrs(s.window_start_hour,'window_start_hour')} to ${hrs(s.window_end_hour,'window_end_hour')}</span>`):''}
  </div></div>
  <section class="panel mt"><div class="panel-h"><h3>Update history</h3><span class="ph-sub">Every update keeps a backup taken just before it</span></div><div class="panel-b flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>From</th><th>To</th><th>How</th><th>Result</th></tr></thead><tbody>
   ${st.history.map(h=>`<tr><td>${licWhen(h.at)}</td><td class="num">${licEsc(h.from)}</td><td class="num">${licEsc(h.to)}</td><td>${h.automatic?'Automatic':'Manual'}</td><td><span class="badge ${h.status==='ok'?'ok':'warn'}">${h.status==='ok'?'Done':h.status==='installing'?'Installing':'Failed'}</span>${h.note?`<small class="muted" style="display:block">${licEsc(h.note)}</small>`:''}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">No updates yet.</td></tr>'}
  </tbody></table></div></div></section>`;
}
A.updCheck=async()=>{try{await PlemmoAPI.post('/updates/check',{},{idempotent:false});}catch(e){toast((e&&e.data&&e.data.error)||'The check failed','warn');}await updatesCheck();};
A.updInstall=async()=>{
  if(U.upd.busy)return;
  if(!await confirmBox({title:'Install the update now?',text:'The till makes a backup, then restarts. Sales are unavailable for a minute or two.',ok:'Install and restart'}))return;
  U.upd.busy=true;
  try{await PlemmoAPI.post('/updates/install',{},{idempotent:false});toast('Update starting. The till will restart.','ok',{ms:6000});}
  catch(e){toast((e&&e.data&&e.data.error)||'The update could not be installed','warn',{ms:6000});}
  finally{U.upd.busy=false;await updatesCheck();}
};
CH.updDefer=async v=>{if(!v)return;try{await PlemmoAPI.post('/updates/defer',{minutes:Number(v)},{idempotent:false});toast('We will remind you later','info');}catch(e){toast((e&&e.data&&e.data.error)||'That did not save','warn');}await updatesCheck();};
CH.updMode=async v=>{try{await PlemmoAPI.request('/updates/settings',{method:'PUT',body:{mode:v},idempotent:false});}catch(e){toast((e&&e.data&&e.data.error)||'That did not save','warn');}await updatesCheck();};
CH.updHour=async(v,el)=>{try{await PlemmoAPI.request('/updates/settings',{method:'PUT',body:{[el.dataset.k]:Number(v)},idempotent:false});}catch(e){toast((e&&e.data&&e.data.error)||'That did not save','warn');}await updatesCheck();};
