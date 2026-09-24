
/* ---------- Session ---------- */
const U={user:null,view:'home',cart:null,pos:{cat:'all',q:''},selLine:null,newLine:null,mobCart:false,
  orders:{filter:'all',src:'all',q:'',limit:60},items:{tab:'items',q:'',cat:'all'},cust:{q:'',tier:'all'},team:{tab:'team',week:0},
  reports:{range:'7d'},kds:{mode:'tickets'},set:{tab:'business'},chat:[],aiMode:'fast',aiOff:false,lastAct:Date.now(),hideDrawerHint:false};
function newCart(){return{items:[],type:S&&S.settings.type==='retail'?'instore':'takeaway',table:null,custId:null,discount:null,orderId:null,note:''};}
const A={},IN={},CH={},VIEWS={};

/* ---------- Lookups ---------- */
const me=()=>S.employees.find(e=>e.id===U.user);
const emp=id=>S.employees.find(e=>e.id===id);
const prod=id=>S.products.find(p=>p.id===id);
const cust=id=>S.customers.find(c=>c.id===id);
const catOf=id=>S.categories.find(c=>c.id===id);
const tableOf=id=>S.tables.find(t=>t.id===id);
const orderOf=id=>S.orders.find(o=>o.id===id);
function can(p,e){e=e||me();if(!e)return false;if(e.role==='owner')return true;return((S.roles[e.role]||{}).perms||[]).includes(p);}
const roleLabel=r=>(S.roles[r]||{}).label||r;
const lowStock=()=>S.products.filter(p=>p.stock!=null&&p.available&&p.stock<=(p.low??5));
const onShift=id=>S.shifts.find(s=>s.emp===id&&!s.out);
function clockIn(id){if(!onShift(id)){S.shifts.push({id:uid('sh'),emp:id,in:Date.now(),out:null});save();}}
function clockOut(id){const s=onShift(id);if(s){s.out=Date.now();save();}}
function tierOf(c){const sp=c.spend||0;return sp>=300?{k:'gold',name:'Gold'}:sp>=120?{k:'silver',name:'Silver'}:{k:'bronze',name:'Bronze'};}
const tierBadge=c=>{const t=tierOf(c);return`<span class="tier ${t.k}">${t.name}</span>`;};
const typeLabel=t=>({takeaway:'Takeaway',dine:'Dine in',delivery:'Delivery',instore:'In store'})[t]||t;
const typeIcon=t=>({takeaway:'bag',dine:'dine',delivery:'truck',instore:'bag'})[t]||'bag';
const payLabel=o=>{if(o.status==='open')return'Unpaid';const ms=[...new Set(o.payments.map(p=>p.m))];return ms.length>1?'Split':ms[0]==='cash'?'Cash':'Card';};
function hospitality(){return S.settings.type!=='retail';}

/* ---------- Toasts & tooltips ---------- */
function toast(msg,type='',opt={}){
  const t=document.createElement('div');t.className='toast '+type;
  t.innerHTML=`<span>${esc(msg)}</span>${opt.action?`<button class="toast-act" type="button">${esc(opt.action)}</button>`:''}`;
  if(opt.action)t.querySelector('button').onclick=()=>{opt.onAction&&opt.onAction();t.remove();};
  $('#toasts').classList.toggle('top',layers.length>0);
  $('#toasts').appendChild(t);
  const all=$$('.toast',$('#toasts'));if(all.length>3)all[0].remove();
  setTimeout(()=>{t.classList.add('out');setTimeout(()=>t.remove(),260);},opt.ms||3200);
}
const tipEl=$('#tip');
document.addEventListener('pointerover',e=>{
  const t=e.target.closest&&e.target.closest('[data-tip]');
  if(!t){tipEl.classList.remove('on');return;}
  tipEl.textContent=t.getAttribute('data-tip');tipEl.classList.add('on');
  const r=t.getBoundingClientRect(),w=tipEl.offsetWidth,h=tipEl.offsetHeight;
  tipEl.style.left=clamp(r.left+r.width/2-w/2,8,innerWidth-w-8)+'px';
  tipEl.style.top=(r.top-h-8<8?r.bottom+8:r.top-h-8)+'px';
});

/* ---------- Layers: modals, drawers, popovers ---------- */
const layers=[];
function openLayer(html,{onClose,dismiss=true,scrim=''}={}){
  const el=document.createElement('div');el.className='scrim '+scrim;el.innerHTML=html;
  const prev=document.activeElement;
  $('#layer').appendChild(el);
  const L={el,dismiss,closed:false,close(v){if(L.closed)return;L.closed=true;const i=layers.indexOf(L);if(i>-1)layers.splice(i,1);el.classList.add('out');setTimeout(()=>el.remove(),170);try{if(prev&&document.contains(prev))prev.focus({preventScroll:true});}catch(e){}onClose&&onClose(v);}};
  el.addEventListener('pointerdown',e=>{if(e.target===el&&L.dismiss)L.close();});
  layers.push(L);
  requestAnimationFrame(()=>{const f=el.querySelector('[autofocus]');if(f)f.focus({preventScroll:true});else{const b=el.querySelector('.modal,.drawer,.pop,.palette');b&&b.focus({preventScroll:true});}});
  return L;
}
const topLayer=()=>layers[layers.length-1];
function closeTop(){const L=topLayer();if(L)L.close();}
function closeAll(){[...layers].reverse().forEach(L=>L.close());}
function modal({title,body='',foot='',cls='',onClose,dismiss=true,sub=''}){
  const id='mt'+Math.random().toString(36).slice(2,7);
  return openLayer(`<div class="modal ${cls}" role="dialog" aria-modal="true" aria-labelledby="${id}" tabindex="-1"><div class="m-head"><div><h2 id="${id}">${title}</h2>${sub?`<p class="m-sub">${sub}</p>`:''}</div><button class="btn btn-ghost btn-icon" data-act="closeTop" aria-label="Close">${ic('x')}</button></div><div class="m-body">${body}</div>${foot?`<div class="m-foot">${foot}</div>`:''}</div>`,{onClose,dismiss});
}
function drawer({title,body='',foot='',onClose}){
  return openLayer(`<aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(title.replace(/<[^>]+>/g,''))}" tabindex="-1"><div class="m-head"><div><h2>${title}</h2></div><button class="btn btn-ghost btn-icon" data-act="closeTop" aria-label="Close">${ic('x')}</button></div><div class="m-body">${body}</div>${foot?`<div class="m-foot">${foot}</div>`:''}</aside>`,{onClose,scrim:'scrim-drawer'});
}
function popover(anchor,html){
  const r=anchor.getBoundingClientRect();
  const right=Math.max(8,innerWidth-r.right);
  const top=r.bottom+6+260>innerHeight?Math.max(8,r.top-6-Math.min(320,r.top)):r.bottom+6;
  return openLayer(`<div class="pop" role="menu" tabindex="-1" style="top:${top}px;right:${right}px">${html}</div>`,{scrim:'scrim-clear'});
}
function confirmBox({title,text,ok='Confirm',danger=false}){
  return new Promise(res=>{let done=false;
    const L=modal({title:esc(title),cls:'narrow',body:`<p class="muted">${text}</p>`,foot:`<button class="btn" data-act="closeTop">Cancel</button><button class="btn ${danger?'btn-danger-solid':'btn-primary'}" id="cfOk" autofocus>${esc(ok)}</button>`,onClose:()=>{if(!done)res(false);}});
    L.el.querySelector('#cfOk').onclick=()=>{done=true;L.close();res(true);};
  });
}
function promptBox({title,label,value='',placeholder='',ok='Save',type='text'}){
  return new Promise(res=>{let done=false;
    const L=modal({title:esc(title),cls:'narrow',body:`<label class="field"><span>${esc(label)}</span><input class="input" id="pbIn" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autofocus></label>`,foot:`<button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="pbOk">${esc(ok)}</button>`,onClose:()=>{if(!done)res(null);}});
    const go=()=>{done=true;const v=L.el.querySelector('#pbIn').value;L.close();res(v);};
    L.el.querySelector('#pbOk').onclick=go;
    L.el.querySelector('#pbIn').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();go();}});
  });
}

/* ---------- Keypads & PIN approval ---------- */
const pads=[];
function keypadHTML(kind='pin',cls=''){
  const keys=kind==='pin'?['1','2','3','4','5','6','7','8','9','clear','0','back']:['1','2','3','4','5','6','7','8','9','.','0','back'];
  return `<div class="keypad ${cls}" data-pad>${keys.map(k=>`<button type="button" class="key ${k.length>1?'key-fn':''}" data-key="${k}" aria-label="${k==='back'?'Delete':k==='clear'?'Clear':k}">${k==='back'?ic('backspace',22):k==='clear'?'Clear':k}</button>`).join('')}</div>`;
}
function bindPad(root,fn){
  root.querySelectorAll('[data-pad]').forEach(p=>p.addEventListener('click',e=>{const b=e.target.closest('[data-key]');if(!b)return;fn(b.dataset.key);b.classList.add('hit');setTimeout(()=>b.classList.remove('hit'),120);}));
  pads.push({root,fn});
}
function activePad(){for(let i=pads.length-1;i>=0;i--){const p=pads[i];if(!document.contains(p.root)||p.root.closest('.scrim.out')){pads.splice(i,1);continue;}if(p.root.closest('[hidden]')||!p.root.querySelector('[data-pad]'))continue;const L=topLayer();if(L&&!L.el.contains(p.root))return null;return p;}return null;}
const dotsHTML=n=>[0,1,2,3].map(i=>`<i class="${i<n?'f':''}"></i>`).join('');
function pinPrompt({title,text,check}){
  return new Promise(res=>{let pin='',done=false;
    const L=modal({title:esc(title),cls:'narrow',body:`<p class="muted pin-txt">${text}</p><div class="pin-dots">${dotsHTML(0)}</div><p class="pin-err" aria-live="assertive"></p>${keypadHTML('pin')}`,onClose:()=>{if(!done)res(null);}});
    const dots=L.el.querySelector('.pin-dots'),err=L.el.querySelector('.pin-err');
    bindPad(L.el,k=>{
      if(done)return;
      if(k==='back')pin=pin.slice(0,-1);else if(k==='clear')pin='';else if(/^\d$/.test(k)&&pin.length<4)pin+=k;
      dots.innerHTML=dotsHTML(pin.length);err.textContent='';
      if(pin.length===4){
        const e=S.employees.find(x=>x.pin===pin&&x.active!==false);
        if(e&&(!check||check(e))){done=true;setTimeout(()=>{L.close();res(e);},140);}
        else{err.textContent=e?`${first(e.name)} can’t approve this. Ask a manager.`:'That PIN doesn’t match anyone on the team.';dots.classList.add('shake');setTimeout(()=>{dots.classList.remove('shake');dots.innerHTML=dotsHTML(0);},380);pin='';}
      }
    });
  });
}
function approve(perm,what){
  if(can(perm))return Promise.resolve(me());
  return pinPrompt({title:'Manager approval',text:`${esc(what)} needs someone who can ${esc(permLabel(perm).toLowerCase())}. Hand over the till and ask them to enter their PIN.`,check:e=>can(perm,e)});
}

/* ---------- Theme ---------- */
function applyTheme(st){
  st=st||(S&&S.settings)||{};
  const r=document.documentElement,t=st.theme||'system';
  if(t==='system')r.removeAttribute('data-theme');else r.setAttribute('data-theme',t);
  const a=ACCENTS[st.accent]||ACCENTS.marigold;
  r.style.setProperty('--accent',a.c);r.style.setProperty('--accent-ink',a.ink);
}
function isDark(){const t=document.documentElement.getAttribute('data-theme');return t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;}
function toggleTheme(){S.settings.theme=isDark()?'light':'dark';applyTheme();save();renderTopbar();if(U.view==='settings')renderView();}

/* ---------- Shell ---------- */
const NAV=[
 {id:'home',label:'Home',icon:'home'},
 {id:'pos',label:'Register',icon:'register',perm:'pos'},
 {id:'tables',label:'Tables',icon:'tables',perm:'pos',when:()=>S.settings.tables},
 {id:'kitchen',label:'Kitchen',icon:'chef',perm:'kitchen',when:()=>S.settings.kitchen},
 {id:'orders',label:'Orders',icon:'receipt',perm:'orders'},
 {id:'kiosk',label:'Kiosk',icon:'kiosk',perm:'pos',when:()=>S.settings.kioskEnabled},
 {sep:true},
 {id:'items',label:'Items',icon:'box',perm:'products'},
 {id:'customers',label:'Customers',icon:'heart',perm:'customers'},
 {id:'team',label:'Team',icon:'users',perm:'team'},
 {id:'cash',label:'Cash',icon:'cash',perm:'cash'},
 {id:'reports',label:'Reports',icon:'chart',perm:'reports'},
 {id:'assistant',label:'Assistant',icon:'sparkle',perm:'assistant'},
];
const TITLES={home:'Home',pos:'Register',tables:'Tables',kitchen:'Kitchen',orders:'Orders',items:'Items & stock',customers:'Customers',team:'Team',cash:'Cash drawer',reports:'Reports',assistant:'Assistant',settings:'Settings'};
const navVisible=n=>!n.sep&&(!n.when||n.when())&&(!n.perm||can(n.perm));
function render(){if(!U.user||!S)return;renderRail();renderTopbar();renderView();}
function renderRail(){
  const kq=S.tickets.filter(t=>t.status==='new'||t.status==='prep').length;
  const low=lowStock().length;
  const badges={kitchen:kq?[kq,'']:null,items:low?[low,'warn']:null};
  let html=`<div class="mark" aria-hidden="true">M</div>`,lastSep=true;
  NAV.forEach(n=>{
    if(n.sep){if(!lastSep){html+='<div class="rail-sep"></div>';lastSep=true;}return;}
    if(!navVisible(n))return;lastSep=false;
    const b=badges[n.id];
    html+=`<button class="nav-item ${U.view===n.id?'on':''}" data-act="nav" data-v="${n.id}" ${U.view===n.id?'aria-current="page"':''}><span class="nb">${ic(n.icon,20)}</span><span>${n.label}</span>${b?`<span class="nav-badge ${b[1]}">${b[0]}</span>`:''}</button>`;
  });
  html+=`<div class="rail-foot">${can('settings')?`<button class="nav-item ${U.view==='settings'?'on':''}" data-act="nav" data-v="settings"><span class="nb">${ic('settings')}</span><span>Settings</span></button>`:''}<button class="nav-item" data-act="lock"><span class="nb">${ic('lock')}</span><span>Lock</span></button></div>`;
  $('#rail').innerHTML=html;
}
function renderTopbar(){
  const e=me();if(!e)return;
  $('#topbar').innerHTML=`
   <button class="btn btn-ghost btn-icon mob-only" data-act="mobNav" aria-label="Open menu">${ic('menu')}</button>
   <div class="tb-title"><b>${esc(TITLES[U.view]||'')}</b><span>${esc(S.settings.name)}, ${fmtD(Date.now())}</span></div>
   <button class="search-trig" data-act="palette" aria-label="Search">${ic('search',18)}<span>Search or jump to…</span><kbd>${isMac?'⌘':'Ctrl'} K</kbd></button>
   <div class="tb-right">
     <span class="net ${navigator.onLine?'':'off'}" id="netStat" data-tip="${navigator.onLine?'Connected. Sales are saved on this device as they happen.':'No connection. Keep selling: card payments and sales are saved on this device.'}">${navigator.onLine?'Online':'Offline'}</span>
     <span class="tb-clock num" id="tbClock">${fmtT(Date.now())}</span>
     ${can('assistant')&&U.view!=='assistant'?`<button class="btn btn-sm desk-only" data-act="nav" data-v="assistant">${ic('sparkle',16)} Ask</button>`:''}
     <button class="btn btn-ghost btn-icon" data-act="theme" aria-label="Switch to ${isDark()?'light':'dark'} theme">${ic(isDark()?'sun':'moon')}</button>
     <button class="user-chip" data-act="userMenu" aria-label="Account menu"><span class="av" style="--c:${e.color}">${initials(e.name)}</span><span class="uc-t"><b>${esc(first(e.name))}</b><small>${esc(roleLabel(e.role))}</small></span>${ic('chevD',16)}</button>
   </div>`;
}
function renderView(){
  const v=VIEWS[U.view]||VIEWS.home;const el=$('#view');
  el.dataset.view=U.view;
  el.classList.toggle('fixed',['pos','kitchen','assistant'].includes(U.view));
  el.innerHTML=v();
  (AFTER[U.view]||(()=>{}))();
}
const AFTER={};
function go(v){
  if(v==='kiosk'){openKiosk();return;}
  const n=NAV.find(x=>x.id===v);
  if(n&&n.perm&&!can(n.perm)){toast(`Your role can’t open ${n.label}. Ask a manager.`,'warn');return;}
  if(v==='settings'&&!can('settings')){toast('Only the owner can change settings','warn');return;}
  U.view=v;U.mobCart=false;$('#rail').classList.remove('open');
  render();$('#view').scrollTop=0;
}

/* ---------- Command palette ---------- */
let PAL=null;
function openPalette(){
  if(!U.user)return;
  const L=openLayer(`<div class="palette" role="dialog" aria-modal="true" aria-label="Search"><div class="pal-in">${ic('search')}<input id="palQ" placeholder="Search pages, items, customers or an order number" autocomplete="off" autofocus aria-controls="palList"><kbd>Esc</kbd></div><div class="pal-list" id="palList" role="listbox"></div></div>`,{scrim:'scrim-top'});
  PAL={L,idx:0,items:[]};
  const inp=L.el.querySelector('#palQ');
  const draw=()=>{PAL.items=palItems(inp.value);PAL.idx=clamp(PAL.idx,0,Math.max(0,PAL.items.length-1));
    let g='',h='';PAL.items.forEach((x,i)=>{if(x.g!==g){g=x.g;h+=`<div class="pal-g">${esc(g)}</div>`;}h+=`<button class="pal-i ${i===PAL.idx?'on':''}" data-pi="${i}" role="option" aria-selected="${i===PAL.idx}"><span class="pal-e">${x.emoji?x.emoji:ic(x.icon||'chevR',16)}</span><span>${esc(x.label)}</span>${x.meta?`<span class="pal-m">${esc(x.meta)}</span>`:''}</button>`;});
    L.el.querySelector('#palList').innerHTML=h||`<div class="pal-empty">Nothing matches “${esc(inp.value)}”. Try an item name, a customer, or an order number like 1420.</div>`;
    const on=L.el.querySelector('.pal-i.on');on&&on.scrollIntoView({block:'nearest'});};
  const run=i=>{const x=PAL.items[i];if(!x)return;L.close();setTimeout(()=>x.run(),10);};
  inp.addEventListener('input',()=>{PAL.idx=0;draw();});
  inp.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();PAL.idx=Math.min(PAL.items.length-1,PAL.idx+1);draw();}else if(e.key==='ArrowUp'){e.preventDefault();PAL.idx=Math.max(0,PAL.idx-1);draw();}else if(e.key==='Enter'){e.preventDefault();run(PAL.idx);}});
  L.el.querySelector('#palList').addEventListener('click',e=>{const b=e.target.closest('[data-pi]');if(b)run(+b.dataset.pi);});
  draw();
}
function palItems(q){
  q=q.trim().toLowerCase();const out=[];
  NAV.filter(navVisible).forEach(n=>out.push({g:'Go to',label:n.label,icon:n.icon,run:()=>go(n.id)}));
  if(can('settings'))out.push({g:'Go to',label:'Settings',icon:'settings',run:()=>go('settings')});
  [{label:'Start a new sale',icon:'plus',perm:'pos',run:()=>{U.cart=newCart();go('pos');}},
   {label:'Open the customer kiosk',icon:'kiosk',perm:'pos',run:openKiosk,when:()=>S.settings.kioskEnabled},
   {label:`Switch to ${isDark()?'light':'dark'} theme`,icon:isDark()?'sun':'moon',run:toggleTheme},
   {label:'End-of-day report',icon:'receipt',perm:'reports',run:()=>showZ(dayStart(0))},
   {label:'Count and close the cash drawer',icon:'cash',perm:'cash',run:()=>{go('cash');if(S.drawer.open)setTimeout(openCloseDrawer,50);}},
   {label:'Add a customer',icon:'user',perm:'customers',run:()=>{go('customers');setTimeout(()=>editCustomer(),50);}},
   {label:'Add an item',icon:'box',perm:'products',run:()=>{go('items');setTimeout(()=>editItem(),50);}},
   {label:'Lock the till',icon:'lock',run:showLock},
   {label:'Clock out and lock',icon:'logout',run:()=>{clockOut(U.user);showLock();toast('Clocked out');}},
  ].filter(a=>(!a.perm||can(a.perm))&&(!a.when||a.when())).forEach(a=>out.push({g:'Actions',...a}));
  let res=q?out.filter(x=>x.label.toLowerCase().includes(q)):out.slice(0,14);
  if(q){
    if(can('pos'))S.products.filter(p=>p.name.toLowerCase().includes(q)||String(p.sku||'')===q).slice(0,6).forEach(p=>res.push({g:'Add to the current order',label:p.name,meta:money(p.price),emoji:p.emoji,run:()=>{if(U.view!=='pos')go('pos');addProduct(p.id);}}));
    if(can('customers'))S.customers.filter(c=>c.name.toLowerCase().includes(q)||c.phone.includes(q)).slice(0,5).forEach(c=>res.push({g:'Customers',label:c.name,meta:tierOf(c).name+' member',icon:'user',run:()=>{go('customers');setTimeout(()=>openCustDrawer(c.id),30);}}));
    const n=q.replace('#','');
    if(/^\d{2,}$/.test(n)&&can('orders'))S.orders.filter(o=>String(o.no).startsWith(n)).slice(-6).reverse().forEach(o=>res.push({g:'Orders',label:'Order '+o.no,meta:money(o.total)+', '+fmtDT(o.ts),icon:'receipt',run:()=>openOrderDrawer(o.id)}));
  }
  return res;
}

/* ---------- Lock screen ---------- */
const LK={sel:null,pin:'',mode:'signin'};
function showLock(){
  U.user=null;closeAll();
  $('#app').hidden=true;$('#kiosk').hidden=true;$('#onboard').hidden=true;$('#lock').hidden=false;
  LK.pin='';
  const staff=S.employees.filter(e=>e.active!==false);
  if(!staff.find(e=>e.id===LK.sel))LK.sel=staff[0]&&staff[0].id;
  renderLock();
}
function renderLock(){
  const el=$('#lock'),now=Date.now();
  const staff=S.employees.filter(e=>e.active!==false);
  const sel=emp(LK.sel)||staff[0];
  const t0=dayStart(0),todays=S.orders.filter(o=>o.ts>=t0&&o.status==='paid');
  const recent=S.orders.filter(o=>o.status!=='open').sort((a,b)=>b.ts-a.ts).slice(0,9);
  const onNow=staff.filter(e=>onShift(e.id));
  el.innerHTML=`<div class="lock">
   <section class="lock-l" aria-hidden="true">
     <div class="brand"><div class="mark sm">M</div><span>Meridian</span></div>
     <div class="lock-tape"><div class="paper"><div class="p-h"><b>${esc(S.settings.name)}</b><span class="pm">Latest sales</span></div><div class="rule"></div>${recent.map(o=>`<div class="kv"><span>${o.no}</span><span class="pm">${fmtT(o.ts)}</span><span>${money(o.total)}</span></div>`).join('')||'<div class="pm">No sales yet today</div>'}</div></div>
     <div class="lock-time num" id="lockTime">${fmtT(now)}</div>
     <div class="lock-date">${fmtDL(now)}</div>
     <div class="lock-biz">${esc(S.settings.name)}</div>
     <div class="lock-meta"><span><b>${todays.length}</b> orders today</span><span><b>${onNow.length}</b> on shift</span>${S.tickets.filter(t=>t.status==='new'||t.status==='prep').length?`<span><b>${S.tickets.filter(t=>t.status==='new'||t.status==='prep').length}</b> in the kitchen</span>`:''}</div>
   </section>
   <section class="lock-r">
     <div class="seg" role="tablist"><button class="${LK.mode==='signin'?'on':''}" data-act="lkMode" data-m="signin">Sign in</button><button class="${LK.mode==='clock'?'on':''}" data-act="lkMode" data-m="clock">Clock in or out</button></div>
     <h2>${LK.mode==='signin'?'Who’s on the till?':'Who’s clocking in or out?'}</h2>
     <div class="staff-pick">${staff.map(e=>`<button class="sp ${e.id===sel.id?'on':''}" data-act="lkSel" data-id="${e.id}" aria-pressed="${e.id===sel.id}"><span class="av lg" style="--c:${e.color}">${initials(e.name)}</span><span class="sp-n">${esc(first(e.name))}</span><span class="sp-r">${onShift(e.id)?'<i class="dot ok"></i>On shift':esc(e.position||roleLabel(e.role))}</span></button>`).join('')}</div>
     <p class="muted" id="lkPrompt">Enter ${esc(first(sel.name))}’s 4-digit PIN</p>
     <div class="pin-dots" id="lkDots">${dotsHTML(LK.pin.length)}</div>
     <p class="pin-err" id="lkErr" aria-live="assertive"></p>
     ${keypadHTML('pin')}
     ${S.settings.kioskEnabled?`<button class="btn btn-ghost btn-sm" data-act="kioskFromLock">${ic('kiosk',16)} Start the customer kiosk</button>`:''}
     ${S.demo?`<details class="demo-pins"><summary>Demo PINs</summary><div>${staff.map(e=>`<span>${esc(first(e.name))} (${esc(roleLabel(e.role))}): <b>${e.pin}</b></span>`).join('')}</div></details>`:''}
   </section></div>`;
  bindPad(el,lkKey);
}
function lkKey(k){
  if(k==='back')LK.pin=LK.pin.slice(0,-1);else if(k==='clear')LK.pin='';else if(/^\d$/.test(k)&&LK.pin.length<4)LK.pin+=k;
  const d=$('#lkDots');if(d)d.innerHTML=dotsHTML(LK.pin.length);
  const er=$('#lkErr');if(er)er.textContent='';
  if(LK.pin.length===4)setTimeout(checkLock,120);
}
function checkLock(){
  const e=emp(LK.sel);
  if(e&&e.pin===LK.pin){
    LK.pin='';
    if(LK.mode==='clock'){
      if(onShift(e.id)){clockOut(e.id);toast(`${first(e.name)} clocked out at ${fmtT(Date.now())}`);}
      else{clockIn(e.id);toast(`${first(e.name)} clocked in at ${fmtT(Date.now())}`);}
      renderLock();return;
    }
    signIn(e);
  }else{
    LK.pin='';const d=$('#lkDots');
    if(d){d.classList.add('shake');setTimeout(()=>{d.classList.remove('shake');d.innerHTML=dotsHTML(0);},380);}
    const er=$('#lkErr');if(er)er.textContent='That PIN doesn’t match. Try again.';
  }
}
function signIn(e){
  U.user=e.id;U.lastAct=Date.now();
  if(!onShift(e.id)){clockIn(e.id);setTimeout(()=>toast(`Welcome, ${first(e.name)}. You’re clocked in from ${fmtT(Date.now())}.`),200);}
  else setTimeout(()=>toast(`Signed in as ${first(e.name)}`),200);
  $('#lock').hidden=true;$('#app').hidden=false;
  if(!U.cart)U.cart=newCart();
  U.view=e.role==='staff'?'pos':'home';
  render();
}
A.lkSel=d=>{LK.sel=d.id;LK.pin='';renderLock();};
A.lkMode=d=>{LK.mode=d.m;LK.pin='';renderLock();};
A.kioskFromLock=()=>openKiosk();
A.lock=()=>showLock();

/* ---------- Onboarding ---------- */
const OB={step:0,d:null,err:''};
const OB_STEPS=['welcome','business','tax','menu','team','look','done'];
const BIZ_TYPES=[['cafe','Café','☕'],['restaurant','Restaurant','🍽️'],['bar','Bar','🍸'],['retail','Retail shop','🛍️']];
const CURRENCIES=[['£','British pound (£)'],['€','Euro (€)'],['$','US dollar ($)'],['Rs ','Pakistani rupee (Rs)'],['AED ','UAE dirham (AED)']];
function obDefaults(){return{name:'',type:'cafe',address:'',currency:'£',taxName:'VAT',taxRate:20,taxInclusive:true,catalog:'sample',history:true,ownerName:'',pin:'',pin2:'',sampleStaff:true,accent:'marigold',theme:'system'};}
function showOnboarding(){
  OB.step=0;OB.d=obDefaults();OB.err='';
  applyTheme({accent:OB.d.accent,theme:OB.d.theme});
  $('#app').hidden=true;$('#lock').hidden=true;$('#kiosk').hidden=true;$('#onboard').hidden=false;
  renderOB();
}
const OBV={
 welcome:()=>`<h1 class="hero">Set up your till in two minutes.</h1>
   <p class="lede">Meridian runs your counter, kitchen, kiosk, stock, team and reports from one screen. Tell it about your business and it builds the rest.</p>
   <div class="row"><button class="btn btn-primary btn-lg" data-act="obNext">Set up my business ${ic('chevR',18)}</button></div>
   <div class="demo-card"><div><b>Just looking?</b><p class="muted" style="margin-top:2px">Open a demo café with nine weeks of sales, a live kitchen and a team of five.</p></div><button class="btn" data-act="obDemo">${ic('play',16)} Open the demo café</button></div>`,
 business:()=>`<h1>What’s your business called?</h1>
   <label class="field"><span>Business name</span><input class="input" id="obName" data-in="ob" data-k="name" value="${esc(OB.d.name)}" placeholder="For example, Ember & Oat" autocomplete="organization" autofocus></label>
   <div class="field"><span>What kind of place is it?</span><div class="type-grid">${BIZ_TYPES.map(([k,l,e])=>`<button class="type-card ${OB.d.type===k?'on':''}" data-act="obSet" data-k="type" data-v="${k}" aria-pressed="${OB.d.type===k}"><span>${e}</span>${l}</button>`).join('')}</div></div>
   <label class="field"><span>Address, for your receipts</span><input class="input" data-in="ob" data-k="address" value="${esc(OB.d.address)}" placeholder="Street, town, postcode" autocomplete="street-address"></label>`,
 tax:()=>`<h1>Money and tax</h1>
   <div class="fgrid">
    <label class="field span2"><span>Currency</span><select class="input" data-ch="ob" data-k="currency">${CURRENCIES.map(([v,l])=>`<option value="${esc(v)}" ${OB.d.currency===v?'selected':''}>${l}</option>`).join('')}</select></label>
    <label class="field"><span>Tax name</span><input class="input" data-in="ob" data-k="taxName" value="${esc(OB.d.taxName)}"></label>
    <label class="field"><span>Standard rate (%)</span><input class="input" type="number" min="0" max="50" step="0.5" data-in="ob" data-k="taxRate" value="${OB.d.taxRate}"></label>
   </div>
   <label class="switch"><input type="checkbox" data-ch="ob" data-k="taxInclusive" ${OB.d.taxInclusive?'checked':''}><span class="tr"></span><span>My prices already include tax</span></label>
   <p class="hint">The UK standard VAT rate is 20%, and menu prices normally include it. You can change this later in Settings.</p>`,
 menu:()=>{const r=OB.d.type==='retail';return`<h1>Start with a ${r?'catalogue':'menu'}</h1>
   <div class="opt-cards">
    <button class="opt-card ${OB.d.catalog==='sample'?'on':''}" data-act="obSet" data-k="catalog" data-v="sample"><span class="oc-e">${r?'🛍️':'☕'}</span><span><b>Use a sample ${r?'shop catalogue':'café menu'}</b><small>${r?'17 products across 5 categories with stock levels and gift-wrap options.':'38 items across 7 categories, with sizes, milks and add-ons ready to go.'} Edit or delete anything later.</small></span></button>
    <button class="opt-card ${OB.d.catalog==='empty'?'on':''}" data-act="obSet" data-k="catalog" data-v="empty"><span class="oc-e">📝</span><span><b>Start empty</b><small>Add your own items from the Items page.</small></span></button>
   </div>
   <label class="switch" ${OB.d.catalog==='empty'?'style="opacity:.45;pointer-events:none"':''}><input type="checkbox" data-ch="ob" data-k="history" ${OB.d.history&&OB.d.catalog!=='empty'?'checked':''}><span class="tr"></span><span>Add nine weeks of sample sales so reports have something to show</span></label>`;},
 team:()=>`<h1>You’re the owner</h1>
   <div class="fgrid">
    <label class="field span2"><span>Your name</span><input class="input" data-in="ob" data-k="ownerName" value="${esc(OB.d.ownerName)}" placeholder="First and last name" autocomplete="name" autofocus></label>
    <label class="field"><span>Choose a 4-digit PIN</span><input class="input num" type="password" inputmode="numeric" maxlength="4" data-in="ob" data-k="pin" value="${esc(OB.d.pin)}" autocomplete="new-password"></label>
    <label class="field"><span>Type it again</span><input class="input num" type="password" inputmode="numeric" maxlength="4" data-in="ob" data-k="pin2" value="${esc(OB.d.pin2)}" autocomplete="new-password"></label>
   </div>
   <p class="hint">Everyone signs in to the till with a PIN, so every sale, refund and discount is recorded against a person.</p>
   <label class="switch"><input type="checkbox" data-ch="ob" data-k="sampleStaff" ${OB.d.sampleStaff?'checked':''}><span class="tr"></span><span>Add four sample team members to try roles and timesheets</span></label>`,
 look:()=>`<h1>Make it yours</h1>
   <div class="field"><span>Accent colour</span><div class="swatches">${Object.entries(ACCENTS).map(([k,a])=>`<button class="swatch ${OB.d.accent===k?'on':''}" style="--sw:${a.c};--swi:${a.ink}" data-act="obSet" data-k="accent" data-v="${k}" aria-label="${a.name}" aria-pressed="${OB.d.accent===k}">${OB.d.accent===k?ic('check',20):''}</button>`).join('')}</div></div>
   <div class="field"><span>Appearance</span><div class="seg">${[['light','Light'],['dark','Dark'],['system','Match this device']].map(([k,l])=>`<button class="${OB.d.theme===k?'on':''}" data-act="obSet" data-k="theme" data-v="${k}">${l}</button>`).join('')}</div></div>
   <p class="hint">The accent colour marks the most important button on every screen, like Charge on the register.</p>`,
 done:()=>{const d=OB.d,r=d.type==='retail';return`<h1 class="hero">${esc(d.name)} is ready.</h1>
   <div class="ob-done-list">
    <div><i>${ic('check',16)}</i>${d.catalog==='sample'?(r?'Sample catalogue with stock levels':'Sample menu with sizes, milks and add-ons'):'An empty catalogue, ready for your items'}</div>
    <div><i>${ic('check',16)}</i>${esc(d.taxName)} at ${d.taxRate}%, prices ${d.taxInclusive?'include':'exclude'} tax</div>
    <div><i>${ic('check',16)}</i>Owner PIN for ${esc(first(d.ownerName))}${d.sampleStaff?', plus four sample team members':''}</div>
    ${!r?`<div><i>${ic('check',16)}</i>Floor plan with 12 tables, kitchen display and a customer kiosk</div>`:`<div><i>${ic('check',16)}</i>Customer kiosk for self-checkout</div>`}
    ${d.catalog==='sample'&&d.history?`<div><i>${ic('check',16)}</i>Nine weeks of sample sales for reports and the assistant</div>`:''}
   </div>
   <div class="row"><button class="btn btn-primary btn-lg" data-act="obFinish" id="obGo">Open Meridian ${ic('chevR',18)}</button></div>`;},
};
function renderOB(){
  const st=OB_STEPS[OB.step],mid=OB.step>0&&OB.step<6;
  $('#onboard').innerHTML=`<div class="ob">
   <section class="ob-l">
    <header class="ob-top"><div class="brand"><div class="mark sm">M</div><span>Meridian</span></div>${mid?`<span class="ob-count">Step ${OB.step} of 5</span>`:''}</header>
    ${mid?`<div class="ob-prog" role="progressbar" aria-valuemin="0" aria-valuemax="5" aria-valuenow="${OB.step}"><i style="width:${OB.step/5*100}%"></i></div>`:''}
    <div class="ob-body">${OBV[st]()}<p class="err" id="obErr" aria-live="assertive">${esc(OB.err)}</p></div>
    ${mid?`<div class="ob-nav"><button class="btn btn-ghost" data-act="obBack">${ic('chevL',18)} Back</button><button class="btn btn-primary btn-lg" data-act="obNext">Continue ${ic('chevR',18)}</button></div>`:''}
   </section>
   <section class="ob-r" aria-hidden="true"><div class="ob-stage" id="obPrev">${obPreview()}</div></section></div>`;
  const f=$('#onboard [autofocus]');if(f)f.focus();
}
function obPreview(){
  const d=OB.d,r=d.type==='retail',cur=d.currency||'£';
  const m=n=>cur+(+n).toFixed(2);
  const lines=r?[['A5 Dot Notebook',12],['Greeting Card',3.5]]:[['Flat White',3.3],['Butter Croissant',2.6]];
  const tot=lines.reduce((a,b)=>a+b[1],0),rate=(+d.taxRate||0)/100;
  const tax=d.taxInclusive?tot-tot/(1+rate):tot*rate,grand=d.taxInclusive?tot:tot+tax;
  return`<div class="paper"><div class="p-h"><b>${esc(d.name||'Your business')}</b><span class="pm">${esc(d.address||'Your address')}</span></div><div class="rule"></div>
    ${lines.map(([n,p])=>`<div class="kv"><span>1 ${esc(n)}</span><span>${m(p)}</span></div>`).join('')}<div class="rule"></div>
    <div class="kv pm"><span>${esc(d.taxName||'Tax')} ${d.taxRate||0}% ${d.taxInclusive?'incl.':''}</span><span>${m(tax)}</span></div>
    <div class="kv b"><span>Total</span><span>${m(grand)}</span></div><div class="rule"></div>
    <div class="p-h pm">${d.ownerName?'Served by '+esc(first(d.ownerName)):'Thank you, see you soon'}</div></div>
    <div class="ob-mock-btn"><span>Charge</span><span>${m(grand)}</span></div>`;
}
function obValidate(){
  const d=OB.d,st=OB_STEPS[OB.step];
  if(st==='business'&&!d.name.trim())return'Add your business name to continue.';
  if(st==='tax'&&(isNaN(+d.taxRate)||+d.taxRate<0||+d.taxRate>50))return'Enter a tax rate between 0 and 50.';
  if(st==='team'){if(!d.ownerName.trim())return'Add your name so sales can be recorded against you.';if(!/^\d{4}$/.test(d.pin))return'Your PIN needs to be exactly 4 digits.';if(d.pin!==d.pin2)return'The two PINs don’t match.';}
  return'';
}
IN.ob=(v,el)=>{OB.d[el.dataset.k]=v;$('#obPrev').innerHTML=obPreview();const e=$('#obErr');if(e&&e.textContent){OB.err='';e.textContent='';}};
CH.ob=(v,el)=>{OB.d[el.dataset.k]=el.type==='checkbox'?el.checked:v;$('#obPrev').innerHTML=obPreview();};
A.obSet=d=>{OB.d[d.k]=d.v;if(d.k==='accent'||d.k==='theme')applyTheme({accent:OB.d.accent,theme:OB.d.theme});if(d.k==='catalog'&&d.v==='empty')OB.d.history=false;if(d.k==='catalog'&&d.v==='sample')OB.d.history=true;renderOB();};
A.obNext=()=>{const e=obValidate();if(e){OB.err=e;const el=$('#obErr');if(el)el.textContent=e;return;}OB.err='';OB.step=Math.min(6,OB.step+1);renderOB();};
A.obBack=()=>{OB.err='';OB.step=Math.max(0,OB.step-1);renderOB();};
A.obFinish=async()=>{
  const b=$('#obGo');if(b){b.disabled=true;b.textContent='Setting up your till…';}
  await sleep(350);
  const d=OB.d;
  S=buildBusiness({name:d.name,type:d.type,address:d.address,currency:d.currency,taxName:d.taxName,taxRate:d.taxRate,taxInclusive:d.taxInclusive,catalog:d.catalog,history:d.history,ownerName:d.ownerName,ownerPin:d.pin,sampleStaff:d.sampleStaff,accent:d.accent,theme:d.theme});
  saveNow();applyTheme();LK.sel=S.employees[0].id;LK.mode='signin';showLock();
  toast(`Enter your PIN to open ${S.settings.name}`,'info');
};
A.obDemo=async()=>{
  S=buildBusiness({name:'Ember & Oat',type:'cafe',address:'14 Market Row, Kingsbridge',currency:'£',taxName:'VAT',taxRate:20,taxInclusive:true,catalog:'sample',history:true,ownerName:'Jordan Reed',ownerPin:'1234',sampleStaff:true,accent:OB.d?OB.d.accent:'marigold',theme:OB.d?OB.d.theme:'system',demo:true});
  saveNow();applyTheme();LK.sel=S.employees[0].id;LK.mode='signin';showLock();
  toast('Demo café ready. Jordan’s PIN is 1234.','info',{ms:5000});
};
