/* ============================================================================
 * 05e-team.js — adding and editing team members on a connected till
 * ----------------------------------------------------------------------------
 * On a connected till every change here is the till server's: it creates the account, sets the role, the
 * supervisor flag and the PIN, and refuses what the signed-in person is not allowed to do (managers cannot create
 * managers; only owners make supervisors). Nothing is saved on this device alone. The local-only editor in
 * 05-backoffice.js is used only when no server is reachable.
 * ==========================================================================*/
const LIVE_ROLE_LABELS={owner:'Owner',manager:'Manager',cashier:'Cashier',waiter:'Waiter',chef:'Chef'};
function personRole(e){
  if(adminLive()&&e.plemmoRole)return e.supervisor?'Supervisor':(LIVE_ROLE_LABELS[e.plemmoRole]||e.plemmoRole);
  return roleLabel(e.role);
}
// Rebuild the team from the server's list, keeping each person's colour on this device.
async function teamReload(){
  const staff=await PlemmoStaff.list();
  const colors=Object.fromEntries(S.employees.map(x=>[x.id,x.color]));
  S.employees=staff.map((s,i)=>({id:s.id,name:s.name,role:plemmoRoleToMeridian(s.role),plemmoRole:s.role,supervisor:!!s.supervisor,hasPin:!!s.hasPin,email:s.email||'',
    position:s.supervisor?'Supervisor':(LIVE_ROLE_LABELS[s.role]||s.role),rate:s.rate||0,pin:null,active:s.active,color:colors[s.id]||EMP_COLORS[i%EMP_COLORS.length]}));
  if(U.view==='team'||U.view==='home')renderView();
}
function teamEditLive(d){
  const e=d.id?emp(d.id):null,mine=me()&&me().plemmoRole,isOwner=mine==='owner';
  if(e&&(e.plemmoRole==='owner'||e.plemmoRole==='manager')&&!isOwner){toast('Only an owner can change an owner or a manager.','warn');return;}
  const options=isOwner?['manager','supervisor','cashier','waiter','chef']:['cashier','waiter','chef'];
  const cur=e?(e.supervisor?'supervisor':e.plemmoRole):'cashier';
  const labels={manager:'Manager',supervisor:'Supervisor (cashier who can approve refunds, voids and discounts)',cashier:'Cashier',waiter:'Waiter',chef:'Chef (kitchen display only)'};
  const roleFixed=!!e&&(e.plemmoRole==='owner'||!isOwner);
  const L=modal({title:e?esc(e.name):'Add a team member',body:`<div class="fgrid">
    <label class="field span2"><span>Full name</span><input class="input" id="tN" value="${esc(e?e.name:'')}" autofocus autocomplete="off" maxlength="80"></label>
    <label class="field span2"><span>Email (they sign in with this)</span><input class="input" id="tE" type="email" value="${esc(e?e.email:'')}" autocomplete="off"></label>
    <label class="field"><span>Role</span><select class="input" id="tR" ${roleFixed?'disabled':''}>${e&&e.plemmoRole==='owner'?'<option value="owner" selected>Owner</option>':options.map(o=>`<option value="${o}" ${o===cur?'selected':''}>${labels[o]}</option>`).join('')}${roleFixed&&e&&e.plemmoRole!=='owner'&&!options.includes(cur)?`<option value="${cur}" selected>${esc(labels[cur]||cur)}</option>`:''}</select></label>
    <label class="field"><span>${e?'New password (leave blank to keep)':'Password'}</span><input class="input" id="tP" type="password" autocomplete="new-password"></label>
    <label class="field" id="tPinF"><span>PIN for approvals, 4 to 6 digits${e&&e.hasPin?' (leave blank to keep)':''}</span><input class="input num" id="tPin" inputmode="numeric" maxlength="6" autocomplete="off"></label>
    ${e&&e.plemmoRole!=='owner'?`<div class="span2">${sw(e.active!==false,'id="tA"','Active, can sign in')}</div>`:''}
    <p class="hint span2">The password needs 8 or more characters with an upper-case letter, a lower-case letter and a number. Only managers and supervisors hold a PIN; it lets them approve other people’s refunds, voids, discounts and price changes.</p></div>`,
   foot:`<span class="spacer"></span><button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="tGo">${e?'Save':'Add to the team'}</button>`});
  const roleSel=L.el.querySelector('#tR'),pinF=L.el.querySelector('#tPinF');
  const showPin=()=>{const v=roleSel.value;pinF.hidden=!(v==='manager'||v==='supervisor'||v==='owner');};
  roleSel.addEventListener('change',showPin);showPin();
  L.el.querySelector('#tGo').onclick=async()=>{
    const go=L.el.querySelector('#tGo');if(go.disabled)return;
    const name=L.el.querySelector('#tN').value.trim(),email=L.el.querySelector('#tE').value.trim(),pw=L.el.querySelector('#tP').value,pin=L.el.querySelector('#tPin').value.trim();
    const sel=roleSel.value,role=sel==='supervisor'?'cashier':sel,sup=sel==='supervisor';
    if(!name){toast('Add their name','warn');return;}
    if(!e&&!email){toast('Add the email they will sign in with','warn');return;}
    if(!e&&!pw){toast('Choose a password for them','warn');return;}
    if(pin&&!/^\d{4,6}$/.test(pin)){toast('The PIN needs 4 to 6 digits','warn');return;}
    go.disabled=true;
    try{
      let id=e&&e.id;
      if(!e){
        const body={name,email,password:pw,role};
        if(isOwner)body.supervisor=sup;
        if(pin)body.pin=pin;
        const r=await PlemmoStaff.create(body);id=r&&r.staff&&r.staff.id;
      }else{
        const body={};
        if(name!==e.name)body.name=name;
        if(email&&email!==e.email)body.email=email;
        if(pw)body.password=pw;
        if(pin)body.pin=pin;
        if(isOwner&&!roleFixed){if(role!==e.plemmoRole)body.role=role;if(sup!==!!e.supervisor)body.supervisor=sup;}
        if(Object.keys(body).length)await PlemmoStaff.update(e.id,body);
        const a=L.el.querySelector('#tA');
        if(a&&a.checked!==(e.active!==false)){await (a.checked?PlemmoStaff.reactivate(e.id):PlemmoStaff.deactivate(e.id));}
      }
      await teamReload();L.close();
      toast(e?'Saved':`${first(name)} can now sign in with their email and password`,'ok',{ms:4200});
    }catch(err){go.disabled=false;toast((err&&err.data&&err.data.error)||'The till server did not accept that','warn',{ms:6000});}
  };
}
