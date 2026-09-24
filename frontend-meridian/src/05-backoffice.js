
/* =====================================================================
   ITEMS & STOCK
   ===================================================================== */
const sw=(checked,attrs,label='')=>`<label class="switch"><input type="checkbox" ${checked?'checked':''} ${attrs}><span class="tr"></span>${label?`<span>${label}</span>`:''}</label>`;
function netPrice(p){return S.settings.taxInclusive?p/(1+S.settings.taxRate/100):p;}
function marginOf(p){const n=netPrice(p.price);return n?(n-p.cost)/n:0;}
function marginBadge(m){const k=m>=.65?'ok':m>=.5?'warn':'bad';const l=m>=.65?'Healthy':m>=.5?'Watch':'Low';return`<span class="badge ${k}" data-tip="${l} margin after ${esc(S.settings.taxName)}">${pct(m)}</span>`;}
function stockCell(p){
  if(p.stock==null)return`<span class="faint">Not tracked</span>`;
  const lo=p.low??5,k=p.stock<=0?'bad':p.stock<=lo?'warn':'';
  return`<div style="display:flex;align-items:center;gap:10px"><b class="num" style="min-width:28px">${p.stock}</b><div class="bar-mini ${k}" style="flex:1;max-width:90px"><i style="width:${clamp(p.stock/Math.max(lo*4,1)*100,4,100)}%"></i></div>${p.stock<=0?'<span class="badge bad">Out</span>':p.stock<=lo?'<span class="badge warn">Low</span>':''}</div>`;
}
VIEWS.items=()=>{
  const tab=U.items.tab,low=lowStock().length;
  const tabs=`<div class="seg">${[['items','Items'],['cats','Categories'],['mods','Options'],['log','Stock history']].map(([k,l])=>`<button class="${tab===k?'on':''}" data-act="itTab" data-t="${k}">${l}</button>`).join('')}</div>`;
  let body='';
  if(tab==='items'){
    const q=U.items.q.toLowerCase();
    const list=S.products.filter(p=>(U.items.cat==='all'||p.cat===U.items.cat||(U.items.cat==='low'&&p.stock!=null&&p.stock<=(p.low??5)))&&(!q||p.name.toLowerCase().includes(q)||String(p.sku).includes(q)));
    body=`<div class="row" style="margin-bottom:14px"><label class="search" style="max-width:340px">${ic('search',18)}<input data-in="itQ" value="${esc(U.items.q)}" placeholder="Search items or SKU"></label>
      <select class="input" style="width:auto" data-ch="itCat"><option value="all">All categories</option>${low?`<option value="low" ${U.items.cat==='low'?'selected':''}>Low stock (${low})</option>`:''}${S.categories.map(c=>`<option value="${c.id}" ${U.items.cat===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
     <div class="panel"><div class="tbl-wrap">${list.length?`<table class="tbl"><thead><tr><th>Item</th><th>Category</th><th class="r">Price</th><th class="r">Cost</th><th class="r">Margin</th><th>Stock</th><th>On sale</th><th></th></tr></thead><tbody>
      ${list.map(p=>{const c=catOf(p.cat)||{name:'None',color:'#888'};return`<tr><td><div class="it-cell"><span class="it-em" style="--c:${c.color}">${p.emoji||'•'}</span><div><b>${esc(p.name)}</b><small class="num">${esc(p.sku||'')}</small></div></div></td><td>${esc(c.name)}</td><td class="r num">${money(p.price)}</td><td class="r num">${money(p.cost)}</td><td class="r">${marginBadge(marginOf(p))}</td><td style="min-width:170px">${stockCell(p)}</td><td>${sw(p.available,`data-ch="itAvail" data-id="${p.id}" aria-label="${esc(p.name)} on sale"`)}</td><td class="r" style="white-space:nowrap">${p.stock!=null?`<button class="btn btn-sm" data-act="stockAdj" data-id="${p.id}">Adjust stock</button> `:''}<button class="btn btn-sm btn-ghost btn-icon" data-act="itEdit" data-id="${p.id}" aria-label="Edit ${esc(p.name)}">${ic('edit',16)}</button></td></tr>`;}).join('')}
      </tbody></table>`:`<div class="empty"><div class="e-ic">${ic('box',24)}</div><h3>${S.products.length?'No items match':'No items yet'}</h3><p>${S.products.length?'Try another search or category.':'Add the things you sell. Each one gets a tile on the register.'}</p><button class="btn btn-primary" data-act="itEdit">${ic('plus',16)} Add an item</button></div>`}</div></div>`;
  }else if(tab==='cats'){
    body=`<div class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Category</th><th class="r">Items</th><th class="r">Sales, last 30 days</th><th></th></tr></thead><tbody>
     ${S.categories.map(c=>{const ids=new Set(S.products.filter(p=>p.cat===c.id).map(p=>p.id));const sales=sum(S.orders.filter(o=>o.ts>=dayStart(-29)&&o.status==='paid'),o=>sum(o.items.filter(l=>ids.has(l.pid)),lineTotal));return`<tr><td><div class="it-cell"><span class="it-em" style="--c:${c.color}">${c.emoji}</span><b>${esc(c.name)}</b></div></td><td class="r num">${ids.size}</td><td class="r num">${money(sales)}</td><td class="r"><button class="btn btn-sm btn-ghost btn-icon" data-act="catEdit" data-id="${c.id}" aria-label="Edit ${esc(c.name)}">${ic('edit',16)}</button></td></tr>`;}).join('')||`<tr><td colspan="4"><div class="empty"><h3>No categories yet</h3><p>Categories group items on the register and kiosk.</p></div></td></tr>`}
     </tbody></table></div></div>`;
  }else if(tab==='mods'){
    body=`<div class="cards">${S.modGroups.map(g=>{const used=S.products.filter(p=>(p.mods||[]).includes(g.id)).length;return`<div class="panel"><div class="panel-h"><h3>${esc(g.name)}</h3><button class="btn btn-sm btn-ghost btn-icon" data-act="modEdit" data-id="${g.id}" aria-label="Edit ${esc(g.name)}">${ic('edit',16)}</button></div><div class="panel-b"><div class="row" style="margin-bottom:10px"><span class="badge">${g.req?'Required':'Optional'}</span><span class="badge">${g.multi?'Choose any':'Choose one'}</span><span class="badge info">On ${used} item${used===1?'':'s'}</span></div>${g.opts.map(([n,p])=>`<div style="display:flex;justify-content:space-between;padding:4px 0"><span>${esc(n)}</span><span class="num muted">${p?'+'+money(p):'Free'}</span></div>`).join('')}</div></div>`;}).join('')}
     <button class="panel" data-act="modEdit" style="display:grid;place-items:center;min-height:160px;border-style:dashed;color:var(--muted);font-weight:600;gap:8px">${ic('plus',22)}New option group</button></div>`;
  }else{
    const log=[...S.stockLog].sort((a,b)=>b.ts-a.ts).slice(0,150);
    body=`<div class="panel"><div class="tbl-wrap">${log.length?`<table class="tbl"><thead><tr><th>When</th><th>Item</th><th class="r">Change</th><th>Reason</th><th>By</th><th class="r">Stock after</th></tr></thead><tbody>${log.map(s=>`<tr><td class="num">${fmtDT(s.ts)}</td><td>${esc(s.name)}</td><td class="r num"><b style="color:${s.change<0?'var(--bad-text)':'var(--ok-text)'}">${s.change>0?'+':''}${s.change}</b></td><td>${esc(s.reason)}</td><td>${esc(first((emp(s.by)||{}).name||''))}</td><td class="r num">${s.after}</td></tr>`).join('')}</tbody></table>`:`<div class="empty"><h3>No stock movements yet</h3><p>Deliveries, waste and counts show up here.</p></div>`}</div></div>`;
  }
  const tracked=S.products.filter(p=>p.stock!=null);
  return`<div class="page"><div class="page-head"><div><h2>Items & stock</h2><p class="sub">${S.products.length} items, ${tracked.length} with tracked stock${low?`, <b style="color:var(--warn-text)">${low} running low</b>`:''}</p></div>
   <div class="ph-actions">${tabs}${tab==='cats'?`<button class="btn btn-primary" data-act="catEdit">${ic('plus',16)} New category</button>`:tab==='items'?`<button class="btn btn-primary" data-act="itEdit">${ic('plus',16)} New item</button>`:''}</div></div>${body}</div>`;
};
A.itTab=d=>{U.items.tab=d.t;renderView();};
IN.itQ=debounce(v=>{U.items.q=v;const pos=$('[data-in="itQ"]').selectionStart;renderView();const i=$('[data-in="itQ"]');if(i){i.focus();i.setSelectionRange(pos,pos);}},180);
function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}
CH.itCat=v=>{U.items.cat=v;renderView();};
CH.itAvail=(v,el)=>{const p=prod(el.dataset.id);if(!p)return;p.available=el.checked;save();renderRail();toast(`${p.name} is ${p.available?'back on sale':'marked sold out'}`);};
A.itEdit=d=>editItem(d.id);
let IT=null;
function editItem(id){
  const p=id?prod(id):null;
  IT={id,emoji:p?p.emoji:'🍽️',allergens:new Set(p?p.allergens:[]),mods:new Set(p?p.mods:[]),track:p?p.stock!=null:false};
  const cats=S.categories;
  const L=modal({title:p?esc(p.name):'New item',cls:'wide',body:`<div class="fgrid">
    <label class="field span2"><span>Name</span><input class="input" id="itN" value="${esc(p?p.name:'')}" placeholder="For example, Oat Flat White" autofocus></label>
    <div class="field span2"><span>Picture on the register</span><div class="emoji-grid" role="listbox" aria-label="Choose an emoji">${EMOJIS.map(e=>`<button type="button" class="${IT.emoji===e?'on':''}" data-act="itEmoji" data-e="${e}" aria-label="${e}">${e}</button>`).join('')}</div></div>
    <label class="field"><span>Category</span><select class="input" id="itC">${cats.map(c=>`<option value="${c.id}" ${p&&p.cat===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}${cats.length?'':'<option value="">No categories yet</option>'}</select></label>
    <label class="field"><span>SKU or barcode</span><input class="input num" id="itSku" value="${esc(p?p.sku:'')}" placeholder="Optional"></label>
    <label class="field"><span>Price${S.settings.taxInclusive?' (incl. '+esc(S.settings.taxName)+')':''}</span><input class="input num" id="itP" type="number" min="0" step="0.05" value="${p?p.price:''}" data-in="itMargin"></label>
    <label class="field"><span>Cost to you</span><input class="input num" id="itCo" type="number" min="0" step="0.05" value="${p?p.cost:''}" data-in="itMargin"></label>
    <div class="span2" id="itMarg"></div>
    <label class="field span2"><span>Description, shown on the kiosk</span><input class="input" id="itD" value="${esc(p?p.desc:'')}" placeholder="Optional"></label>
    <div class="span2">${sw(IT.track,'id="itT" data-ch="itTrack"','Track stock for this item')}</div>
    <div class="span2 fgrid" id="itStockF" ${IT.track?'':'hidden'}><label class="field"><span>In stock now</span><input class="input num" id="itS" type="number" min="0" value="${p&&p.stock!=null?p.stock:0}"></label><label class="field"><span>Warn me below</span><input class="input num" id="itL" type="number" min="0" value="${p&&p.low!=null?p.low:5}"></label></div>
    ${S.modGroups.length?`<div class="field span2"><span>Options customers can choose</span><div class="chips">${S.modGroups.map(g=>`<button type="button" class="chip ${IT.mods.has(g.id)?'on':''}" data-act="itMod" data-id="${g.id}">${esc(g.name)}</button>`).join('')}</div></div>`:''}
    <div class="field span2"><span>Allergens</span><div class="chips">${ALLERGENS.map(a=>`<button type="button" class="chip ${IT.allergens.has(a)?'on':''}" data-act="itAll" data-a="${a}">${a}</button>`).join('')}</div></div>
    <div class="span2 row">${sw(p?p.available:true,'id="itA"','On sale')}${sw(p?p.kiosk!==false:true,'id="itK"','Show on the kiosk')}</div>
   </div>`,
   foot:`${p?`<button class="btn btn-danger" data-act="itDel" data-id="${p.id}">Delete</button>`:''}<span class="spacer"></span><button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" data-act="itSave">${p?'Save changes':'Add item'}</button>`});
  IT.L=L;IN.itMargin();
}
IN.itMargin=()=>{const p=+($('#itP')||{}).value||0,c=+($('#itCo')||{}).value||0,el=$('#itMarg');if(!el)return;if(!p){el.innerHTML='';return;}const m=(netPrice(p)-c)/netPrice(p);el.innerHTML=`<div class="change-line ${m<.5?'short':''}"><span>Margin after ${esc(S.settings.taxName)}</span><span class="num">${pct(m)} (${money(netPrice(p)-c)} per sale)</span></div>`;};
A.itEmoji=(d,el)=>{IT.emoji=d.e;$$('.emoji-grid button').forEach(b=>b.classList.toggle('on',b===el));};
A.itMod=(d,el)=>{IT.mods.has(d.id)?IT.mods.delete(d.id):IT.mods.add(d.id);el.classList.toggle('on');};
A.itAll=(d,el)=>{IT.allergens.has(d.a)?IT.allergens.delete(d.a):IT.allergens.add(d.a);el.classList.toggle('on');};
CH.itTrack=(v,el)=>{IT.track=el.checked;$('#itStockF').hidden=!el.checked;};
A.itSave=()=>{
  const name=$('#itN').value.trim(),price=+$('#itP').value;
  if(!name){toast('Give the item a name','warn');$('#itN').focus();return;}
  if(!(price>=0)||$('#itP').value===''){toast('Add a price','warn');$('#itP').focus();return;}
  let p=IT.id?prod(IT.id):null;const isNew=!p;
  if(!p){p={id:uid('p'),w:3};S.products.push(p);}
  const prevStock=p.stock;
  Object.assign(p,{name,price:r2(price),cost:r2(+$('#itCo').value||0),cat:$('#itC').value,sku:$('#itSku').value.trim(),desc:$('#itD').value.trim(),emoji:IT.emoji,allergens:[...IT.allergens],mods:S.modGroups.filter(g=>IT.mods.has(g.id)).map(g=>g.id),available:$('#itA').checked,kiosk:$('#itK').checked,stock:IT.track?Math.max(0,Math.round(+$('#itS').value||0)):null,low:IT.track?Math.max(0,Math.round(+$('#itL').value||0)):null});
  if(IT.track&&p.stock!==prevStock)S.stockLog.push({id:uid('sl'),ts:Date.now(),pid:p.id,name:p.name,change:p.stock-(prevStock||0),kind:'count',reason:isNew?'Opening stock':'Edited on the item',by:U.user,after:p.stock});
  save();IT.L.close();renderView();renderRail();toast(isNew?`${name} added to the register`:`${name} saved`);
};
A.itDel=async d=>{const p=prod(d.id);if(!await confirmBox({title:`Delete ${p.name}?`,text:'It disappears from the register and kiosk. Past orders keep their record of it.',ok:'Delete item',danger:true}))return;S.products=S.products.filter(x=>x!==p);save();closeAll();renderView();renderRail();toast(`${p.name} deleted`);};
A.stockAdj=d=>{
  const p=prod(d.id);if(!p)return;
  const st={mode:'receive',qty:12,reason:'Delivery'};
  const L=modal({title:`Adjust stock: ${esc(p.name)}`,cls:'narrow',body:`<div id="saBody"></div>`,foot:`<button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="saGo">Save</button>`});
  const draw=()=>{const after=st.mode==='receive'?p.stock+st.qty:st.mode==='waste'?Math.max(0,p.stock-st.qty):st.qty;
    L.el.querySelector('#saBody').innerHTML=`<div class="seg" style="margin-bottom:14px">${[['receive','Delivery'],['waste','Waste'],['count','Count']].map(([k,l])=>`<button class="${st.mode===k?'on':''}" data-m="${k}">${l}</button>`).join('')}</div>
     <div class="field"><span>${st.mode==='count'?'Counted on the shelf':st.mode==='waste'?'Thrown away':'Received'}</span><div class="row"><div class="stepper"><button data-s="-1" aria-label="Less">${ic('minus',18)}</button><b class="num">${st.qty}</b><button data-s="1" aria-label="More">${ic('plus',18)}</button></div><span class="muted">Now <b class="num">${p.stock}</b>, after <b class="num">${after}</b></span></div></div>
     ${st.mode==='waste'?`<div class="field mt"><span>Reason</span><div class="chips">${['Out of date','Damaged','Staff meal','Dropped'].map(r=>`<button class="chip ${st.reason===r?'on':''}" data-r="${r}">${r}</button>`).join('')}</div></div>`:''}`;};
  L.el.addEventListener('click',e=>{const m=e.target.closest('[data-m]'),s=e.target.closest('[data-s]'),r=e.target.closest('[data-r]');
    if(m){st.mode=m.dataset.m;st.qty=st.mode==='count'?p.stock:st.mode==='waste'?1:12;st.reason=st.mode==='waste'?'Out of date':st.mode==='count'?'Stock count':'Delivery';draw();}
    if(s){st.qty=Math.max(0,st.qty+(+s.dataset.s));draw();}
    if(r){st.reason=r.dataset.r;draw();}});
  L.el.querySelector('#saGo').onclick=async()=>{
    const before=p.stock;
    // Plemmo owns the single stock ledger. Post the adjustment there and take
    // the authoritative balance back; only fall back to a local change offline.
    if(window.PlemmoInventory&&PlemmoAPI.isAuthenticated()){
      const btn=L.el.querySelector('#saGo');btn.disabled=true;
      try{
        const res=await PlemmoInventory.adjust(st.mode,p.id,st.qty,before,st.reason);
        if(res&&res.movement&&typeof res.movement.balance_after==='number')p.stock=res.movement.balance_after;
        else if(res&&res.noop){/* no change */}
        L.close();renderView();renderRail();toast(`${p.name}: ${p.stock} in stock`);
      }catch(e){btn.disabled=false;toast((e&&e.status===403)?'You don’t have permission to adjust stock':(e&&e.message)||'Could not update stock on Plemmo','warn');}
      return;
    }
    p.stock=st.mode==='receive'?p.stock+st.qty:st.mode==='waste'?Math.max(0,p.stock-st.qty):st.qty;
    S.stockLog.push({id:uid('sl'),ts:Date.now(),pid:p.id,name:p.name,change:p.stock-before,kind:st.mode,reason:st.reason,by:U.user,after:p.stock});save();L.close();renderView();renderRail();toast(`${p.name}: ${p.stock} in stock`);};
  draw();
};
A.catEdit=d=>{
  const c=d.id?catOf(d.id):null;let color=c?c.color:CAT_COLORS[S.categories.length%CAT_COLORS.length],emoji=c?c.emoji:'🍽️';
  const L=modal({title:c?'Edit category':'New category',cls:'narrow',body:`<label class="field"><span>Name</span><input class="input" id="cN" value="${esc(c?c.name:'')}" autofocus></label>
    <div class="field mt"><span>Colour</span><div class="swatches">${CAT_COLORS.map(x=>`<button class="swatch sm ${x===color?'on':''}" style="--sw:${x}" data-c="${x}" aria-label="Colour ${x}"></button>`).join('')}</div></div>
    <div class="field mt"><span>Icon</span><div class="emoji-grid">${EMOJIS.map(e=>`<button type="button" class="${e===emoji?'on':''}" data-e="${e}">${e}</button>`).join('')}</div></div>`,
   foot:`${c?`<button class="btn btn-danger" id="cDel">Delete</button>`:''}<span class="spacer"></span><button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="cGo">${c?'Save':'Add category'}</button>`});
  L.el.addEventListener('click',e=>{const s=e.target.closest('[data-c]'),m=e.target.closest('[data-e]');if(s){color=s.dataset.c;$$('[data-c]',L.el).forEach(b=>b.classList.toggle('on',b===s));}if(m){emoji=m.dataset.e;$$('[data-e]',L.el).forEach(b=>b.classList.toggle('on',b===m));}});
  L.el.querySelector('#cGo').onclick=()=>{const n=L.el.querySelector('#cN').value.trim();if(!n){toast('Name the category','warn');return;}if(c)Object.assign(c,{name:n,color,emoji});else S.categories.push({id:uid('c'),name:n,color,emoji});save();L.close();renderView();toast(c?'Category saved':`${n} added`);};
  const del=L.el.querySelector('#cDel');if(del)del.onclick=()=>{if(S.products.some(p=>p.cat===c.id)){toast('Move or delete its items first','warn');return;}S.categories=S.categories.filter(x=>x!==c);save();L.close();renderView();toast('Category deleted');};
};
A.modEdit=d=>{
  const g=d.id?S.modGroups.find(x=>x.id===d.id):null;
  const st={name:g?g.name:'',req:g?g.req:false,multi:g?g.multi:false,opts:g?clone(g.opts):[['',0]]};
  const L=modal({title:g?'Edit option group':'New option group',body:`<div id="mgB"></div>`,foot:`${g?`<button class="btn btn-danger" id="mgDel">Delete</button>`:''}<span class="spacer"></span><button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="mgGo">Save</button>`});
  const read=()=>{const b=L.el;st.name=b.querySelector('#mgN').value;st.req=b.querySelector('#mgR').checked;st.multi=b.querySelector('#mgM').checked;st.opts=$$('.opt-row',b).map(r=>[r.querySelector('.on').value,+r.querySelector('.op').value||0]);};
  const draw=()=>{L.el.querySelector('#mgB').innerHTML=`<label class="field"><span>Group name</span><input class="input" id="mgN" value="${esc(st.name)}" placeholder="For example, Milk"></label>
    <div class="row mt">${sw(st.req,'id="mgR"','Customer must choose')}${sw(st.multi,'id="mgM"','Allow more than one')}</div>
    <div class="field mt"><span>Choices and extra price</span><div class="opt-rows">${st.opts.map(([n,p],i)=>`<div class="opt-row"><input class="input on" value="${esc(n)}" placeholder="Choice"><input class="input op num" type="number" step="0.05" min="0" value="${p}"><button class="btn btn-icon btn-ghost" data-rm="${i}" aria-label="Remove">${ic('x',16)}</button></div>`).join('')}</div><button class="btn btn-sm" id="mgAdd" style="justify-self:start">${ic('plus',14)} Add a choice</button></div>`;};
  L.el.addEventListener('click',e=>{if(e.target.closest('#mgAdd')){read();st.opts.push(['',0]);draw();}const rm=e.target.closest('[data-rm]');if(rm){read();st.opts.splice(+rm.dataset.rm,1);draw();}});
  L.el.querySelector('#mgGo').onclick=()=>{read();const opts=st.opts.filter(o=>o[0].trim()).map(o=>[o[0].trim(),r2(o[1])]);if(!st.name.trim()||!opts.length){toast('Add a name and at least one choice','warn');return;}if(g)Object.assign(g,{name:st.name.trim(),req:st.req,multi:st.multi,opts});else S.modGroups.push({id:uid('m'),name:st.name.trim(),req:st.req,multi:st.multi,opts});save();L.close();renderView();toast('Options saved');};
  const del=L.el.querySelector('#mgDel');if(del)del.onclick=()=>{S.modGroups=S.modGroups.filter(x=>x!==g);S.products.forEach(p=>p.mods=(p.mods||[]).filter(x=>x!==g.id));save();L.close();renderView();toast('Option group deleted');};
  draw();
};

/* =====================================================================
   CUSTOMERS
   ===================================================================== */
VIEWS.customers=()=>{
  const q=U.cust.q.toLowerCase(),cs=S.customers;
  const t30=dayStart(-29),active=cs.filter(c=>c.last&&c.last>=t30).length;
  const counts={gold:0,silver:0,bronze:0};cs.forEach(c=>counts[tierOf(c).k]++);
  const list=cs.filter(c=>(U.cust.tier==='all'||tierOf(c).k===U.cust.tier)&&(!q||c.name.toLowerCase().includes(q)||c.phone.includes(q)||(c.email||'').toLowerCase().includes(q))).sort((a,b)=>b.spend-a.spend);
  const L=S.settings.loyalty;
  return`<div class="page"><div class="page-head"><div><h2>Customers</h2><p class="sub">${cs.length} members, ${active} visited in the last 30 days. They earn ${L.earn} point per ${S.settings.currency.trim()}1 and swap ${L.redeemPts} points for ${money(L.redeemVal)} off.</p></div><div class="ph-actions"><button class="btn btn-primary" data-act="custNew">${ic('plus',16)} New customer</button></div></div>
   <div class="strip" style="--n:4;margin-bottom:16px">
    <div><div class="k-l">Members</div><div class="k-v num">${cs.length}</div><div class="k-s">${active} active this month</div></div>
    <div><div class="k-l">Spend per visit</div><div class="k-v num">${money(sum(cs,c=>c.spend)/Math.max(1,sum(cs,c=>c.visits)))}</div><div class="k-s">Across all members</div></div>
    <div><div class="k-l">Points to redeem</div><div class="k-v num">${sum(cs,c=>c.points).toLocaleString('en-GB')}</div><div class="k-s">Worth ${money(sum(cs,c=>c.points)/L.redeemPts*L.redeemVal)}</div></div>
    <div><div class="k-l">Ready for a reward</div><div class="k-v num">${cs.filter(c=>c.points>=L.redeemPts).length}</div><div class="k-s">${L.redeemPts}+ points</div></div>
   </div>
   <div class="row" style="margin-bottom:14px"><div class="seg">${[['all','Everyone',cs.length],['gold','Gold',counts.gold],['silver','Silver',counts.silver],['bronze','Bronze',counts.bronze]].map(([k,l,n])=>`<button class="${U.cust.tier===k?'on':''}" data-act="custTier" data-t="${k}">${k!=='all'?`<i class="dot" style="background:${({gold:'#E0A800',silver:'#8E9AAB',bronze:'#C07A45'})[k]}"></i>`:''}${l} <span class="faint num">${n}</span></button>`).join('')}</div>
    <label class="search" style="max-width:340px">${ic('search',18)}<input data-in="custSearch" value="${esc(U.cust.q)}" placeholder="Name, phone or email"></label><span class="hint">Gold from ${money(300,0)} spent, Silver from ${money(120,0)}</span></div>
   <div class="panel"><div class="tbl-wrap" id="custTbl">${custTable(list)}</div></div></div>`;
};
function custTable(list){
  if(!list.length)return`<div class="empty"><div class="e-ic">${ic('heart',24)}</div><h3>${S.customers.length?'No one matches':'No customers yet'}</h3><p>${S.customers.length?'Try another search.':'Add a customer at the till to start rewarding regulars.'}</p></div>`;
  return`<table class="tbl"><thead><tr><th>Customer</th><th>Tier</th><th class="r">Visits</th><th class="r">Spent</th><th class="r">Points</th><th>Last visit</th></tr></thead><tbody>${list.map(c=>`<tr class="click" data-act="custOpen" data-id="${c.id}"><td><div class="it-cell"><span class="av" style="--c:#7A5AC8">${initials(c.name)}</span><div><b>${esc(c.name)}</b><small>${esc(c.phone)}</small></div></div></td><td>${tierBadge(c)}</td><td class="r num">${c.visits}</td><td class="r num">${money(c.spend)}</td><td class="r num">${c.points>=S.settings.loyalty.redeemPts?`<span class="badge ok">${c.points}</span>`:c.points}</td><td>${c.last?ago(c.last):'<span class="faint">Not yet</span>'}</td></tr>`).join('')}</tbody></table>`;
}
A.custTier=d=>{U.cust.tier=d.t;renderView();};
IN.custSearch=v=>{U.cust.q=v;const q=v.toLowerCase();$('#custTbl').innerHTML=custTable(S.customers.filter(c=>(U.cust.tier==='all'||tierOf(c).k===U.cust.tier)&&(!q||c.name.toLowerCase().includes(q)||c.phone.includes(q)||(c.email||'').toLowerCase().includes(q))).sort((a,b)=>b.spend-a.spend));};
A.custOpen=d=>openCustDrawer(d.id);
A.custNew=()=>editCustomer();
function openCustDrawer(id){
  const c=cust(id);if(!c)return;
  const os=S.orders.filter(o=>o.custId===c.id&&o.status!=='open').sort((a,b)=>b.ts-a.ts);
  const fav={};os.forEach(o=>o.items.forEach(l=>fav[l.name]=(fav[l.name]||0)+l.qty));
  const favs=Object.entries(fav).sort((a,b)=>b[1]-a[1]).slice(0,3);
  drawer({title:esc(c.name),body:`<div class="row" style="margin-bottom:14px">${tierBadge(c)}<span class="muted">Member since ${fmtDay(c.created)}</span></div>
    <div class="stats-2"><div><b class="num">${c.visits}</b><span>Visits</span></div><div><b class="num">${money(c.spend)}</b><span>Spent</span></div><div><b class="num">${c.points}</b><span>Points</span></div><div><b class="num">${money(c.visits?c.spend/c.visits:0)}</b><span>Per visit</span></div></div>
    <div class="mt"><div class="muted" style="font-size:13px;font-weight:600;margin-bottom:6px">Contact</div><div>${esc(c.phone)}</div><div>${esc(c.email||'')}</div>${c.notes?`<p class="muted mt">${esc(c.notes)}</p>`:''}</div>
    ${favs.length?`<div class="mt"><div class="muted" style="font-size:13px;font-weight:600;margin-bottom:6px">Usually orders</div><div class="chips">${favs.map(([n,q])=>`<span class="badge">${esc(n)}, ${q}</span>`).join('')}</div></div>`:''}
    <div class="mt"><div class="muted" style="font-size:13px;font-weight:600;margin-bottom:6px">Recent orders</div><div class="panel"><div class="list">${os.slice(0,8).map(o=>`<div class="li click" data-act="openOrder" data-id="${o.id}"><div class="li-t"><b>Order ${o.no}</b><small>${fmtDT(o.ts)}, ${sum(o.items,l=>l.qty)} items</small></div><b class="num">${money(o.total)}</b></div>`).join('')||'<div class="li muted">No orders yet</div>'}</div></div></div>`,
   foot:`${can('pos')?`<button class="btn btn-primary" data-act="custSale" data-id="${c.id}">${ic('register',16)} Start a sale</button>`:''}<button class="btn" data-act="custPts" data-id="${c.id}">Adjust points</button><span class="spacer"></span><button class="btn" data-act="custEdit" data-id="${c.id}">${ic('edit',16)} Edit</button>`});
}
A.custSale=d=>{closeAll();if(U.cart.items.length&&!U.cart.orderId)A.hold();U.cart=newCart();U.cart.custId=d.id;go('pos');};
A.custEdit=d=>{closeAll();editCustomer(d.id);};
A.custPts=async d=>{const c=cust(d.id);const v=await promptBox({title:'Adjust points',label:`${c.name} has ${c.points}. Add or remove (use a minus sign)`,type:'number',value:'',ok:'Adjust'});if(v===null||v==='')return;c.points=Math.max(0,c.points+Math.round(+v||0));save();closeAll();openCustDrawer(c.id);toast(`${first(c.name)} now has ${c.points} points`);};
function editCustomer(id,after){
  const c=id?cust(id):null;
  const L=modal({title:c?'Edit customer':'New customer',body:`<div class="fgrid"><label class="field span2"><span>Name</span><input class="input" id="cuN" value="${esc(c?c.name:'')}" autofocus autocomplete="off"></label><label class="field"><span>Mobile</span><input class="input num" id="cuP" type="tel" value="${esc(c?c.phone:'')}"></label><label class="field"><span>Email, for receipts</span><input class="input" id="cuE" type="email" value="${esc(c?c.email:'')}"></label><label class="field span2"><span>Notes</span><input class="input" id="cuNo" value="${esc(c?c.notes:'')}" placeholder="For example, prefers oat milk"></label></div>`,
   foot:`${c?`<button class="btn btn-danger" id="cuDel">Delete</button>`:''}<span class="spacer"></span><button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="cuGo">${c?'Save':'Add customer'}</button>`});
  L.el.querySelector('#cuGo').onclick=()=>{const n=L.el.querySelector('#cuN').value.trim();if(!n){toast('Add a name','warn');return;}const data={name:n,phone:L.el.querySelector('#cuP').value.trim(),email:L.el.querySelector('#cuE').value.trim(),notes:L.el.querySelector('#cuNo').value.trim()};let x=c;if(c)Object.assign(c,data);else{x={id:uid('c'),...data,created:Date.now(),points:0,visits:0,spend:0,last:null};S.customers.push(x);}save();L.close();if(U.view==='customers')renderView();toast(c?'Customer saved':`${first(n)} joined the loyalty scheme`);after&&after(x);};
  const del=L.el.querySelector('#cuDel');if(del)del.onclick=async()=>{if(!await confirmBox({title:`Delete ${c.name}?`,text:'Their points are lost. Past orders stay in your history without their name.',ok:'Delete customer',danger:true}))return;S.customers=S.customers.filter(x=>x!==c);save();L.close();renderView();toast('Customer deleted');};
}

/* =====================================================================
   TEAM
   ===================================================================== */
function hoursIn(eid,from,to){return sum(S.shifts.filter(s=>s.emp===eid&&s.in<to&&(s.out||Date.now())>from),s=>Math.max(0,Math.min(to,s.out||Date.now())-Math.max(from,s.in)))/HOUR;}
function salesBy(eid,from,to){return S.orders.filter(o=>o.empId===eid&&o.status==='paid'&&o.ts>=from&&o.ts<to);}
VIEWS.team=()=>{
  const tab=U.team.tab,ws=weekStart(0),we=ws+7*DAY,now=Date.now();
  const tabs=`<div class="seg">${[['team','Team'],['time','Timesheets'],['perm','Permissions']].map(([k,l])=>`<button class="${tab===k?'on':''}" data-act="tmTab" data-t="${k}">${l}</button>`).join('')}</div>`;
  let body='';
  if(tab==='team'){
    body=`<div class="cards">${S.employees.map(e=>{const sh=onShift(e.id),h=hoursIn(e.id,ws,we),so=salesBy(e.id,ws,we);return`<div class="panel person" style="${e.active===false?'opacity:.55':''}">
      <div class="person-top"><span class="av lg" style="--c:${e.color}">${initials(e.name)}</span><div class="pt"><b>${esc(e.name)}</b><small>${esc(e.position||'')}</small></div><span class="badge ${e.role==='owner'?'accent':e.role==='manager'?'info':''}">${esc(roleLabel(e.role))}</span></div>
      <div class="shift-line">${sh?`<i class="dot ok"></i>On shift since ${fmtT(sh.in)}, <span data-since="${sh.in}" data-fmt="dur">${fmtHrs((Date.now()-sh.in)/HOUR)}</span>`:`<i class="dot"></i>${e.active===false?'Inactive':'Off shift'}`}</div>
      <div class="pstats"><div><b class="num">${fmtHrs(h)}</b><span>This week</span></div><div><b class="num">${moneyK(sum(so,o=>o.total))}</b><span>Sales</span></div><div><b class="num">${so.length}</b><span>Orders</span></div></div>
      <div class="row">${can('team')&&e.active!==false?`<button class="btn btn-sm" data-act="tmClock" data-id="${e.id}">${sh?'Clock out':'Clock in'}</button>`:''}<span class="spacer"></span>${(e.role!=='owner'||me().role==='owner')?`<button class="btn btn-sm btn-ghost" data-act="tmEdit" data-id="${e.id}">${ic('edit',16)} Edit</button>`:''}</div></div>`;}).join('')}
      <button class="panel" data-act="tmEdit" style="display:grid;place-items:center;min-height:200px;border-style:dashed;color:var(--muted);font-weight:600;gap:8px">${ic('plus',24)}Add a team member</button></div>`;
  }else if(tab==='time'){
    const off=U.team.week,a=weekStart(off),b=a+7*DAY;
    const days=[...Array(7)].map((_,i)=>a+i*DAY);
    const rows=S.employees.filter(e=>e.role!=='owner'||hoursIn(e.id,a,b)>0).map(e=>{const hs=days.map(d=>hoursIn(e.id,d,d+DAY));const tot=sum(hs);return{e,hs,tot,cost:tot*(e.rate||0)};});
    const sales=sum(S.orders.filter(o=>o.status==='paid'&&o.ts>=a&&o.ts<b),o=>o.total-o.tax),wages=sum(rows,r=>r.cost),lab=sales?wages/sales:0;
    const lk=lab<.25?'ok':lab<.32?'warn':'bad';
    body=`<div class="row" style="margin-bottom:14px"><div class="seg"><button class="${off===0?'on':''}" data-act="tmWeek" data-w="0">This week</button><button class="${off===-1?'on':''}" data-act="tmWeek" data-w="-1">Last week</button><button class="${off===-2?'on':''}" data-act="tmWeek" data-w="-2">Two weeks ago</button></div><span class="spacer"></span><span class="muted">Wages ${money(wages)} against ${money(sales)} net sales</span><span class="badge ${lk}" data-tip="Labour cost as a share of sales after tax. Under 25% is healthy for a café, 25 to 32% needs watching.">Labour ${pct(lab,1)}</span></div>
     <div class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Team member</th>${days.map(d=>`<th class="r">${new Date(d).toLocaleDateString('en-GB',{weekday:'short',day:'numeric'})}</th>`).join('')}<th class="r">Hours</th><th class="r">Rate</th><th class="r">Wages</th></tr></thead><tbody>
     ${rows.map(r=>`<tr><td><div class="it-cell"><span class="av" style="--c:${r.e.color}">${initials(r.e.name)}</span><b>${esc(r.e.name)}</b></div></td>${r.hs.map(h=>`<td class="r num ${h?'':'faint'}">${h?h.toFixed(1):'–'}</td>`).join('')}<td class="r num"><b>${r.tot.toFixed(1)}</b></td><td class="r num">${r.e.rate?money(r.e.rate):'<span class="faint">–</span>'}</td><td class="r num">${money(r.cost)}</td></tr>`).join('')}
     </tbody><tfoot><tr><td>Total</td>${days.map((d,i)=>`<td class="r num">${sum(rows,r=>r.hs[i]).toFixed(1)}</td>`).join('')}<td class="r num">${sum(rows,r=>r.tot).toFixed(1)}</td><td></td><td class="r num">${money(wages)}</td></tr></tfoot></table></div></div>`;
  }else{
    const roles=['manager','staff'];
    body=`<p class="muted" style="margin-bottom:14px">Owners can always do everything. When someone lacks a permission, the till asks for a manager’s PIN instead of blocking them.</p>
     <div class="panel"><div class="tbl-wrap"><table class="tbl perm-t"><thead><tr><th>Permission</th><th>Owner</th>${roles.map(r=>`<th>${esc(roleLabel(r))}</th>`).join('')}</tr></thead><tbody>
     ${PERMS.map(([k,l])=>`<tr><td>${l}</td><td><input type="checkbox" class="cbx" checked disabled aria-label="Owner: ${l}"></td>${roles.map(r=>`<td><input type="checkbox" class="cbx" data-ch="perm" data-r="${r}" data-p="${k}" ${S.roles[r].perms.includes(k)?'checked':''} ${!can('team')||(r==='manager'&&me().role!=='owner')?'disabled':''} aria-label="${esc(roleLabel(r))}: ${l}"></td>`).join('')}</tr>`).join('')}
     </tbody></table></div></div>`;
  }
  const on=S.employees.filter(e=>onShift(e.id)).length;
  return`<div class="page"><div class="page-head"><div><h2>Team</h2><p class="sub">${S.employees.filter(e=>e.active!==false).length} people, ${on} on shift now</p></div><div class="ph-actions">${tabs}</div></div>${body}</div>`;
};
A.tmTab=d=>{U.team.tab=d.t;renderView();};
A.tmWeek=d=>{U.team.week=+d.w;renderView();};
A.tmClock=d=>{const e=emp(d.id);if(onShift(e.id)){clockOut(e.id);toast(`${first(e.name)} clocked out`);}else{clockIn(e.id);toast(`${first(e.name)} clocked in`);}renderView();};
CH.perm=(v,el)=>{const r=S.roles[el.dataset.r],p=el.dataset.p;if(el.checked){if(!r.perms.includes(p))r.perms.push(p);}else r.perms=r.perms.filter(x=>x!==p);save();toast(`${r.label}s ${el.checked?'can now':'can no longer'} ${permLabel(p).toLowerCase()}`);};
A.tmEdit=d=>{
  const e=d.id?emp(d.id):null;let color=e?e.color:EMP_COLORS[S.employees.length%EMP_COLORS.length];
  const L=modal({title:e?esc(e.name):'Add a team member',body:`<div class="fgrid">
    <label class="field span2"><span>Full name</span><input class="input" id="eN" value="${esc(e?e.name:'')}" autofocus autocomplete="off"></label>
    <label class="field"><span>Job title</span><input class="input" id="eP" value="${esc(e?e.position:'')}" placeholder="For example, Barista"></label>
    <label class="field"><span>Role</span><select class="input" id="eR" ${e&&e.role==='owner'?'disabled':''}>${e&&e.role==='owner'?'<option value="owner">Owner</option>':''}<option value="staff" ${e&&e.role==='staff'?'selected':''}>Staff</option><option value="manager" ${e&&e.role==='manager'?'selected':''}>Manager</option></select></label>
    <label class="field"><span>4-digit PIN</span><input class="input num" id="ePin" inputmode="numeric" maxlength="4" value="${esc(e?e.pin:'')}" autocomplete="off"></label>
    <label class="field"><span>Hourly rate</span><input class="input num" id="eRate" type="number" step="0.01" min="0" value="${e?e.rate:12.21}"></label>
    <div class="field span2"><span>Colour</span><div class="swatches">${EMP_COLORS.map(x=>`<button class="swatch sm ${x===color?'on':''}" style="--sw:${x}" data-c="${x}" aria-label="Colour"></button>`).join('')}</div></div>
    ${e&&e.role!=='owner'?`<div class="span2">${sw(e.active!==false,'id="eA"','Active, can sign in')}</div>`:''}</div>`,
   foot:`<span class="spacer"></span><button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="eGo">${e?'Save':'Add to the team'}</button>`});
  L.el.addEventListener('click',ev=>{const s=ev.target.closest('[data-c]');if(s){color=s.dataset.c;$$('[data-c]',L.el).forEach(b=>b.classList.toggle('on',b===s));}});
  L.el.querySelector('#eGo').onclick=()=>{
    const n=L.el.querySelector('#eN').value.trim(),pin=L.el.querySelector('#ePin').value.trim();
    if(!n){toast('Add their name','warn');return;}
    if(!/^\d{4}$/.test(pin)){toast('The PIN needs exactly 4 digits','warn');return;}
    if(S.employees.some(x=>x.pin===pin&&x!==e)){toast('Someone else already uses that PIN','warn');return;}
    const data={name:n,position:L.el.querySelector('#eP').value.trim(),pin,rate:r2(+L.el.querySelector('#eRate').value||0),color};
    if(!e||e.role!=='owner')data.role=L.el.querySelector('#eR').value;
    const a=L.el.querySelector('#eA');if(a)data.active=a.checked;
    if(e)Object.assign(e,data);else S.employees.push({id:uid('e'),active:true,...data});
    save();L.close();renderView();toast(e?'Saved':`${first(n)} can now sign in with their PIN`);
  };
};

/* =====================================================================
   CASH DRAWER
   ===================================================================== */
function drawerNumbers(sess){
  const from=sess.ts,to=sess.closedTs||Date.now();
  const inRange=S.orders.filter(o=>o.ts>=from&&o.ts<to&&o.status!=='open'&&o.status!=='void');
  const cashSales=sum(inRange,o=>sum(o.payments.filter(p=>p.m==='cash'),p=>p.a));
  const refunds=sum(S.orders.filter(o=>o.status==='refunded'&&o.refund&&o.refund.ts>=from&&o.refund.ts<to),o=>sum(o.payments.filter(p=>p.m==='cash'),p=>p.a));
  const pin=sum(sess.moves.filter(m=>m.kind==='in'),m=>m.amount),pout=sum(sess.moves.filter(m=>m.kind==='out'),m=>m.amount);
  return{float:sess.float,cashSales:r2(cashSales),refunds:r2(refunds),pin:r2(pin),pout:r2(pout),expected:r2(sess.float+cashSales-refunds+pin-pout),cardSales:r2(sum(inRange,o=>sum(o.payments.filter(p=>p.m==='card'),p=>p.a)))};
}
const varBadge=v=>{const a=Math.abs(v);return`<span class="badge ${a<0.01?'ok':a<=5?'warn':'bad'}">${a<0.01?'Balanced':(v>0?'Over ':'Short ')+money(a)}</span>`;};
VIEWS.cash=()=>{
  const d=S.drawer.open,hist=[...S.drawer.history].reverse();
  let top='';
  if(!d){
    top=`<div class="panel"><div class="panel-b" style="display:grid;gap:16px;max-width:560px"><div><h3 style="font-size:20px;font-family:var(--f-display)">The drawer is closed</h3><p class="muted" style="margin-top:4px">Count the float into the drawer and open it before taking cash.</p></div><label class="field"><span>Opening float</span><input class="input num" id="flt" type="number" step="0.01" min="0" value="${S.settings.defaultFloat}" style="max-width:220px"></label><div><button class="btn btn-primary btn-lg" data-act="drOpen">${ic('drawer',18)} Open the drawer</button></div></div></div>`;
  }else{
    const n=drawerNumbers(d);
    top=`<div class="grid g-73"><div class="panel"><div class="panel-h"><h3>Open since ${fmtT(d.ts)}</h3><span class="ph-sub">Opened by ${esc(first((emp(d.by)||{}).name||''))}</span></div><div class="panel-b">
      <div class="muted" style="font-weight:600;font-size:13px">Should be in the drawer</div><div class="big-figure num" style="margin:6px 0 18px">${money(n.expected)}</div>
      <div class="stats-2"><div><b class="num">${money(n.float)}</b><span>Opening float</span></div><div><b class="num">${money(n.cashSales)}</b><span>Cash sales</span></div><div><b class="num">${money(n.pin)}</b><span>Paid in</span></div><div><b class="num">−${money(n.pout+n.refunds)}</b><span>Paid out and refunds</span></div></div>
      <div class="row mt"><button class="btn" data-act="drMove" data-k="in">${ic('plus',16)} Pay in</button><button class="btn" data-act="drMove" data-k="out">${ic('minus',16)} Pay out</button><button class="btn" data-act="drNoSale">${ic('drawer',16)} Open drawer, no sale</button><span class="spacer"></span><button class="btn btn-primary" data-act="drClose">Count and close</button></div>
     </div></div>
     <div class="panel"><div class="panel-h"><h3>Movements</h3><span class="ph-sub">Card takings this session ${money(n.cardSales)}</span></div><div class="panel-b flush"><div class="list">${d.moves.length?[...d.moves].reverse().map(m=>`<div class="li"><span class="sevbar ${m.kind==='in'?'ok':m.kind==='out'?'warn':'info'}"></span><div class="li-t"><b>${m.kind==='in'?'Paid in':m.kind==='out'?'Paid out':'No sale'}${m.reason?': '+esc(m.reason):''}</b><small>${fmtT(m.ts)} by ${esc(first((emp(m.by)||{}).name||''))}</small></div>${m.amount?`<b class="num">${m.kind==='out'?'−':''}${money(m.amount)}</b>`:''}</div>`).join(''):'<div class="li muted">No pay-ins or pay-outs yet</div>'}</div></div></div></div>`;
  }
  return`<div class="page"><div class="page-head"><div><h2>Cash drawer</h2><p class="sub">Track the float, pay-ins and pay-outs, then count up at close.</p></div></div>${top}
   <div class="panel mt"><div class="panel-h"><h3>Previous sessions</h3></div><div class="panel-b flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Day</th><th>Open</th><th>Closed by</th><th class="r">Expected</th><th class="r">Counted</th><th>Result</th><th></th></tr></thead><tbody>
    ${hist.map(h=>`<tr><td>${fmtD(h.ts)}</td><td class="num">${fmtT(h.ts)} to ${fmtT(h.closedTs)}</td><td>${esc(first((emp(h.closedBy)||{}).name||''))}</td><td class="r num">${money(h.expected)}</td><td class="r num">${money(h.counted)}</td><td>${varBadge(h.variance)}</td><td class="r"><button class="btn btn-sm btn-ghost" data-act="zFor" data-t="${dayStart(0,h.ts)}">Day report</button></td></tr>`).join('')||'<tr><td colspan="7" class="muted">No closed sessions yet</td></tr>'}
   </tbody></table></div></div></div></div>`;
};
A.drOpen=()=>{const f=r2(+($('#flt')||{}).value||0);S.drawer.open={id:uid('dr'),ts:Date.now(),float:f,by:U.user,moves:[]};save();renderView();toast(`Drawer opened with a ${money(f)} float`);};
A.drMove=async d=>{
  const v=await promptBox({title:d.k==='in'?'Pay money in':'Pay money out',label:'Amount',type:'number',ok:d.k==='in'?'Pay in':'Pay out'});if(v===null)return;
  const amt=r2(+v||0);if(amt<=0){toast('Enter an amount above zero','warn');return;}
  const reason=await promptBox({title:'What’s it for?',label:'Reason',placeholder:d.k==='in'?'For example, change from the bank':'For example, window cleaner',ok:'Save'});if(reason===null)return;
  S.drawer.open.moves.push({ts:Date.now(),kind:d.k,amount:amt,reason:reason.trim(),by:U.user});save();renderView();toast(`${money(amt)} paid ${d.k}`);
};
A.drNoSale=()=>{S.drawer.open.moves.push({ts:Date.now(),kind:'nosale',amount:0,reason:'',by:U.user});save();renderView();toast('Drawer opened. No sale recorded against your name.','info');};
A.drClose=()=>openCloseDrawer();
function openCloseDrawer(){
  const d=S.drawer.open;if(!d)return;const n=drawerNumbers(d);
  const den=[50,20,10,5,2,1,.5,.2,.1,.05,.02,.01],cnt={};
  const L=modal({title:'Count the drawer',cls:'wide',sub:`Count each note and coin. The till expects ${money(n.expected)}.`,body:`<div class="denoms">${den.map(v=>`<label class="denom"><b>${v>=1?money(v,0):Math.round(v*100)+'p'}</b><input class="input num" type="number" min="0" inputmode="numeric" data-dn="${v}" placeholder="0" aria-label="Number of ${v>=1?money(v,0):Math.round(v*100)+'p'}"></label>`).join('')}</div><div class="change-line mt" id="cntRes"></div>`,
   foot:`<button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="cntGo">Close the drawer</button>`});
  const upd=()=>{const tot=r2(sum(den,v=>v*(cnt[v]||0))),vr=r2(tot-n.expected);const el=L.el.querySelector('#cntRes');el.className='change-line mt '+(Math.abs(vr)>5?'short':'');el.innerHTML=`<span>Counted ${money(tot)}</span><span>${Math.abs(vr)<0.01?'Balanced':(vr>0?'Over by ':'Short by ')+money(Math.abs(vr))}</span>`;return{tot,vr};};
  L.el.addEventListener('input',e=>{const i=e.target.closest('[data-dn]');if(i){cnt[i.dataset.dn]=Math.max(0,Math.floor(+i.value||0));upd();}});upd();
  L.el.querySelector('#cntGo').onclick=async()=>{const {tot,vr}=upd();if(tot===0&&!await confirmBox({title:'Close with nothing counted?',text:'You haven’t entered any cash. The session will close as short by the full amount.',ok:'Close anyway',danger:true}))return;
    S.drawer.history.push({...d,closedTs:Date.now(),expected:n.expected,counted:tot,variance:vr,closedBy:U.user});S.drawer.open=null;save();L.close();renderView();toast(Math.abs(vr)<0.01?'Drawer closed and balanced':`Drawer closed, ${vr>0?'over':'short'} by ${money(Math.abs(vr))}`,Math.abs(vr)>5?'warn':'');showZ(dayStart(0));};
}
A.zFor=d=>showZ(+d.t);

/* =====================================================================
   SETTINGS
   ===================================================================== */
const SET_TABS=[['business','Business','home'],['tax','Tax & receipts','receipt'],['features','Features','tables'],['loyalty','Loyalty','heart'],['kiosk','Kiosk','kiosk'],['look','Appearance','sun'],['devices','Devices','printer'],['data','Data','box']];
VIEWS.settings=()=>{
  const s=S.settings,t=U.set.tab;
  const row=(title,sub,ctrl)=>`<div class="set-row"><div class="sr-t"><b>${title}</b>${sub?`<small>${sub}</small>`:''}</div>${ctrl}</div>`;
  const tog=(k,title,sub)=>row(title,sub,sw(getPath(s,k),`data-ch="set" data-k="${k}" data-t="bool" aria-label="${esc(title)}"`));
  let b='';
  if(t==='business')b=`<div class="panel"><div class="panel-b"><div class="fgrid">
    <label class="field span2"><span>Business name</span><input class="input" data-ch="set" data-k="name" value="${esc(s.name)}"></label>
    <label class="field span2"><span>Address</span><input class="input" data-ch="set" data-k="address" value="${esc(s.address)}"></label>
    <label class="field"><span>Phone</span><input class="input" data-ch="set" data-k="phone" value="${esc(s.phone)}"></label>
    <label class="field"><span>${esc(s.taxName)} registration number</span><input class="input" data-ch="set" data-k="vatNo" value="${esc(s.vatNo)}" placeholder="Shown on receipts"></label>
    <label class="field"><span>Opens at</span><select class="input" data-ch="set" data-k="openHour" data-t="num">${[...Array(24)].map((_,h)=>`<option value="${h}" ${s.openHour===h?'selected':''}>${String(h).padStart(2,'0')}:00</option>`).join('')}</select></label>
    <label class="field"><span>Closes at</span><select class="input" data-ch="set" data-k="closeHour" data-t="num">${[...Array(24)].map((_,h)=>`<option value="${h+1}" ${s.closeHour===h+1?'selected':''}>${String(h+1).padStart(2,'0')}:00</option>`).join('')}</select></label>
   </div></div></div>`;
  else if(t==='tax')b=`<div class="grid g-73"><div class="panel"><div class="panel-b"><div class="fgrid">
    <label class="field span2"><span>Currency</span><select class="input" data-ch="set" data-k="currency">${CURRENCIES.map(([v,l])=>`<option value="${esc(v)}" ${s.currency===v?'selected':''}>${l}</option>`).join('')}</select></label>
    <label class="field"><span>Tax name</span><input class="input" data-ch="set" data-k="taxName" value="${esc(s.taxName)}"></label>
    <label class="field"><span>Rate (%)</span><input class="input num" type="number" step="0.5" min="0" max="50" data-ch="set" data-k="taxRate" data-t="num" value="${s.taxRate}"></label>
    <div class="span2">${sw(s.taxInclusive,'data-ch="set" data-k="taxInclusive" data-t="bool"','Prices include tax')}</div>
    <label class="field span2"><span>Receipt message</span><input class="input" data-ch="set" data-k="receiptFooter" value="${esc(s.receiptFooter)}"></label>
    <div class="span2 row">${sw(s.showTaxLine,'data-ch="set" data-k="showTaxLine" data-t="bool"','Show the tax line')}${sw(s.showBarcode,'data-ch="set" data-k="showBarcode" data-t="bool"','Print a barcode for returns')}</div>
   </div></div></div><div style="background:var(--sunken);border-radius:var(--r-lg);padding:20px 20px 30px">${receiptHTML(S.orders.filter(o=>o.status==='paid').slice(-1)[0]||{no:S.seq,ts:Date.now(),items:[],subtotal:0,discAmt:0,tax:0,total:0,tip:0,payments:[],status:'paid',type:hospitality()?'takeaway':'instore'})}</div></div>`;
  else if(t==='features')b=`<div class="panel"><div class="panel-b">${tog('tables','Tables and floor plan','Seat parties, run tabs and send courses to the kitchen')}${tog('kitchen','Kitchen display','Orders appear as tickets for the kitchen to bump')}${tog('tipping','Ask for tips','Show tip options when a customer pays')}${tog('kioskEnabled','Customer kiosk','Let customers order and pay themselves')}
    ${row('Lock the till when idle','Protects the till if someone walks away',`<select class="input" style="width:auto" data-ch="set" data-k="autoLock" data-t="num">${[[0,'Never'],[2,'After 2 minutes'],[5,'After 5 minutes'],[10,'After 10 minutes'],[30,'After 30 minutes']].map(([v,l])=>`<option value="${v}" ${s.autoLock===v?'selected':''}>${l}</option>`).join('')}</select>`)}
    ${row('Default cash float','Suggested when opening the drawer',`<input class="input num" style="width:120px" type="number" step="5" min="0" data-ch="set" data-k="defaultFloat" data-t="num" value="${s.defaultFloat}">`)}</div></div>`;
  else if(t==='loyalty')b=`<div class="panel"><div class="panel-b">${tog('loyalty.on','Loyalty points','Customers collect points on every order')}
    ${row(`Points per ${esc(s.currency.trim())}1 spent`,'',`<input class="input num" style="width:100px" type="number" min="0" step="1" data-ch="set" data-k="loyalty.earn" data-t="num" value="${s.loyalty.earn}">`)}
    ${row('Points for a reward','',`<input class="input num" style="width:100px" type="number" min="10" step="10" data-ch="set" data-k="loyalty.redeemPts" data-t="num" value="${s.loyalty.redeemPts}">`)}
    ${row('Reward value','Taken off the order total',`<input class="input num" style="width:100px" type="number" min="0.5" step="0.5" data-ch="set" data-k="loyalty.redeemVal" data-t="num" value="${s.loyalty.redeemVal}">`)}
    ${row('Tiers','Based on lifetime spend',`<div class="row"><span class="tier bronze">Bronze</span><span class="tier silver">Silver ${money(120,0)}+</span><span class="tier gold">Gold ${money(300,0)}+</span></div>`)}</div></div>`;
  else if(t==='kiosk')b=`<div class="panel"><div class="panel-b">${tog('kioskEnabled','Kiosk on','Show the kiosk in the menu and on the lock screen')}
    ${row('Welcome headline','The first thing customers read',`<input class="input" style="max-width:280px" data-ch="set" data-k="kioskWelcome" value="${esc(s.kioskWelcome)}">`)}
    ${tog('kioskUpsell','Suggest add-ons','Offer a pastry or treat before payment')}${hospitality()?tog('kioskEatIn','Ask eat in or take away','Skip this if you only do takeaway'):''}
    <div class="set-row"><div class="sr-t"><b>Try it</b><small>Leave kiosk mode with any team member’s PIN</small></div><button class="btn btn-primary" data-act="nav" data-v="kiosk">${ic('kiosk',16)} Launch the kiosk</button></div></div></div>`;
  else if(t==='look')b=`<div class="panel"><div class="panel-b" style="display:grid;gap:22px"><div class="field"><span>Accent colour</span><div class="swatches">${Object.entries(ACCENTS).map(([k,a])=>`<button class="swatch ${s.accent===k?'on':''}" style="--sw:${a.c};--swi:${a.ink}" data-act="setAccent" data-v="${k}" aria-label="${a.name}" aria-pressed="${s.accent===k}">${s.accent===k?ic('check',20):''}</button>`).join('')}</div></div>
    <div class="field"><span>Appearance</span><div class="seg">${[['light','Light'],['dark','Dark'],['system','Match this device']].map(([k,l])=>`<button class="${s.theme===k?'on':''}" data-act="setTheme" data-v="${k}">${l}</button>`).join('')}</div></div></div></div>`;
  else if(t==='devices')b=`<div class="panel"><div class="panel-b">${[['printer','Receipt printer','Thermal, 80mm, USB','ok','Connected','Print a test'],['card','Card reader','Contactless, chip and PIN, battery 82%','ok','Connected','Test a payment'],['drawer','Cash drawer','Opens with the receipt printer','ok','Connected','Open the drawer'],['chef','Kitchen printer','Backup for the kitchen display','warn','Not connected','Pair'],['wifi','Offline mode','Sales save on this device and sync when you’re back online','ok','Ready','']].map(([i,n,d,k,st,a])=>`<div class="device"><span class="dv-ic">${ic(i)}</span><div class="dv-t"><b>${n}</b><small>${d}</small></div><span class="badge ${k}">${st}</span>${a?`<button class="btn btn-sm" data-act="devTest" data-n="${n}">${a}</button>`:''}</div>`).join('')}</div></div>`;
  else b=`<div class="panel"><div class="panel-b">
    <div class="set-row"><div class="sr-t"><b>Download a backup</b><small>Everything in one JSON file: items, orders, customers and team</small></div><button class="btn" data-act="backup">${ic('download',16)} Download</button></div>
    <div class="set-row"><div class="sr-t"><b>Run setup again</b><small>Start from the setup wizard. Your current data is replaced.</small></div><button class="btn" data-act="reOnboard">Start setup</button></div>
    <div class="set-row"><div class="sr-t"><b>Reset to the demo café</b><small>Replace everything with fresh sample data</small></div><button class="btn btn-danger" data-act="resetDemo">Reset</button></div>
    <div class="set-row"><div class="sr-t"><b>Storage</b><small>${S.orders.length.toLocaleString('en-GB')} orders, ${S.products.length} items, ${S.customers.length} customers kept on this device</small></div></div></div></div>`;
  return`<div class="page"><div class="page-head"><div><h2>Settings</h2><p class="sub">Changes save as you make them.</p></div></div>
   <div class="set-layout"><nav class="set-nav" aria-label="Settings sections">${SET_TABS.map(([k,l,i])=>`<button class="${t===k?'on':''}" data-act="setTab" data-t="${k}">${ic(i,18)}${l}</button>`).join('')}</nav><div class="set-sec">${b}</div></div></div>`;
};
A.setTab=d=>{U.set.tab=d.t;renderView();};
CH.set=(v,el)=>{
  const k=el.dataset.k,t=el.dataset.t;let val=t==='bool'?el.checked:t==='num'?(+v||0):v;
  if(k==='name'&&!String(val).trim()){toast('Your business needs a name','warn');el.value=S.settings.name;return;}
  setPath(S.settings,k,val);save();
  if(['tables','kitchen','kioskEnabled','name'].includes(k))renderRail();
  if(k==='name')renderTopbar();
  if(['currency','taxName','taxRate','taxInclusive','receiptFooter','showTaxLine','showBarcode','name'].includes(k)&&U.set.tab==='tax')renderView();
  toast('Saved','',{ms:1400});
};
A.setAccent=d=>{S.settings.accent=d.v;applyTheme();save();renderView();};
A.setTheme=d=>{S.settings.theme=d.v;applyTheme();save();renderTopbar();renderView();};
A.devTest=d=>toast(`${d.n}: test sent and confirmed`);
A.backup=()=>offerDownload(`meridian-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(S,null,1));
A.reOnboard=async()=>{if(!await confirmBox({title:'Run setup again?',text:'Everything on this device is replaced by what you set up. Download a backup first if you want to keep it.',ok:'Start setup',danger:true}))return;wipeState();U.user=null;U.cart=null;showOnboarding();};
A.resetDemo=async()=>{if(!await confirmBox({title:'Reset to the demo café?',text:'All orders, items, customers and team members on this device are replaced with sample data.',ok:'Reset everything',danger:true}))return;const a=S.settings.accent,th=S.settings.theme;S=buildBusiness({name:'Ember & Oat',type:'cafe',address:'14 Market Row, Kingsbridge',currency:'£',taxName:'VAT',taxRate:20,taxInclusive:true,catalog:'sample',history:true,ownerName:'Jordan Reed',ownerPin:'1234',sampleStaff:true,accent:a,theme:th,demo:true});saveNow();U.cart=newCart();LK.sel=S.employees[0].id;showLock();toast('Demo café restored. Jordan’s PIN is 1234.','info');};
