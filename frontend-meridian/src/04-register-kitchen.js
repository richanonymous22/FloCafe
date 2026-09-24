
/* =====================================================================
   REGISTER
   ===================================================================== */
function cartTotals(c){c=c||U.cart;return totalsFor(c.items,c.discount);}
function inCartQty(pid){return sum(U.cart.items.filter(l=>l.pid===pid),l=>l.qty);}
let popCache={n:-1,ids:[]};
function popularIds(){
  if(popCache.n===S.orders.length)return popCache.ids;
  const from=dayStart(-14),q={};
  S.orders.forEach(o=>{if(o.ts>=from&&o.status==='paid')o.items.forEach(l=>{q[l.pid]=(q[l.pid]||0)+l.qty;});});
  popCache={n:S.orders.length,ids:Object.entries(q).sort((a,b)=>b[1]-a[1]).slice(0,12).map(x=>x[0])};
  return popCache.ids;
}
function posProducts(){
  const q=U.pos.q.trim().toLowerCase();
  let list=S.products;
  if(q)list=list.filter(p=>p.name.toLowerCase().includes(q)||String(p.sku||'')===q||(catOf(p.cat)||{name:''}).name.toLowerCase().includes(q));
  else if(U.pos.cat==='fav'){const ids=popularIds();list=ids.map(prod).filter(Boolean);}
  else if(U.pos.cat!=='all')list=list.filter(p=>p.cat===U.pos.cat);
  return list;
}
VIEWS.pos=()=>{
  if(!U.cart)U.cart=newCart();
  const hosp=hospitality();
  return`<div class="pos ${U.mobCart?'cart-open':''}" id="pos">
   <nav class="pos-cats" aria-label="Categories">
     <button class="cat-btn ${U.pos.cat==='fav'?'on':''}" data-act="posCat" data-id="fav" style="--c:var(--accent)"><span class="sw">${ic('star',16)}</span><span>Popular</span></button>
     <button class="cat-btn ${U.pos.cat==='all'?'on':''}" data-act="posCat" data-id="all" style="--c:var(--text)"><span class="sw">${ic('tables',16)}</span><span>All items</span></button>
     ${S.categories.map(c=>`<button class="cat-btn ${U.pos.cat===c.id?'on':''}" data-act="posCat" data-id="${c.id}" style="--c:${c.color}"><span class="sw">${c.emoji}</span><span>${esc(c.name)}</span></button>`).join('')}
   </nav>
   <section class="pos-center">
     <div class="pos-tools">
       <label class="search"><span class="sr">Search items</span>${ic('search',18)}<input id="posQ" data-in="posQ" value="${esc(U.pos.q)}" placeholder="Search items or scan a barcode" autocomplete="off" enterkeyhint="search"><kbd class="desk-only">/</kbd></label>
       ${hosp?`<div class="seg" aria-label="Order type">${['takeaway','dine','delivery'].map(t=>`<button class="${U.cart.type===t?'on':''}" data-act="setType" data-t="${t}">${ic(typeIcon(t),16)}${typeLabel(t)}</button>`).join('')}</div>`:''}
     </div>
     <div class="pos-strip" id="posStrip">${posStripHTML()}</div>
     <div class="pos-grid" id="posGrid">${gridHTML()}</div>
   </section>
   <aside class="tape" id="cart" aria-label="Current order">${cartHTML()}</aside>
   <button class="mob-cartbar" data-act="mobCart" id="mobBar" ${U.cart.items.length?'':'hidden'}>${mobBarHTML()}</button>
  </div>`;
};
function mobBarHTML(){const t=cartTotals();return`<span>Review order (${t.count})</span><span class="num">${money(t.total)}</span>`;}
function posStripHTML(){
  let h='';
  if(can('cash')&&!S.drawer.open&&!U.hideDrawerHint)h+=`<div class="hint-bar">${ic('drawer',16)} The cash drawer isn’t open, so cash won’t be counted against a float.<button class="btn btn-sm btn-ghost" data-act="nav" data-v="cash">Open the drawer</button><button class="btn btn-sm btn-ghost btn-icon" data-act="hideDrawerHint" aria-label="Dismiss">${ic('x',14)}</button></div>`;
  S.held.forEach(hd=>{const t=totalsFor(hd.cart.items,hd.cart.discount);h+=`<button class="held-chip" data-act="resume" data-id="${hd.id}" data-tip="Held by ${esc(first((emp(hd.by)||{}).name||''))} at ${fmtT(hd.ts)}">${ic('pause',14)} ${esc(hd.label)} <span class="num muted">${money(t.total)}</span></button>`;});
  return h;
}
function gridHTML(){
  const list=posProducts();
  if(!list.length){
    if(!S.products.length)return`<div class="empty" style="grid-column:1/-1"><div class="e-ic">${ic('box',26)}</div><h3>No items yet</h3><p>Add your first item to start selling.</p>${can('products')?`<button class="btn btn-primary" data-act="nav" data-v="items">Add items</button>`:''}</div>`;
    return`<div class="empty" style="grid-column:1/-1"><div class="e-ic">${ic('search',26)}</div><h3>Nothing matches “${esc(U.pos.q)}”</h3><p>Check the spelling, or scan the barcode again.</p></div>`;
  }
  return list.map(p=>{
    const c=catOf(p.cat)||{color:'#888'},q=inCartQty(p.id);
    const out=!p.available||(p.stock!=null&&p.stock<=0);
    const low=p.stock!=null&&p.stock>0&&p.stock<=(p.low??5);
    return`<button class="tile ${out?'off':''}" data-act="add" data-id="${p.id}" style="--c:${c.color}" ${out?'aria-disabled="true"':''} aria-label="${esc(p.name)}, ${money(p.price)}${q?`, ${q} in order`:''}">
      <span class="tile-em" aria-hidden="true">${p.emoji||'•'}</span>
      <span class="tile-name">${esc(p.name)}</span>
      <span class="tile-price num">${money(p.price)}${low?`<span class="tile-stock">${p.stock} left</span>`:''}</span>
      ${q&&!out?`<span class="tile-q num">${q}</span>`:''}
    </button>`;}).join('');
}
function cartHTML(){
  const c=U.cart,t=cartTotals(),cu=c.custId?cust(c.custId):null,o=c.orderId?orderOf(c.orderId):null,tb=c.table?tableOf(c.table):null;
  const hosp=hospitality(),L=S.settings.loyalty;
  const canRedeem=cu&&L.on&&cu.points>=L.redeemPts&&!(c.discount&&c.discount.pts);
  const lines=c.items.map(lineHTML).join('');
  return`<div class="tape-head">
    <div class="th-row"><div class="th-title"><b>${o?'Order '+o.no:'New order'}</b><span>${typeLabel(c.type)}${tb?`, table ${esc(tb.name)}`:''}${c.items.length?`, ${t.count} item${t.count===1?'':'s'}`:''}</span></div>
    <button class="btn btn-ghost btn-icon mob-only" data-act="mobCart" aria-label="Close order">${ic('chevD')}</button>
    <button class="btn btn-sm btn-ghost btn-icon" data-act="cartMenu" aria-label="Order options">${ic('more')}</button></div>
    ${cu?`<div class="cust-chip"><span class="av" style="--c:#7A5AC8">${initials(cu.name)}</span><div class="cc-t"><b>${esc(cu.name)}</b><small>${tierOf(cu).name}, ${cu.points} points</small></div>${canRedeem?`<button class="btn btn-sm" data-act="redeem" data-tip="Use ${L.redeemPts} points for ${money(L.redeemVal)} off">Use points</button>`:''}<button class="btn btn-sm btn-ghost btn-icon" data-act="rmCust" aria-label="Remove customer">${ic('x',16)}</button></div>`
      :`<button class="btn btn-sm" data-act="pickCust" style="justify-self:start">${ic('user',16)} Add a customer</button>`}
   </div>
   <div class="tape-scroll" id="tapeScroll"><div class="paper">
    <div class="p-h"><b>${esc(S.settings.name)}</b><span class="pm">${fmtDT(Date.now())}</span></div><div class="rule"></div>
    ${c.items.length?lines:`<div class="paper-empty"><b>Tap an item to start</b><p>Press <b>/</b> to search, <b>F2</b> to charge</p></div>`}
    ${c.note?`<div class="rule"></div><div class="pm">Note: ${esc(c.note)}</div>`:''}
   </div></div>
   <div class="tape-foot">
    <div class="tots">
     <div class="tot-row"><span>Subtotal</span><span class="num">${money(t.subtotal)}</span></div>
     ${t.disc?`<div class="tot-row disc"><span>${esc(c.discount.reason)} ${c.discount.kind==='pct'?c.discount.value+'%':''} <button class="linkx" data-act="rmDisc">Remove</button></span><span class="num">−${money(t.disc)}</span></div>`:''}
     <div class="tot-row"><span>${esc(S.settings.taxName)} ${S.settings.taxRate}%${S.settings.taxInclusive?' included':''}</span><span class="num">${money(t.tax)}</span></div>
     <div class="tot-big"><span>Total</span><span class="num">${money(t.total)}</span></div>
    </div>
    <div class="tape-acts">
     <button class="btn ${c.discount?'on':''}" data-act="discount" ${c.items.length?'':'disabled'}>${ic('tag',16)}Discount</button>
     <button class="btn ${c.note?'on':''}" data-act="orderNote">${ic('note',16)}Note</button>
     <button class="btn" data-act="hold" ${c.items.length&&!c.orderId?'':'disabled'}>${ic('pause',16)}Hold</button>
     <button class="btn" data-act="clearCart" ${c.items.length||c.orderId?'':'disabled'}>${ic('trash',16)}${c.orderId?'Close':'Clear'}</button>
    </div>
    <div class="charge-row">
     ${hosp&&S.settings.kitchen&&c.type==='dine'?`<button class="btn send-k" data-act="sendKitchen" ${c.items.some(l=>!l.sent)?'':'disabled'}>${ic('send',18)}Send</button>`:''}
     <button class="btn btn-primary charge" data-act="charge" ${c.items.length?'':'disabled'}><span>Charge</span><span class="num">${money(t.total)}</span></button>
    </div>
   </div>`;
}
function lineHTML(l){
  const sel=U.selLine===l.uid,p=prod(l.pid);
  return`<div class="pl ${sel?'sel':''} ${l.uid===U.newLine?'new':''}" data-act="lineSel" data-id="${l.uid}" role="button" tabindex="0" aria-expanded="${sel}">
    <span class="q num">${l.qty}×</span><span class="n">${esc(l.name)}${l.sent?'<i class="sent-tag">sent</i>':''}</span><span class="num">${money(lineTotal(l))}</span>
    ${l.mods.length?`<span class="m">${l.mods.map(m=>esc(m.n)+(m.p?' +'+money(m.p):'')).join(', ')}</span>`:''}
    ${l.note?`<span class="m note">“${esc(l.note)}”</span>`:''}
    ${sel?`<div class="pl-ctrl" data-stop>
      <button class="qb" data-act="lineQty" data-id="${l.uid}" data-d="-1" aria-label="One fewer">${ic('minus',16)}</button><b class="num">${l.qty}</b><button class="qb" data-act="lineQty" data-id="${l.uid}" data-d="1" aria-label="One more">${ic('plus',16)}</button>
      <span class="spacer"></span>
      ${p&&p.mods&&p.mods.length?`<button class="btn btn-sm" data-act="lineEdit" data-id="${l.uid}">Options</button>`:''}
      <button class="btn btn-sm" data-act="lineNote" data-id="${l.uid}">Note</button>
      <button class="btn btn-sm btn-icon" data-act="lineDel" data-id="${l.uid}" aria-label="Remove ${esc(l.name)}">${ic('trash',16)}</button></div>`:''}
  </div>`;
}
function refreshPos(opts={}){
  if(U.view!=='pos')return;
  const c=$('#cart');if(c){const st=$('#tapeScroll');const top=st?st.scrollTop:0;c.innerHTML=cartHTML();const ns=$('#tapeScroll');if(ns){if(opts.scrollEnd)ns.scrollTop=ns.scrollHeight;else ns.scrollTop=top;}}
  if(opts.grid!==false){const g=$('#posGrid');if(g){const s=g.scrollTop;g.innerHTML=gridHTML();g.scrollTop=s;}}
  const sp=$('#posStrip');if(sp)sp.innerHTML=posStripHTML();
  const mb=$('#mobBar');if(mb){mb.innerHTML=mobBarHTML();mb.hidden=!U.cart.items.length;}
  U.newLine=null;
}
function addProduct(pid){
  const p=prod(pid);if(!p)return;
  if(!p.available){toast(`${p.name} is marked sold out`,'warn');return;}
  if(p.stock!=null&&p.stock-inCartQty(pid)<=0){toast(`No ${p.name} left in stock`,'warn');return;}
  if(p.mods&&p.mods.length){openMods(p);return;}
  addLine(p,[],1,'');
}
function addLine(p,mods,qty,note){
  const key=p.id+'|'+mods.map(m=>m.n).join(',');
  const ex=U.cart.items.find(l=>l.key===key&&!l.sent&&!l.note&&!note);
  if(ex){ex.qty+=qty;U.newLine=null;}
  else{const l={key,pid:p.id,name:p.name,price:p.price,cost:p.cost,qty,mods,note:note||'',uid:uid('l'),sent:false};U.cart.items.push(l);U.newLine=l.uid;}
  U.selLine=null;
  refreshPos({scrollEnd:true});
  const tile=$(`.tile[data-id="${p.id}"]`);if(tile){tile.classList.remove('bump');void tile.offsetWidth;tile.classList.add('bump');}
}
A.posCat=d=>{U.pos.cat=d.id;U.pos.q='';const i=$('#posQ');if(i)i.value='';$$('.cat-btn').forEach(b=>b.classList.toggle('on',b.dataset.id===d.id));$('#posGrid').innerHTML=gridHTML();$('#posGrid').scrollTop=0;};
IN.posQ=v=>{U.pos.q=v;$('#posGrid').innerHTML=gridHTML();};
A.add=d=>addProduct(d.id);
A.setType=async d=>{
  if(d.t==='dine'&&!U.cart.table&&S.settings.tables){const t=await pickTable();if(!t)return;U.cart.table=t;}
  U.cart.type=d.t;if(d.t!=='dine'&&!U.cart.orderId)U.cart.table=null;
  $$('.pos-tools .seg button').forEach(b=>b.classList.toggle('on',b.dataset.t===d.t));
  refreshPos({grid:false});
};
A.lineSel=d=>{U.selLine=U.selLine===d.id?null:d.id;refreshPos({grid:false});};
A.lineQty=async d=>{
  const l=U.cart.items.find(x=>x.uid===d.id);if(!l)return;
  const n=l.qty+(+d.d);
  if(+d.d>0){const p=prod(l.pid);if(p&&p.stock!=null&&p.stock-inCartQty(p.id)<=0){toast(`No more ${p.name} in stock`,'warn');return;}}
  if(l.sent&&+d.d<0){const ok=await approve('refunds','Taking back an item the kitchen already has');if(!ok)return;}
  if(n<=0){U.cart.items=U.cart.items.filter(x=>x!==l);U.selLine=null;}else l.qty=n;
  refreshPos();
};
A.lineDel=async d=>{
  const l=U.cart.items.find(x=>x.uid===d.id);if(!l)return;
  if(l.sent){const ok=await approve('refunds','Removing an item the kitchen already has');if(!ok)return;}
  U.cart.items=U.cart.items.filter(x=>x!==l);U.selLine=null;refreshPos();
  toast(`Removed ${l.name}`,'',{action:'Undo',onAction:()=>{U.cart.items.push(l);refreshPos();}});
};
A.lineNote=async d=>{const l=U.cart.items.find(x=>x.uid===d.id);if(!l)return;const v=await promptBox({title:'Note for the kitchen',label:l.name,value:l.note,placeholder:'For example, no onions',ok:'Save note'});if(v===null)return;l.note=v.trim();refreshPos({grid:false});};
A.lineEdit=d=>{const l=U.cart.items.find(x=>x.uid===d.id);const p=l&&prod(l.pid);if(p)openMods(p,l);};
A.orderNote=async()=>{const v=await promptBox({title:'Order note',label:'Shown on the receipt and kitchen ticket',value:U.cart.note,placeholder:'For example, birthday, bring candles',ok:'Save note'});if(v===null)return;U.cart.note=v.trim();refreshPos({grid:false});};
A.mobCart=()=>{U.mobCart=!U.mobCart;$('#pos').classList.toggle('cart-open',U.mobCart);};
A.hideDrawerHint=()=>{U.hideDrawerHint=true;refreshPos({grid:false});};
A.rmDisc=()=>{U.cart.discount=null;refreshPos({grid:false});};
A.rmCust=()=>{U.cart.custId=null;if(U.cart.discount&&U.cart.discount.pts)U.cart.discount=null;refreshPos({grid:false});};
A.redeem=()=>{const L=S.settings.loyalty;U.cart.discount={kind:'amt',value:L.redeemVal,reason:'Loyalty reward',pts:L.redeemPts};refreshPos({grid:false});toast(`${money(L.redeemVal)} reward applied`);};
A.clearCart=async()=>{
  if(U.cart.orderId){U.cart=newCart();U.selLine=null;refreshPos();toast('Order closed. It’s still open on its table.');return;}
  if(!U.cart.items.length)return;
  const saved=clone(U.cart);U.cart=newCart();U.selLine=null;refreshPos();
  toast('Order cleared','',{action:'Undo',onAction:()=>{U.cart=saved;refreshPos();}});
};
A.hold=()=>{
  const c=U.cart;if(!c.items.length)return;
  const cu=c.custId?cust(c.custId):null,tb=c.table?tableOf(c.table):null;
  S.held.push({id:uid('h'),ts:Date.now(),by:U.user,label:cu?first(cu.name):tb?'Table '+tb.name:'Held '+fmtT(Date.now()),cart:clone(c)});
  U.cart=newCart();U.selLine=null;save();refreshPos();toast('Order held. Tap it above the menu to pick it up again.');
};
A.resume=d=>{
  const h=S.held.find(x=>x.id===d.id);if(!h)return;
  if(U.cart.items.length&&!U.cart.orderId){const cu=U.cart.custId?cust(U.cart.custId):null;S.held.push({id:uid('h'),ts:Date.now(),by:U.user,label:cu?first(cu.name):'Held '+fmtT(Date.now()),cart:clone(U.cart)});toast('Your current order was held so you can pick up this one');}
  S.held=S.held.filter(x=>x!==h);U.cart=h.cart;U.selLine=null;save();
  if(U.view!=='pos')go('pos');else{renderView();}
};
A.cartMenu=(d,el)=>{
  const c=U.cart,hosp=hospitality();
  popover(el,`<div class="pop-h">This order</div>
   <button class="pop-i" data-act="orderNote">${ic('note',18)} Add a note</button>
   ${hosp&&S.settings.tables?`<button class="pop-i" data-act="changeTable">${ic('tables',18)} ${c.table?'Move to another table':'Seat at a table'}</button>`:''}
   <button class="pop-i" data-act="pickCust">${ic('user',18)} ${c.custId?'Change customer':'Add a customer'}</button>
   ${c.items.length&&!c.orderId?`<button class="pop-i" data-act="hold">${ic('pause',18)} Hold for later</button>`:''}
   ${c.orderId?`<div class="pop-sep"></div><button class="pop-i danger" data-act="voidOpen">${ic('ban',18)} Void this table’s order</button>`:''}`);
};
A.changeTable=async()=>{const t=await pickTable(U.cart.table);if(!t)return;U.cart.table=t;U.cart.type='dine';if(U.cart.orderId){const o=orderOf(U.cart.orderId);if(o){o.table=t;save();}}renderView();toast(`Moved to table ${tableOf(t).name}`);};
A.voidOpen=async()=>{
  const o=orderOf(U.cart.orderId);if(!o)return;
  const ok=await approve('refunds','Voiding an open order');if(!ok)return;
  if(!await confirmBox({title:`Void order ${o.no}?`,text:'The table becomes free and the order is kept in history as voided. Nothing is charged.',ok:'Void order',danger:true}))return;
  o.status='void';o.refund={ts:Date.now(),by:ok.id,reason:'Voided at table',restock:false};
  S.tickets.forEach(t=>{if(t.orderId===o.id&&t.status!=='done'){t.status='done';t.doneTs=Date.now();}});
  U.cart=newCart();save();renderView();renderRail();toast(`Order ${o.no} voided`);
};
function pickTable(current){
  return new Promise(res=>{let done=false;
    const busy=new Set(S.orders.filter(o=>o.status==='open').map(o=>o.table));
    const L=modal({title:'Choose a table',cls:'wide',body:`<div class="chips" style="gap:10px">${S.tables.map(t=>{const b=busy.has(t.id)&&t.id!==current;return`<button class="opt-chip ${t.id===current?'on':''}" data-tb="${t.id}" ${b?'disabled style="opacity:.4"':''}>${esc(t.name)} <small>${t.seats} seats${b?', taken':''}</small></button>`;}).join('')}</div>`,onClose:()=>{if(!done)res(null);}});
    L.el.addEventListener('click',e=>{const b=e.target.closest('[data-tb]');if(b&&!b.disabled){done=true;L.close();res(b.dataset.tb);}});
  });
}

/* ---------- Modifier sheet ---------- */
let MOD=null;
function openMods(p,line){
  const groups=p.mods.map(id=>S.modGroups.find(g=>g.id===id)).filter(Boolean);
  MOD={p,line,groups,qty:line?line.qty:1,note:line?line.note:'',sel:{}};
  groups.forEach(g=>{const cur=line?line.mods.filter(m=>m.g===g.id).map(m=>m.n):[];MOD.sel[g.id]=cur.length?cur:(g.req&&!g.multi?[g.opts[0][0]]:[]);});
  const c=catOf(p.cat)||{color:'#888'};
  MOD.L=modal({title:esc(p.name),cls:'wide',body:`<div class="prod-head"><span class="it-em" style="--c:${c.color}">${p.emoji}</span><div><p class="muted">${esc(p.desc||'')}</p>${p.allergens&&p.allergens.length?`<div class="allergens">${p.allergens.map(a=>`<span class="badge warn">${esc(a)}</span>`).join('')}</div>`:''}</div></div><div id="modGroups"></div><label class="field" style="margin-top:6px"><span>Note for the kitchen</span><input class="input" id="modNote" value="${esc(MOD.note)}" placeholder="Optional"></label>`,foot:`<div class="stepper"><button data-act="modQty" data-d="-1" aria-label="Fewer">${ic('minus',18)}</button><b class="num" id="modQ">${MOD.qty}</b><button data-act="modQty" data-d="1" aria-label="More">${ic('plus',18)}</button></div><span class="spacer"></span><button class="btn btn-primary btn-lg" data-act="modAdd" id="modAddBtn"></button>`});
  renderMods();
}
const isStd=(g,n)=>g.std&&!g.multi&&g.opts[0]&&g.opts[0][0]===n;
function modMods(){const out=[];MOD.groups.forEach(g=>(MOD.sel[g.id]||[]).forEach(n=>{const o=g.opts.find(x=>x[0]===n);if(o&&!isStd(g,n))out.push({g:g.id,n,p:o[1]});}));return out;}
function renderMods(){
  $('#modGroups').innerHTML=MOD.groups.map(g=>`<div class="mod-group"><h4>${esc(g.name)} ${g.req?'<span class="badge">Required</span>':g.multi?'<span class="badge">Choose any</span>':'<span class="badge">Optional</span>'}</h4><div class="chips">${g.opts.map(([n,pr])=>{const on=(MOD.sel[g.id]||[]).includes(n);return`<button class="opt-chip ${on?'on':''}" data-act="modOpt" data-g="${g.id}" data-n="${esc(n)}" aria-pressed="${on}">${esc(n)}${pr?` <small>+${money(pr)}</small>`:''}</button>`;}).join('')}</div></div>`).join('');
  const unit=r2(MOD.p.price+sum(modMods(),m=>m.p));
  $('#modQ').textContent=MOD.qty;
  $('#modAddBtn').innerHTML=`${MOD.line?'Update':'Add to order'} <span class="num">${money(unit*MOD.qty)}</span>`;
}
A.modOpt=d=>{
  const g=MOD.groups.find(x=>x.id===d.g);let s=MOD.sel[d.g]||[];
  if(g.multi)s=s.includes(d.n)?s.filter(x=>x!==d.n):[...s,d.n];
  else s=s.includes(d.n)&&!g.req?[]:[d.n];
  MOD.sel[d.g]=s;renderMods();
};
A.modQty=d=>{MOD.qty=clamp(MOD.qty+(+d.d),1,99);renderMods();};
A.modAdd=()=>{
  const miss=MOD.groups.find(g=>g.req&&!(MOD.sel[g.id]||[]).length);
  if(miss){toast(`Choose ${miss.name.toLowerCase()} first`,'warn');return;}
  const mods=modMods(),note=($('#modNote')||{}).value||'';
  const p=MOD.p;
  if(p.stock!=null){const avail=p.stock-inCartQty(p.id)+(MOD.line?MOD.line.qty:0);if(MOD.qty>avail){toast(`Only ${avail} ${p.name} left in stock`,'warn');return;}}
  if(MOD.line){Object.assign(MOD.line,{mods,qty:MOD.qty,note:note.trim(),key:p.id+'|'+mods.map(m=>m.n).join(',')});MOD.L.close();refreshPos();}
  else{MOD.L.close();addLine(p,mods,MOD.qty,note.trim());}
};

/* ---------- Customer picker ---------- */
function custResultsHTML(q){
  q=(q||'').toLowerCase().trim();
  const list=S.customers.filter(c=>!q||c.name.toLowerCase().includes(q)||c.phone.includes(q)||(c.email||'').toLowerCase().includes(q)).sort((a,b)=>(b.last||0)-(a.last||0)).slice(0,8);
  if(!list.length)return`<p class="muted" style="padding:10px">No one matches. Add them as a new customer below.</p>`;
  return list.map(c=>`<button class="cust-opt" data-act="attachCust" data-id="${c.id}"><span class="av" style="--c:#7A5AC8">${initials(c.name)}</span><span class="co-t"><b>${esc(c.name)}</b><small>${esc(c.phone)}, ${c.points} points</small></span>${tierBadge(c)}</button>`).join('');
}
A.pickCust=()=>{modal({title:'Add a customer to this order',body:`<label class="search">${ic('search',18)}<input data-in="custQ" placeholder="Name, phone or email" autocomplete="off" autofocus></label><div class="cust-res" id="custRes">${custResultsHTML('')}</div>`,foot:`<button class="btn" data-act="newCustFromPos">${ic('plus',16)} New customer</button>`});};
IN.custQ=v=>{$('#custRes').innerHTML=custResultsHTML(v);};
A.attachCust=d=>{U.cart.custId=d.id;closeTop();refreshPos({grid:false});const c=cust(d.id);toast(`${first(c.name)} added, ${c.points} points`);};
A.newCustFromPos=()=>{closeTop();editCustomer(null,c=>{U.cart.custId=c.id;refreshPos({grid:false});});};

/* ---------- Discounts ---------- */
let DSC=null;
A.discount=()=>{
  DSC={kind:'pct',value:10,reason:'Regular'};
  DSC.L=modal({title:'Discount this order',body:`<div id="dscBody"></div>`,foot:`<button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" data-act="applyDisc">Apply discount</button>`});
  renderDisc();
};
function renderDisc(){
  const t=cartTotals({...U.cart,discount:DSC});
  $('#dscBody').innerHTML=`<div class="field"><span>Quick picks</span><div class="chips">${[[5,'Regular'],[10,'Regular'],[15,'Promotion'],[20,'Promotion'],[50,'Staff']].map(([v,r])=>`<button class="chip ${DSC.kind==='pct'&&DSC.value===v?'on':''}" data-act="dscPick" data-v="${v}" data-r="${r}">${v}%${r==='Staff'?' staff':''}</button>`).join('')}</div></div>
   <div class="fgrid mt"><div class="field"><span>Type</span><div class="seg"><button class="${DSC.kind==='pct'?'on':''}" data-act="dscKind" data-k="pct">Percent</button><button class="${DSC.kind==='amt'?'on':''}" data-act="dscKind" data-k="amt">Amount</button></div></div>
   <label class="field"><span>${DSC.kind==='pct'?'Percent off':'Amount off'}</span><input class="input num" type="number" min="0" step="${DSC.kind==='pct'?1:0.5}" data-in="dscVal" value="${DSC.value}"></label></div>
   <div class="field mt"><span>Reason</span><div class="chips">${['Regular','Staff','Promotion','Service recovery','Other'].map(r=>`<button class="chip ${DSC.reason===r?'on':''}" data-act="dscReason" data-r="${r}">${r}</button>`).join('')}</div></div>
   <div class="change-line mt" id="dscPrev"><span>New total</span><span class="num">${money(t.total)} (saves ${money(t.disc)})</span></div>
   ${needsDiscApproval()?`<p class="hint mt">${ic('lock',14)} A manager will need to approve this discount.</p>`:''}`;
}
function needsDiscApproval(){if(!can('discounts'))return true;const e=me();return e.role==='staff'&&DSC.kind==='pct'&&DSC.value>20;}
A.dscPick=d=>{DSC.kind='pct';DSC.value=+d.v;DSC.reason=d.r;renderDisc();};
A.dscKind=d=>{DSC.kind=d.k;DSC.value=d.k==='pct'?10:2;renderDisc();};
A.dscReason=d=>{DSC.reason=d.r;renderDisc();};
IN.dscVal=v=>{DSC.value=Math.max(0,+v||0);if(DSC.kind==='pct')DSC.value=Math.min(100,DSC.value);const t=cartTotals({...U.cart,discount:DSC});$('#dscPrev').innerHTML=`<span>New total</span><span class="num">${money(t.total)} (saves ${money(t.disc)})</span>`;};
A.applyDisc=async()=>{
  if(!DSC.value){toast('Enter a discount above zero','warn');return;}
  let by=me();
  if(needsDiscApproval()){by=await approve(me().role==='staff'&&can('discounts')?'refunds':'discounts',`A ${DSC.kind==='pct'?DSC.value+'%':money(DSC.value)} discount`);if(!by)return;}
  U.cart.discount={kind:DSC.kind,value:DSC.value,reason:DSC.reason,by:by.id};
  DSC.L.close();refreshPos({grid:false});toast('Discount applied');
};

/* ---------- Kitchen send ---------- */
function addTicket(o,lines){
  S.tickets.push({id:uid('k'),orderId:o.id,no:o.no,ts:Date.now(),status:'new',type:o.type,table:o.table,source:o.source,cust:o.custId?first((cust(o.custId)||{}).name):null,note:o.note||'',
    items:lines.map(l=>({name:l.name,qty:l.qty,mods:(l.mods||[]).map(m=>m.n),note:l.note||'',done:false})),doneTs:null});
}
function writeOrderFromCart(o,c){
  const t=cartTotals(c);
  Object.assign(o,{items:clone(c.items),type:c.type,table:c.table,custId:c.custId,discount:c.discount,discAmt:t.disc,subtotal:t.subtotal,tax:t.tax,total:t.total,note:c.note});
}
A.sendKitchen=async()=>{
  const c=U.cart;if(!c.items.length)return;
  if(c.type==='dine'&&!c.table&&S.settings.tables){const t=await pickTable();if(!t)return;c.table=t;}
  const unsent=c.items.filter(l=>!l.sent);
  if(!unsent.length){toast('The kitchen already has everything on this order');return;}
  // Send to the kitchen through Plemmo so the order is an authoritative sale on
  // the real KDS. On failure, save locally so the kitchen still gets it.
  if(window.PlemmoOrders&&PlemmoAPI.isAuthenticated()){
    try{ await sendKitchenPlemmo(c,unsent); return; }
    catch(e){ toast('Could not reach Plemmo — order saved locally','warn'); }
  }
  let o=c.orderId?orderOf(c.orderId):null;
  if(!o){o={id:uid('o'),no:S.seq++,ts:Date.now(),opened:Date.now(),empId:U.user,source:'pos',status:'open',tip:0,payments:[],pts:0};S.orders.push(o);}
  writeOrderFromCart(o,c);
  addTicket(o,unsent);
  unsent.forEach(l=>l.sent=true);
  o.items=clone(c.items);
  const tb=c.table?tableOf(c.table):null;
  U.cart=newCart();U.selLine=null;save();refreshPos();renderRail();
  toast(`Sent to the kitchen${tb?' for table '+tb.name:''}`,'',{action:'View table',onAction:()=>go('tables')});
};
async function sendKitchenPlemmo(c,unsent){
  let o=c.orderId?orderOf(c.orderId):null;
  if(o&&o.plemmoOrderId){
    // Append the new items to the existing authoritative order.
    const items=unsent.map(l=>PlemmoOrders.cartLineToItem(l,S._plemmoAddons));
    await PlemmoAPI.post('/orders/'+encodeURIComponent(o.plemmoOrderId)+'/items',{items:items},{idempotent:true});
  }else{
    const order=await PlemmoOrders.createOrder({type:c.type,table:c.table,customerId:c.custId,items:unsent},S._plemmoAddons);
    o={id:uid('o'),no:order.order_number||order.id,plemmoOrderId:order.id,ts:Date.now(),opened:Date.now(),empId:U.user,source:'pos',status:'open',tip:0,payments:[],pts:0,
       subtotal:Number(order.subtotal)||0,tax:Number(order.tax_amount)||0,total:Number(order.total)||0};
    S.orders.push(o);
  }
  writeOrderFromCart(o,c);
  addTicket(o,unsent);
  unsent.forEach(l=>l.sent=true);
  o.items=clone(c.items);
  const tb=c.table?tableOf(c.table):null;
  U.cart=newCart();U.selLine=null;save();refreshPos();renderRail();
  toast(`Sent to the kitchen${tb?' for table '+tb.name:''}`,'',{action:'View table',onAction:()=>go('tables')});
}
function loadOrderToCart(o){
  U.cart={items:clone(o.items).map(l=>({...l,sent:true,uid:l.uid||uid('l')})),type:o.type,table:o.table,custId:o.custId,discount:o.discount,orderId:o.id,note:o.note||''};
  U.selLine=null;
}

/* ---------- Payment ---------- */
let PAY=null;
A.charge=()=>{
  if(!U.cart.items.length){toast('Add an item first','warn');return;}
  const t=cartTotals();
  PAY={due:t.total,tip:0,tipPct:0,method:'card',tendered:'',splitAmt:'',payments:[],stage:'idle'};
  PAY.L=modal({title:'Take payment',cls:'xl',body:`<div id="payBody"></div>`,dismiss:false,onClose:()=>{if(PAY&&PAY.payments.length&&!PAY.done)toast('Payment cancelled. Money already taken is shown on the order when you charge again.','warn');}});
  renderPay();
};
function payRem(){return r2(PAY.due+PAY.tip-sum(PAY.payments,p=>p.a));}
function cashSuggest(rem){const c=[rem,Math.ceil(rem),Math.ceil(rem/5)*5,Math.ceil(rem/10)*10,Math.ceil(rem/20)*20,50];return[...new Set(c.map(r2))].filter(v=>v>=rem).slice(0,4);}
function renderPay(){
  const rem=payRem(),paidAny=PAY.payments.length>0,tips=S.settings.tipping;
  const tipBtns=[0,10,12.5,15].map(p=>`<button class="chip ${PAY.tipPct===p&&!PAY.tipCustom?'on':''}" data-act="payTip" data-p="${p}" ${paidAny?'disabled':''}>${p?p+'%':'No tip'}</button>`).join('')+`<button class="chip ${PAY.tipCustom?'on':''}" data-act="payTipCustom" ${paidAny?'disabled':''}>Other</button>`;
  let pane='';
  if(PAY.method==='card'){
    const amt=PAY.splitMode&&+PAY.splitAmt?Math.min(+PAY.splitAmt,rem):rem;
    pane=`<div class="reader ${PAY.stage}">${PAY.stage==='ok'?`<div class="rd-ic">${ic('check',32)}</div><b>Approved</b><small>Visa ending 4417</small>`:PAY.stage==='wait'?`<div class="rd-ic">${ic('contactless',32)}</div><b>${money(amt)}</b><small>Ask the customer to tap, insert or swipe</small>`:`<div class="rd-ic">${ic('card',30)}</div><b>Card reader ready</b><small>Connected, battery 82%</small>`}</div>
      <button class="btn btn-primary btn-lg btn-block" data-act="payCard" ${PAY.stage!=='idle'?'disabled':''}>${PAY.stage==='idle'?`Send ${money(amt)} to the reader`:PAY.stage==='wait'?'Waiting for the card…':'Approved'}</button>`;
  }else if(PAY.method==='cash'){
    const ten=+PAY.tendered||0,ch=r2(ten-rem);
    pane=`<div class="tender num" aria-live="polite">${PAY.tendered?S.settings.currency+PAY.tendered:`<span class="faint">${money(rem)}</span>`}</div>
      <div class="quick-notes">${cashSuggest(rem).map(v=>`<button class="btn" data-act="payNote" data-v="${v}">${v===rem?'Exact':money(v,v%1?2:0)}</button>`).join('')}</div>
      ${keypadHTML('money','wide')}
      ${PAY.tendered?`<div class="change-line ${ch<0?'short':''}"><span>${ch<0?'Still to pay':'Change to give'}</span><span class="num">${money(Math.abs(ch))}</span></div>`:''}
      <button class="btn btn-primary btn-lg btn-block" data-act="payCash">${ten>0&&ten<rem?`Take ${money(ten)} in cash`:'Take cash'}</button>`;
  }else{
    const n=+PAY.splitAmt||0;
    pane=`<p class="muted">Take part of the bill now and the rest another way. Pick a share or type an amount.</p>
      <div class="chips">${[2,3,4].map(k=>`<button class="chip" data-act="paySplitEven" data-n="${k}">Split ${k} ways</button>`).join('')}<button class="chip" data-act="paySplitRest">The rest</button></div>
      <div class="tender num">${PAY.splitAmt?S.settings.currency+PAY.splitAmt:`<span class="faint">${S.settings.currency}0.00</span>`}</div>
      ${keypadHTML('money','wide')}
      <div class="fgrid"><button class="btn btn-lg" data-act="paySplitCard" ${n>0?'':'disabled'}>${ic('card',18)} Card</button><button class="btn btn-lg" data-act="paySplitCash" ${n>0?'':'disabled'}>${ic('cash',18)} Cash</button></div>`;
  }
  $('#payBody').innerHTML=`<div class="pay">
   <div class="pay-sum">
    <div><span class="muted" style="font-weight:600">${paidAny?'Left to pay':'Amount due'}</span><div class="pay-big num">${money(rem)}</div><p class="pay-sub">Order ${money(PAY.due)}${PAY.tip?`, tip ${money(PAY.tip)}`:''}${U.cart.custId?`, ${esc(first(cust(U.cart.custId).name))} earns ${Math.floor(PAY.due*S.settings.loyalty.earn)} points`:''}</p></div>
    ${tips?`<div class="field"><span>Tip</span><div class="chips">${tipBtns}</div></div>`:''}
    ${paidAny?`<div class="pay-taken">${PAY.payments.map(p=>`<div><span>${p.m==='cash'?'Cash':'Card'}</span><span class="num">${money(p.a)}</span></div>`).join('')}</div>`:''}
    <div class="spacer"></div>
    <button class="btn btn-ghost" data-act="payCancel" ${PAY.stage==='wait'?'disabled':''}>${paidAny?'Cancel remaining payment':'Back to the order'}</button>
   </div>
   <div class="pay-pane">
    <div class="seg">${[['card','Card','card'],['cash','Cash','cash'],['split','Split','split']].map(([k,l,i])=>`<button class="${PAY.method===k?'on':''}" data-act="payMethod" data-m="${k}" ${PAY.stage!=='idle'?'disabled':''}>${ic(i,16)}${l}</button>`).join('')}</div>
    ${pane}
   </div></div>`;
  if(PAY.method!=='card')bindPad($('#payBody'),payKey);
}
function payKey(k){
  const f=PAY.method==='cash'?'tendered':'splitAmt';let v=PAY[f];
  if(k==='back')v=v.slice(0,-1);
  else if(k==='.'){if(!v.includes('.'))v=(v||'0')+'.';}
  else if(/^\d$/.test(k)){if(v.includes('.')&&v.split('.')[1].length>=2)return;if(v.replace('.','').length>=7)return;v=v==='0'?k:v+k;}
  PAY[f]=v;renderPay();
}
A.payMethod=d=>{PAY.method=d.m;PAY.splitMode=d.m==='split';if(d.m!=='split')PAY.splitAmt='';renderPay();};
A.payTip=d=>{PAY.tipPct=+d.p;PAY.tipCustom=false;PAY.tip=r2(PAY.due*PAY.tipPct/100);renderPay();};
A.payTipCustom=async()=>{const v=await promptBox({title:'Add a tip',label:'Tip amount',value:PAY.tip||'',type:'number',ok:'Add tip'});if(v===null)return;PAY.tip=Math.max(0,r2(+v||0));PAY.tipCustom=true;PAY.tipPct=-1;renderPay();};
A.payNote=d=>{PAY.tendered=String(d.v);renderPay();};
A.paySplitEven=d=>{PAY.splitAmt=String(r2(Math.ceil((PAY.due+PAY.tip)/+d.n*100)/100));const rem=payRem();if(+PAY.splitAmt>rem)PAY.splitAmt=String(rem);renderPay();};
A.paySplitRest=()=>{PAY.splitAmt=String(payRem());renderPay();};
A.payCancel=()=>{PAY.L.close();};
async function cardFlow(amount){
  PAY.stage='wait';renderPay();
  await sleep(1700);
  if(!PAY||PAY.L.closed)return false;
  PAY.stage='ok';renderPay();
  await sleep(650);
  if(!PAY||PAY.L.closed)return false;
  PAY.payments.push({m:'card',a:r2(amount)});PAY.stage='idle';
  return true;
}
A.payCard=async()=>{
  const rem=payRem(),amt=PAY.splitMode&&+PAY.splitAmt?Math.min(+PAY.splitAmt,rem):rem;
  if(!(await cardFlow(amt)))return;
  PAY.splitAmt='';afterPayment();
};
A.payCash=()=>{
  const rem=payRem(),ten=PAY.tendered?+PAY.tendered:rem;
  if(ten<=0){toast('Enter the cash you were given','warn');return;}
  const take=Math.min(ten,rem);PAY.payments.push({m:'cash',a:r2(take)});
  PAY.change=r2(Math.max(0,ten-rem));PAY.tendered='';
  if(S.drawer.open)toast('Cash drawer opened','info',{ms:1600});
  afterPayment();
};
A.paySplitCard=async()=>{const rem=payRem(),amt=Math.min(+PAY.splitAmt||0,rem);if(!amt)return;PAY.method='card';if(!(await cardFlow(amt)))return;PAY.method='split';PAY.splitAmt='';afterPayment();};
A.paySplitCash=()=>{const rem=payRem(),amt=Math.min(+PAY.splitAmt||0,rem);if(!amt)return;PAY.payments.push({m:'cash',a:r2(amt)});PAY.splitAmt='';if(S.drawer.open)toast('Cash drawer opened','info',{ms:1600});afterPayment();};
function afterPayment(){if(payRem()<=0.004)finishSale();else renderPay();}
// Plemmo is authoritative for prices/tax/totals/stock/loyalty. A fresh counter
// sale commits to Plemmo (order → bill → payments incl. tip). Dine-in orders
// already opened locally, and the offline/un-authenticated case, use the local
// flow. On a Plemmo commit failure the pay modal stays open so staff can retry
// (the idempotency key makes retries safe — no double charge).
function finishSale(){
  const c=U.cart;
  const existing=c.orderId?orderOf(c.orderId):null;
  // Use the authoritative path for a fresh sale, or a dine-in order already
  // opened in Plemmo. A local-only order (Plemmo unreachable at send) pays local.
  const usePlemmo=window.PlemmoOrders&&window.PlemmoPayments&&PlemmoAPI.isAuthenticated()&&(!c.orderId||(existing&&existing.plemmoOrderId));
  if(usePlemmo){finishSalePlemmo().catch((e)=>{
    const msg=(e&&e.status===403)?'You don’t have permission to take payment':'Could not record the sale on Plemmo — money not confirmed. Try again.';
    toast(msg,'warn');
    if(PAY){PAY.stage='idle';renderPay();}
  });return;}
  finishSaleLocal();
}
async function finishSalePlemmo(){
  const c=U.cart;
  const existing=c.orderId?orderOf(c.orderId):null;
  // 1. Authoritative order — reuse a dine-in order already opened in Plemmo,
  // else create one now (Plemmo computes totals + deducts stock).
  let plemmoOrderId,orderResp=null;
  if(existing&&existing.plemmoOrderId){plemmoOrderId=existing.plemmoOrderId;}
  else{orderResp=await PlemmoOrders.createOrder({type:c.type,table:c.table,customerId:c.custId,items:c.items},S._plemmoAddons);plemmoOrderId=orderResp.id;}
  // 2. Bill for the order.
  let bill;
  try{const gen=await PlemmoAPI.post('/bills/generate',{order_id:plemmoOrderId},{idempotent:true});bill=gen&&gen.bill;}catch(e){}
  if(!bill){const b=await PlemmoAPI.get('/bills/order/'+encodeURIComponent(plemmoOrderId));bill=b&&b.bill;}
  if(!bill)throw new Error('No bill for order');
  // 3. Payments (tip on the first line; cash tendered carries the change).
  const lines=PAY.payments.map((p,i)=>{
    const line={method:p.m==='card'?'card':'cash',amount:r2(p.a)};
    if(i===0&&PAY.tip)line.tip=r2(PAY.tip);
    if(p.m==='cash'&&i===PAY.payments.length-1&&PAY.change)line.tendered=r2(p.a+PAY.change);
    return line;
  });
  await PlemmoPayments.paySplit(bill.id,lines,c.custId);
  // 4. Build/patch the local display order from the AUTHORITATIVE bill (receipt
  // + history cache). No local stock/loyalty mutation — Plemmo already did both.
  const o=existing||{id:uid('o'),opened:Date.now(),source:'pos'};
  Object.assign(o,{no:bill.bill_number||(orderResp&&orderResp.order_number)||o.no||plemmoOrderId,plemmoOrderId:plemmoOrderId,plemmoBillId:bill.id,
    ts:Date.now(),empId:o.empId||U.user,closedBy:U.user,type:c.type,table:c.table,custId:c.custId,
    items:c.items.map(l=>({...l,sent:true})),
    subtotal:Number(bill.subtotal)||cartTotals(c).subtotal,tax:Number(bill.tax_amount)||0,
    discAmt:Number(bill.discount_amount)||0,total:Number(bill.total)||0,
    tip:PAY.tip||0,payments:PAY.payments.map(p=>({m:p.m,a:p.a})),status:'paid',pts:0,discount:c.discount||null});
  if(!existing)S.orders.push(o);
  const change=PAY.change||0;
  PAY.done=true;PAY.L.close();PAY=null;
  U.cart=newCart();U.selLine=null;U.mobCart=false;
  try{saveNow();}catch(e){}
  if(U.view==='pos'){$('#pos').classList.remove('cart-open');refreshPos();}
  renderRail();
  showReceipt(o,{change,fresh:true});
  // Refresh authoritative stock in the background so the Items view is current.
  if(window.PlemmoCatalogue)PlemmoCatalogue.load(S).then(()=>{if(U.view==='items'||U.view==='home')renderView();}).catch(()=>{});
}
function finishSaleLocal(){
  const c=U.cart,t=cartTotals(c);
  let o=c.orderId?orderOf(c.orderId):null;
  const unsent=c.items.filter(l=>!l.sent);
  if(!o){o={id:uid('o'),no:S.seq++,opened:Date.now(),empId:U.user,source:'pos',pts:0};S.orders.push(o);}
  writeOrderFromCart(o,c);
  Object.assign(o,{ts:Date.now(),empId:o.empId||U.user,closedBy:U.user,tip:PAY.tip,payments:PAY.payments.map(p=>({m:p.m,a:p.a})),status:'paid'});
  o.items=o.items.map(l=>({...l,sent:true}));
  c.items.forEach(l=>{const p=prod(l.pid);if(p&&p.stock!=null)p.stock=Math.max(0,p.stock-l.qty);});
  if(o.custId){const cu=cust(o.custId);if(cu){o.pts=Math.floor(o.total*S.settings.loyalty.earn);cu.points=cu.points+o.pts-(c.discount&&c.discount.pts?c.discount.pts:0);cu.visits++;cu.spend=r2(cu.spend+o.total);cu.last=o.ts;}}
  if(S.settings.kitchen&&unsent.length&&hospitality())addTicket(o,unsent);
  const change=PAY.change||0;
  PAY.done=true;PAY.L.close();PAY=null;
  U.cart=newCart();U.selLine=null;U.mobCart=false;
  save();
  if(U.view==='pos'){$('#pos').classList.remove('cart-open');refreshPos();}
  renderRail();
  showReceipt(o,{change,fresh:true});
  const lows=o.items.map(l=>prod(l.pid)).filter(p=>p&&p.stock!=null&&p.stock<=(p.low??5)&&p.stock>=0);
  if(lows.length)setTimeout(()=>toast(`${lows[0].name} is running low: ${lows[0].stock} left`,'warn'),900);
}

/* ---------- Receipts ---------- */
function barcodeHTML(no){const s=String(no).padStart(6,'0')+'7';let h='';for(let i=0;i<s.length*4;i++){const d=+s[i%s.length];h+=`<i style="width:${1+(d+i)%3}px;opacity:${(d*7+i)%5===0?0:1}"></i>`;}return`<div class="barcode" aria-hidden="true">${h}</div>`;}
function receiptHTML(o,{cls=''}={}){
  const s=S.settings,e=emp(o.empId),cu=o.custId?cust(o.custId):null,tb=o.table?tableOf(o.table):null;
  const grand=r2(o.total+(o.tip||0));
  return`<div class="paper receipt ${cls}">
   <div class="p-h"><b>${esc(s.name)}</b>${s.address?`<span class="pm">${esc(s.address)}</span><br>`:''}${s.vatNo?`<span class="pm">${esc(s.taxName)} no. ${esc(s.vatNo)}</span>`:''}</div>
   <div class="bigno">${o.no}</div>
   <div class="p-h pm">${typeLabel(o.type)}${tb?', table '+esc(tb.name):''}${o.source==='kiosk'?', kiosk':''}</div>
   <div class="rule"></div>
   <div class="kv pm"><span>${fmtD(o.ts)}</span><span>${fmtT(o.ts)}</span></div>
   ${e?`<div class="pm">Served by ${esc(first(e.name))}</div>`:''}
   <div class="rule"></div>
   ${o.items.map(l=>`<div class="kv"><span>${l.qty} ${esc(l.name)}</span><span>${money(lineTotal(l))}</span></div>${l.mods.length?`<div class="ind">${l.mods.map(m=>esc(m.n)).join(', ')}</div>`:''}${l.note?`<div class="ind">“${esc(l.note)}”</div>`:''}`).join('')}
   <div class="rule"></div>
   <div class="kv"><span>Subtotal</span><span>${money(o.subtotal)}</span></div>
   ${o.discAmt?`<div class="kv"><span>${esc(o.discount?o.discount.reason:'Discount')}</span><span>−${money(o.discAmt)}</span></div>`:''}
   ${s.showTaxLine?`<div class="kv pm"><span>${esc(s.taxName)} ${s.taxRate}%${s.taxInclusive?' incl.':''}</span><span>${money(o.tax)}</span></div>`:''}
   <div class="kv b"><span>Total</span><span>${money(o.total)}</span></div>
   ${o.tip?`<div class="kv"><span>Tip, thank you</span><span>${money(o.tip)}</span></div><div class="kv b"><span>Paid</span><span>${money(grand)}</span></div>`:''}
   <div class="rule"></div>
   ${o.status==='open'?'<div class="kv"><span>Not paid yet</span></div>':o.payments.map(p=>`<div class="kv"><span>${p.m==='cash'?'Cash':'Card, contactless'}</span><span>${money(p.a)}</span></div>`).join('')}
   ${o.status==='refunded'?`<div class="rule"></div><div class="kv b"><span>REFUNDED</span><span>${fmtT(o.refund.ts)}</span></div>`:''}
   ${o.status==='void'?`<div class="rule"></div><div class="kv b"><span>VOIDED</span></div>`:''}
   ${cu?`<div class="rule"></div><div class="pm">${esc(cu.name)}: +${o.pts||0} points, balance ${cu.points}</div>`:''}
   ${o.note?`<div class="rule"></div><div class="pm">Note: ${esc(o.note)}</div>`:''}
   <div class="rule"></div>
   <div class="p-h pm">${esc(s.receiptFooter||'')}</div>
   ${s.showBarcode?barcodeHTML(o.no):''}
  </div>`;
}
function showReceipt(o,{change=0,fresh=false}={}){
  modal({title:fresh?'Payment complete':`Order ${o.no}`,cls:'rc-modal',body:`${change>0?`<div class="change-due">Give ${money(change)} change</div>`:''}${receiptHTML(o,{cls:fresh?'rc-print':''})}`,
    foot:`<button class="btn" data-act="printRc" data-id="${o.id}">${ic('printer',18)} Print</button><button class="btn" data-act="emailRc" data-id="${o.id}">${ic('mail',18)} Email</button><span class="spacer"></span><button class="btn btn-primary" data-act="closeTop" autofocus>${fresh?'Start the next sale':'Done'}</button>`});
}
A.printRc=()=>toast('Sent to the receipt printer');
A.emailRc=async d=>{
  const o=orderOf(d.id),cu=o&&o.custId?cust(o.custId):null;
  let to=cu&&cu.email?cu.email:null;
  if(!to){
    const v=await promptBox({title:'Email the receipt',label:'Email address',type:'email',placeholder:'name@example.com',ok:'Send receipt'});
    if(!v)return;
    if(!/.+@.+\..+/.test(v)){toast('That email address doesn’t look right','warn');return;}
    to=v.trim();
  }
  // Record the digital-receipt request authoritatively against the Plemmo bill.
  // (The desktop build has no mail transport; Plemmo records the request and
  // returns the receipt payload — it never silently claims a mail was sent.)
  if(window.PlemmoReceipts&&o&&o.plemmoBillId&&PlemmoAPI.isAuthenticated()){
    try{await PlemmoReceipts.deliver(o.plemmoBillId,'email',to);toast(`Receipt for ${to} recorded on Plemmo`);}
    catch(e){toast((e&&e.message)||'Could not record the receipt on Plemmo','warn');}
    return;
  }
  toast(`Receipt prepared for ${to}`);
};

/* =====================================================================
   TABLES
   ===================================================================== */
VIEWS.tables=()=>{
  const open=S.orders.filter(o=>o.status==='open');
  const byT=Object.fromEntries(open.filter(o=>o.table).map(o=>[o.table,o]));
  const seated=open.filter(o=>o.table).length,value=sum(open,o=>o.total),covers=sum(S.tables.filter(t=>byT[t.id]),t=>t.seats);
  const tiles=S.tables.map(t=>{const o=byT[t.id];const mins=o?Math.floor((Date.now()-o.opened)/MIN):0;const cls=o?(mins>=60?'long':'busy'):'';
    return`<button class="ftable ${t.shape} ${t.size} ${cls}" style="left:${t.x}%;top:${t.y}%" data-act="tableOpen" data-id="${t.id}" aria-label="Table ${esc(t.name)}, ${o?'seated '+mins+' minutes, '+money(o.total):'free, '+t.seats+' seats'}"><span class="tn">${esc(t.name)}</span><span class="ti">${o?`<span data-since="${o.opened}" data-fmt="min">${mins} min</span>`:t.seats+' seats'}</span>${o?`<span class="ti num">${money(o.total)}</span>`:''}</button>`;}).join('');
  return`<div class="page">
   <div class="page-head"><div><h2>Floor</h2><p class="sub">${seated} of ${S.tables.length} tables seated, ${covers} covers, ${money(value)} open</p></div>
   <div class="ph-actions"><div class="legend"><span><i></i>Free</span><span><i class="busy"></i>Seated</span><span><i class="long"></i>Seated over an hour</span></div></div></div>
   <div class="floor-wrap">
    <div class="floor" role="group" aria-label="Floor plan">
     <div class="window"></div><span class="zone-l" style="left:4%;top:3%">Window</span>
     <div class="zone" style="left:62%;top:3%;width:35%;height:92%"></div><span class="zone-l" style="left:64%;top:88%">Terrace</span>
     <div class="counter" style="left:44%;top:66%;width:14%;height:24%">Counter</div>
     ${tiles}
    </div>
    <div class="panel"><div class="panel-h"><h3>Open tables</h3><span class="ph-sub">Longest first</span></div><div class="panel-b flush"><div class="list">
     ${open.filter(o=>o.table).sort((a,b)=>a.opened-b.opened).map(o=>{const t=tableOf(o.table),m=Math.floor((Date.now()-o.opened)/MIN);return`<div class="li click" data-act="tableOpen" data-id="${o.table}"><span class="sevbar ${m>=60?'warn':'info'}"></span><div class="li-t"><b>Table ${esc(t?t.name:'')}, order ${o.no}</b><small>${sum(o.items,l=>l.qty)} items, seated ${m} min</small></div><b class="num">${money(o.total)}</b></div>`;}).join('')||`<div class="empty"><div class="e-ic">${ic('tables',24)}</div><h3>Every table is free</h3><p>Tap a table to seat a party and start their order.</p></div>`}
    </div></div></div>
   </div></div>`;
};
A.tableOpen=d=>{
  const o=S.orders.find(x=>x.status==='open'&&x.table===d.id),t=tableOf(d.id);
  if(o){loadOrderToCart(o);go('pos');toast(`Table ${t.name}: add items, send to the kitchen or charge`,'info');}
  else{if(U.cart.items.length&&!U.cart.orderId){A.hold();}U.cart=newCart();U.cart.type='dine';U.cart.table=d.id;go('pos');toast(`Table ${t.name} seated. Add items, then send them to the kitchen.`,'info');}
};

/* =====================================================================
   KITCHEN DISPLAY
   ===================================================================== */
VIEWS.kitchen=()=>{
  const act=S.tickets.filter(t=>t.status!=='done');
  const t0=dayStart(0),doneToday=S.tickets.filter(t=>t.status==='done'&&t.doneTs&&t.doneTs>=t0);
  const avg=doneToday.length?sum(doneToday,t=>t.doneTs-t.ts)/doneToday.length:0;
  const late=act.filter(t=>t.status!=='ready'&&Date.now()-t.ts>=10*MIN).length;
  const top=`<div class="kds-top"><div class="seg"><button class="${U.kds.mode==='tickets'?'on':''}" data-act="kdsMode" data-m="tickets">${ic('chef',16)} Tickets</button><button class="${U.kds.mode==='board'?'on':''}" data-act="kdsMode" data-m="board">${ic('kiosk',16)} Collection board</button></div>
    <button class="btn btn-sm btn-ghost" data-act="kdsRecall" ${S.tickets.some(t=>t.status==='done')?'':'disabled'}>${ic('refund',16)} Recall last</button>
    <div class="kds-stats"><span><b class="num">${act.filter(t=>t.status!=='ready').length}</b>cooking</span><span><b class="num">${avg?mmss(avg):'–'}</b>average ticket today</span><span><b class="num" style="color:${late?'var(--bad-text)':'inherit'}">${late}</b>over 10 min</span></div></div>`;
  if(U.kds.mode==='board'){
    const prep=act.filter(t=>t.status!=='ready'),ready=act.filter(t=>t.status==='ready');
    return`<div class="kds">${top}<div class="board"><div><h3>Preparing</h3><div class="board-nos">${prep.map(t=>`<span class="num">${t.no}</span>`).join('')||'<p class="muted">Nothing cooking right now</p>'}</div></div><div><h3>Ready to collect</h3><div class="board-nos">${ready.map(t=>`<span class="num">${t.no}</span>`).join('')||'<p style="color:var(--rail-text)">Orders appear here when the kitchen bumps them</p>'}</div></div></div></div>`;
  }
  const lane=(st,label,next)=>{const list=act.filter(t=>t.status===st).sort((a,b)=>a.ts-b.ts);return`<section class="lane" aria-label="${label}"><div class="lane-h">${label}<span class="cnt num">${list.length}</span></div><div class="lane-b">${list.map(t=>ticketHTML(t,next)).join('')||`<p class="muted" style="padding:6px 2px">${st==='new'?'New orders from the register and kiosk land here.':st==='prep'?'Start a ticket to move it here.':'Bump finished tickets here for collection.'}</p>`}</div></section>`;};
  return`<div class="kds">${top}<div class="lanes">${lane('new','New','Start')}${lane('prep','Preparing','Ready')}${lane('ready','Ready','Collected')}</div></div>`;
};
function ticketHTML(t,next){
  const tb=t.table?tableOf(t.table):null,m=(Date.now()-t.ts)/MIN;
  const lvl=t.status==='ready'?'ok':m>=10?'bad':m>=5?'warn':'ok';
  return`<article class="kt" data-kt data-ready="${t.status==='ready'?1:0}" data-lvl="${lvl}">
   <div class="kt-h"><span class="kt-no">${t.no}</span><span class="kt-type">${t.source==='kiosk'?'Kiosk, ':''}${typeLabel(t.type)}${tb?' '+esc(tb.name):''}</span>${t.cust?`<span class="kt-type">${esc(t.cust)}</span>`:''}<span class="kt-time num" data-since="${t.ts}">${mmss(Date.now()-t.ts)}</span></div>
   <div class="kt-b">${t.items.map((it,i)=>`<button class="kt-i ${it.done?'done':''}" data-act="ktItem" data-id="${t.id}" data-i="${i}" aria-pressed="${it.done}"><b>${it.qty}×</b><b>${esc(it.name)}</b>${it.mods.length?`<span class="m">${it.mods.map(esc).join(', ')}</span>`:''}${it.note?`<span class="m">“${esc(it.note)}”</span>`:''}</button>`).join('')}${t.note?`<p class="pm" style="padding:4px 6px;font-size:11.5px">Note: ${esc(t.note)}</p>`:''}</div>
   <div class="kt-f">${t.status!=='new'?`<button class="btn btn-sm" data-act="ktBack" data-id="${t.id}" aria-label="Move back">${ic('chevL',16)}</button>`:''}<button class="btn btn-sm btn-dark" data-act="ktNext" data-id="${t.id}">${next} ${ic('chevR',16)}</button></div>
  </article>`;
}
A.kdsMode=d=>{U.kds.mode=d.m;renderView();};
A.ktItem=d=>{const t=S.tickets.find(x=>x.id===d.id);if(!t)return;t.items[+d.i].done=!t.items[+d.i].done;save();renderView();};
A.ktNext=d=>{const t=S.tickets.find(x=>x.id===d.id);if(!t)return;const nx={new:'prep',prep:'ready',ready:'done'}[t.status];t.status=nx;if(nx==='ready')t.items.forEach(i=>i.done=true);if(nx==='done')t.doneTs=Date.now();save();renderView();renderRail();if(nx==='ready')toast(`Order ${t.no} is ready${t.table?' for table '+(tableOf(t.table)||{}).name:''}`);};
A.ktBack=d=>{const t=S.tickets.find(x=>x.id===d.id);if(!t)return;t.status={prep:'new',ready:'prep'}[t.status]||t.status;save();renderView();renderRail();};
A.kdsRecall=()=>{const t=S.tickets.filter(x=>x.status==='done').sort((a,b)=>(b.doneTs||0)-(a.doneTs||0))[0];if(!t)return;t.status='ready';t.doneTs=null;save();renderView();renderRail();toast(`Order ${t.no} recalled`);};

/* =====================================================================
   ORDERS
   ===================================================================== */
function orderMatches(o){
  const f=U.orders.filter;
  if(f==='open'&&o.status!=='open')return false;
  if(f==='paid'&&o.status!=='paid')return false;
  if(f==='refunded'&&!(o.status==='refunded'||o.status==='void'))return false;
  if(U.orders.src!=='all'&&o.source!==U.orders.src)return false;
  const q=U.orders.q.trim().toLowerCase();
  if(q){const cu=o.custId?cust(o.custId):null,e=emp(o.empId);if(!(String(o.no).includes(q)||(cu&&cu.name.toLowerCase().includes(q))||(e&&e.name.toLowerCase().includes(q))||o.items.some(l=>l.name.toLowerCase().includes(q))))return false;}
  return true;
}
VIEWS.orders=()=>{
  const all=S.orders.filter(orderMatches).sort((a,b)=>b.ts-a.ts),list=all.slice(0,U.orders.limit);
  const t0=dayStart(0),today=S.orders.filter(o=>o.ts>=t0&&o.status==='paid');
  const counts={open:S.orders.filter(o=>o.status==='open').length};
  return`<div class="page">
   <div class="page-head"><div><h2>Orders</h2><p class="sub">${today.length} paid today for ${money(sum(today,o=>o.total))}${counts.open?`, ${counts.open} open`:''}</p></div></div>
   <div class="row" style="margin-bottom:14px">
    <div class="seg">${[['all','All'],['open','Open'],['paid','Paid'],['refunded','Refunded & void']].map(([k,l])=>`<button class="${U.orders.filter===k?'on':''}" data-act="ordFilter" data-f="${k}">${l}${k==='open'&&counts.open?` <span class="badge accent">${counts.open}</span>`:''}</button>`).join('')}</div>
    <div class="seg">${[['all','All sources'],['pos','Register'],['kiosk','Kiosk']].map(([k,l])=>`<button class="${U.orders.src===k?'on':''}" data-act="ordSrc" data-s="${k}">${l}</button>`).join('')}</div>
    <label class="search" style="max-width:360px">${ic('search',18)}<input data-in="ordQ" value="${esc(U.orders.q)}" placeholder="Order number, customer, staff or item"></label>
   </div>
   <div class="panel"><div class="tbl-wrap" id="ordTbl">${ordersTable(list,all.length)}</div></div>
  </div>`;
};
function ordersTable(list,total){
  if(!list.length)return`<div class="empty"><div class="e-ic">${ic('receipt',24)}</div><h3>No orders match</h3><p>Try a different filter or search.</p></div>`;
  return`<table class="tbl"><thead><tr><th>Order</th><th>Time</th><th>Items</th><th>Type</th><th>Staff</th><th>Payment</th><th class="r">Total</th><th>Status</th></tr></thead><tbody>
   ${list.map(o=>{const e=emp(o.empId),cu=o.custId?cust(o.custId):null,names=o.items.map(l=>l.name);const st={paid:['ok','Paid'],open:['accent','Open'],refunded:['bad','Refunded'],void:['bad','Voided']}[o.status]||['','?'];
    return`<tr class="click" data-act="openOrder" data-id="${o.id}"><td><b class="num">${o.no}</b>${cu?`<div class="faint" style="font-size:12px">${esc(cu.name)}</div>`:''}</td><td class="num" style="white-space:nowrap">${o.ts>=dayStart(0)?fmtT(o.ts):fmtDT(o.ts)}</td><td style="max-width:280px"><span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(names.slice(0,2).join(', '))}${names.length>2?` +${names.length-2}`:''}</span></td><td><span class="badge">${ic(typeIcon(o.type),13)}${typeLabel(o.type)}${o.table?' '+esc((tableOf(o.table)||{}).name||''):''}</span>${o.source==='kiosk'?' <span class="badge info">Kiosk</span>':''}</td><td>${e?esc(first(e.name)):'<span class="faint">Self-serve</span>'}</td><td>${payLabel(o)}</td><td class="r num"><b>${money(o.total+(o.tip||0))}</b></td><td><span class="badge ${st[0]}">${st[1]}</span></td></tr>`;}).join('')}
  </tbody></table>${total>list.length?`<div style="padding:14px;text-align:center"><button class="btn" data-act="ordMore">Show more (${total-list.length} older)</button></div>`:''}`;
}
A.ordFilter=d=>{U.orders.filter=d.f;U.orders.limit=60;renderView();};
A.ordSrc=d=>{U.orders.src=d.s;U.orders.limit=60;renderView();};
A.ordMore=()=>{U.orders.limit+=100;renderView();};
IN.ordQ=v=>{U.orders.q=v;U.orders.limit=60;const all=S.orders.filter(orderMatches).sort((a,b)=>b.ts-a.ts);$('#ordTbl').innerHTML=ordersTable(all.slice(0,U.orders.limit),all.length);};
A.openOrder=d=>openOrderDrawer(d.id);
function openOrderDrawer(id){
  const o=orderOf(id);if(!o)return;
  const canRefund=o.status==='paid';
  drawer({title:`Order ${o.no}`,body:`<div style="background:var(--sunken);margin:0 -22px;padding:18px 22px 10px">${receiptHTML(o)}</div>
    ${o.refund?`<p class="muted mt">${o.status==='void'?'Voided':'Refunded'} by ${esc(first((emp(o.refund.by)||{}).name||''))} at ${fmtDT(o.refund.ts)}. Reason: ${esc(o.refund.reason)}.</p>`:''}`,
   foot:`${o.status==='open'?`<button class="btn btn-primary" data-act="drOpenOrder" data-id="${o.id}">Open in register</button>`:''}${canRefund?`<button class="btn btn-danger" data-act="refund" data-id="${o.id}">${ic('refund',16)} Refund</button>`:''}<span class="spacer"></span><button class="btn" data-act="printRc" data-id="${o.id}">${ic('printer',16)} Reprint</button><button class="btn" data-act="emailRc" data-id="${o.id}">${ic('mail',16)} Email</button>`});
}
A.drOpenOrder=d=>{const o=orderOf(d.id);closeAll();loadOrderToCart(o);go('pos');};
A.refund=async d=>{
  const o=orderOf(d.id);if(!o||o.status!=='paid')return;
  const by=await approve('refunds',`Refunding order ${o.no}`);if(!by)return;
  let reason='Customer changed their mind',restock=true;
  const ok=await new Promise(res=>{let done=false;
    const L=modal({title:`Refund ${money(o.total+(o.tip||0))}?`,cls:'narrow',body:`<p class="muted">The money goes back the way it was paid: ${payLabel(o).toLowerCase()}. Loyalty points from this order are taken back.</p>
      <label class="field mt"><span>Reason</span><select class="input" id="rfR">${['Customer changed their mind','Wrong item','Quality problem','Charged twice','Other'].map(r=>`<option>${r}</option>`).join('')}</select></label>
      <label class="switch mt"><input type="checkbox" id="rfS" checked><span class="tr"></span><span>Put the items back in stock</span></label>`,
     foot:`<button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-danger-solid" id="rfGo">Refund order</button>`,onClose:()=>{if(!done)res(false);}});
    L.el.querySelector('#rfGo').onclick=()=>{reason=L.el.querySelector('#rfR').value;restock=L.el.querySelector('#rfS').checked;done=true;L.close();res(true);};
  });
  if(!ok)return;
  o.status='refunded';o.refund={ts:Date.now(),by:by.id,reason,restock};
  if(restock)o.items.forEach(l=>{const p=prod(l.pid);if(p&&p.stock!=null){p.stock+=l.qty;S.stockLog.push({id:uid('sl'),ts:Date.now(),pid:p.id,name:p.name,change:l.qty,kind:'return',reason:'Refund of order '+o.no,by:by.id,after:p.stock});}});
  if(o.custId){const cu=cust(o.custId);if(cu){cu.points=Math.max(0,cu.points-(o.pts||0));cu.spend=r2(Math.max(0,cu.spend-o.total));cu.visits=Math.max(0,cu.visits-1);}}
  save();closeAll();if(U.view==='orders'||U.view==='home')renderView();toast(`Order ${o.no} refunded`);
};
