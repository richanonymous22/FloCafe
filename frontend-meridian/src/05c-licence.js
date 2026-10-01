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
