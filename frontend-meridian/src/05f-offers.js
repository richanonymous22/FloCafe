/* ============================================================================
 * 05f-offers.js — automatic offers: the Offers tab (Items & stock) and the register's live saving
 * ----------------------------------------------------------------------------
 * The till server owns offers and applies them to a sale as its discount (GET/POST/PUT /api/offers). This file is
 * only the screen to set them up and the register's preview of what a basket would save (POST /api/offers/preview).
 * The pay screen still charges the server's own total.
 * ==========================================================================*/
U.of=U.of||{list:null,err:null,loading:false};
const ofEsc=esc;
const OF_DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const OF_KINDS={percent_off:'Percent off',amount_off:'Amount off each item',fixed_price:'Fixed price each',multi_buy_price:'Multi-buy price (3 for £5)',buy_get_free:'Buy some, get some free'};
const ofMoney=m=>money((+m||0)/100);
function ofCanManage(){const r=me()&&me().plemmoRole;return r==='owner'||r==='manager';}
async function offersLoad(){
  if(U.of.loading||!window.PlemmoAPI||!PlemmoAPI.isAuthenticated())return;
  U.of.loading=true;
  try{U.of.list=(await PlemmoAPI.get('/offers')).offers;U.of.err=null;}
  catch(e){U.of.err=(e&&e.data&&e.data.error)||'The offers could not be read.';U.of.list=U.of.list||[];}
  finally{U.of.loading=false;if(U.view==='items'&&U.items.tab==='offers')renderView();}
}
function offerRule(o){
  const what={percent_off:`${o.percent}% off`,amount_off:`${ofMoney(o.amount_minor)} off each`,fixed_price:`Each for ${ofMoney(o.price_minor)}`,multi_buy_price:`${o.bundle_qty} for ${ofMoney(o.price_minor)}`,buy_get_free:`Buy ${o.buy_qty}, get ${o.get_qty} free`}[o.kind]||o.kind;
  const scope=o.scope==='category'?`in ${esc((catOf(o.category_id)||{name:'a category'}).name)}`:o.scope==='products'?`on ${o.product_ids.slice(0,2).map(id=>esc((prod(id)||{name:'an item'}).name)).join(', ')}${o.product_ids.length>2?` and ${o.product_ids.length-2} more`:''}`:'on everything';
  return`${what} ${scope}`;
}
function offerWhen(o){
  const bits=[];
  if(o.starts_at||o.ends_at)bits.push(`${o.starts_at?fmtD(Date.parse(o.starts_at)):'now'} to ${o.ends_at?fmtD(Date.parse(o.ends_at)):'no end'}`);
  if(o.days_of_week&&o.days_of_week.length&&o.days_of_week.length<7)bits.push(o.days_of_week.map(d=>OF_DAYS[d]).join(', '));
  if(o.time_from&&o.time_to)bits.push(`${o.time_from} to ${o.time_to}`);
  if(o.customer_rule==='member')bits.push('customers only');
  if(o.customer_rule==='tier')bits.push(`${o.tiers.join('/')} members`);
  return bits.join('; ')||'Always';
}
function offersBody(){
  if(!ofCanManage())return`<div class="panel"><div class="panel-b"><p class="muted">Only an owner or manager sets up offers.</p></div></div>`;
  if(!U.of.list&&!U.of.loading)setTimeout(offersLoad,0);
  if(!U.of.list)return`<div class="panel"><div class="panel-b"><p class="muted">Loading offers…</p></div></div>`;
  const rows=U.of.list.map(o=>`<tr><td><b>${ofEsc(o.name)}</b><small class="muted" style="display:block">${offerRule(o)}</small></td><td>${ofEsc(offerWhen(o))}</td>
    <td>${o.is_active?'<span class="badge ok">On</span>':'<span class="badge">Off</span>'}</td>
    <td class="r"><span class="row" style="gap:6px;justify-content:flex-end"><button class="btn btn-sm" data-act="ofToggle" data-id="${o.id}">${o.is_active?'Switch off':'Switch on'}</button><button class="btn btn-sm" data-act="ofEdit" data-id="${o.id}">Edit</button><button class="btn btn-sm btn-ghost" data-act="ofDel" data-id="${o.id}" aria-label="Remove ${ofEsc(o.name)}">${ic('trash',14)}</button></span></td></tr>`).join('');
  return`<div class="panel"><div class="panel-b"><p class="muted" style="margin:0 0 10px">Offers are applied by the till on its own when a sale qualifies, and the saving shows on the receipt. An item takes part in one offer. A discount a person adds to a sale always replaces offers on that sale. ${U.of.err?`<span style="color:var(--bad-text)">${ofEsc(U.of.err)}</span>`:''}</p>
    <button class="btn btn-primary" data-act="ofEdit">${ic('plus',16)} New offer</button></div>
    <div class="tbl-wrap">${U.of.list.length?`<table class="tbl"><thead><tr><th>Offer</th><th>When</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`:`<div class="empty"><h3>No offers yet</h3><p>Try “3 for 2” on a product, or 10% off in the afternoon.</p></div>`}</div></div>`;
}
A.ofToggle=async d=>{const o=(U.of.list||[]).find(x=>x.id===d.id);if(!o)return;try{await PlemmoAPI.post('/offers/'+encodeURIComponent(o.id)+'/active',{active:!o.is_active},{idempotent:false});toast(o.is_active?'Offer switched off':'Offer switched on','ok');U.of.list=null;offersLoad();}catch(e){toast((e&&e.data&&e.data.error)||'That did not save','warn');}};
A.ofDel=async d=>{const o=(U.of.list||[]).find(x=>x.id===d.id);if(!o)return;if(!await confirmBox({title:`Remove “${o.name}”?`,text:'It stops applying. Past sales keep their record of it.',ok:'Remove',danger:true}))return;try{await PlemmoAPI.request('/offers/'+encodeURIComponent(o.id),{method:'DELETE',idempotent:false});toast('Offer removed','ok');U.of.list=null;offersLoad();}catch(e){toast((e&&e.data&&e.data.error)||'That did not remove','warn');}};
A.ofEdit=d=>{
  const o=d.id?(U.of.list||[]).find(x=>x.id===d.id):null;
  const v=(k,def='')=>o&&o[k]!=null?o[k]:def;
  const loc=iso=>iso?new Date(Date.parse(iso)-new Date(iso).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  const days=(o&&o.days_of_week)||[];
  const L=modal({title:o?ofEsc(o.name):'New offer',cls:'wide',body:`<div class="fgrid">
    <label class="field span2"><span>Name (shown on the receipt)</span><input class="input" id="ofN" maxlength="80" value="${ofEsc(v('name'))}" placeholder="For example, 3 for 2 on cakes"></label>
    <label class="field"><span>Type</span><select class="input" id="ofK">${Object.entries(OF_KINDS).map(([k,l])=>`<option value="${k}" ${v('kind','percent_off')===k?'selected':''}>${l}</option>`).join('')}</select></label>
    <div class="field" id="ofVals"></div>
    <label class="field"><span>Applies to</span><select class="input" id="ofS"><option value="all" ${v('scope','all')==='all'?'selected':''}>Everything</option><option value="category" ${v('scope')==='category'?'selected':''}>One category</option><option value="products" ${v('scope')==='products'?'selected':''}>Chosen items</option></select></label>
    <label class="field" id="ofCatF"><span>Category</span><select class="input" id="ofC">${S.categories.map(c=>`<option value="${c.id}" ${v('category_id')===c.id?'selected':''}>${ofEsc(c.name)}</option>`).join('')}</select></label>
    <label class="field span2" id="ofProdF"><span>Items (hold Ctrl or Cmd to pick several)</span><select class="input" id="ofP" multiple size="7">${S.products.map(p=>`<option value="${p.id}" ${(o&&o.product_ids||[]).includes(p.id)?'selected':''}>${ofEsc(p.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Starts (optional)</span><input class="input" id="ofFrom" type="datetime-local" value="${loc(v('starts_at',null))}"></label>
    <label class="field"><span>Ends (optional)</span><input class="input" id="ofTo" type="datetime-local" value="${loc(v('ends_at',null))}"></label>
    <div class="field span2"><span>Days (none ticked means every day)</span><div class="row" style="gap:10px">${OF_DAYS.map((n,i)=>`<label style="display:flex;gap:4px;align-items:center"><input type="checkbox" class="ofDay" value="${i}" ${days.includes(i)?'checked':''}> ${n}</label>`).join('')}</div></div>
    <label class="field"><span>Time from (optional)</span><input class="input" id="ofTF" type="time" value="${ofEsc(v('time_from'))}"></label>
    <label class="field"><span>Time to</span><input class="input" id="ofTT" type="time" value="${ofEsc(v('time_to'))}"></label>
    <label class="field"><span>Who gets it</span><select class="input" id="ofCu"><option value="any" ${v('customer_rule','any')==='any'?'selected':''}>Everyone</option><option value="member" ${v('customer_rule')==='member'?'selected':''}>Only when a customer is added to the sale</option><option value="tier" ${v('customer_rule')==='tier'?'selected':''}>Loyalty tiers</option></select></label>
    <div class="field" id="ofTiersF"><span>Tiers</span><div class="row" style="gap:10px">${['bronze','silver','gold'].map(t=>`<label style="display:flex;gap:4px;align-items:center"><input type="checkbox" class="ofTier" value="${t}" ${(o&&o.tiers||[]).includes(t)?'checked':''}> ${t[0].toUpperCase()+t.slice(1)}</label>`).join('')}</div></div>
    <label class="field"><span>Priority (higher goes first)</span><input class="input num" id="ofPr" type="number" min="-100" max="100" value="${v('priority',0)}"></label>
    <p class="hint span2" id="ofErr" style="color:var(--bad-text)" hidden></p></div>`,
   foot:`<span class="spacer"></span><button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="ofGo">${o?'Save':'Create the offer'}</button>`});
  const el=L.el,$o=id=>el.querySelector('#'+id);
  const vals=()=>{
    const k=$o('ofK').value,f=(id,l,val,step)=>`<span>${l}</span><input class="input num" id="${id}" type="number" min="0" step="${step||1}" value="${val==null?'':val}">`;
    $o('ofVals').innerHTML=k==='percent_off'?f('ofV1','Percent off',v('percent',''),0.5)
      :k==='amount_off'?f('ofV1',`Amount off each (${S.settings.currency.trim()})`,o&&o.amount_minor?o.amount_minor/100:'',0.01)
      :k==='fixed_price'?f('ofV1',`Price each (${S.settings.currency.trim()})`,o&&o.price_minor?o.price_minor/100:'',0.01)
      :k==='multi_buy_price'?`<span>Items in the bundle, and the price</span><span class="row" style="gap:8px"><input class="input num" id="ofV1" type="number" min="2" max="50" value="${v('bundle_qty','')}" placeholder="3" style="width:90px"><input class="input num" id="ofV2" type="number" min="0" step="0.01" value="${o&&o.price_minor?o.price_minor/100:''}" placeholder="5.00"></span>`
      :`<span>Buy, and get free</span><span class="row" style="gap:8px"><input class="input num" id="ofV1" type="number" min="1" max="50" value="${v('buy_qty','')}" placeholder="2" style="width:90px"><input class="input num" id="ofV2" type="number" min="1" max="50" value="${v('get_qty','')}" placeholder="1" style="width:90px"></span>`;
  };
  const show=()=>{const s=$o('ofS').value,c=$o('ofCu').value;$o('ofCatF').hidden=s!=='category';$o('ofProdF').hidden=s!=='products';$o('ofTiersF').hidden=c!=='tier';};
  $o('ofK').addEventListener('change',vals);$o('ofS').addEventListener('change',show);$o('ofCu').addEventListener('change',show);vals();show();
  $o('ofGo').onclick=async()=>{
    const k=$o('ofK').value,s=$o('ofS').value,c=$o('ofCu').value,body={name:$o('ofN').value.trim(),kind:k,scope:s,customer_rule:c,priority:Number($o('ofPr').value||0)};
    const n1=$o('ofV1')&&$o('ofV1').value,n2=$o('ofV2')&&$o('ofV2').value;
    if(k==='percent_off')body.percent=Number(n1);else if(k==='amount_off')body.amount=n1;else if(k==='fixed_price')body.price=n1;
    else if(k==='multi_buy_price'){body.bundle_qty=Number(n1);body.price=n2;}else{body.buy_qty=Number(n1);body.get_qty=Number(n2);}
    if(s==='category')body.category_id=$o('ofC').value;
    if(s==='products')body.product_ids=[...$o('ofP').selectedOptions].map(x=>x.value);
    if($o('ofFrom').value)body.starts_at=new Date($o('ofFrom').value).toISOString();
    if($o('ofTo').value)body.ends_at=new Date($o('ofTo').value).toISOString();
    body.days_of_week=[...el.querySelectorAll('.ofDay:checked')].map(x=>+x.value);
    if($o('ofTF').value&&$o('ofTT').value){body.time_from=$o('ofTF').value;body.time_to=$o('ofTT').value;}
    else if($o('ofTF').value||$o('ofTT').value){body.time_from=$o('ofTF').value;body.time_to=$o('ofTT').value;}
    if(c==='tier')body.tiers=[...el.querySelectorAll('.ofTier:checked')].map(x=>x.value);
    const go=$o('ofGo');go.disabled=true;
    try{
      if(o)await PlemmoAPI.put('/offers/'+encodeURIComponent(o.id),body);else await PlemmoAPI.post('/offers',body,{idempotent:false});
      L.close();toast(o?'Offer saved':'Offer created — it applies from the next sale','ok');U.of.list=null;offersLoad();
    }catch(e){go.disabled=false;const m=$o('ofErr');m.textContent=(e&&e.data&&e.data.error)||'The till server did not accept that.';m.hidden=false;}
  };
};

/* ---------- the register: what the basket would save ---------- */
// A preview only. The offers applied to the sale are the server's, worked out again when the sale is made.
function cartOfferSig(c){return c.items.map(l=>`${l.pid}:${l.vid||''}:${l.qty}`).join('|')+'#'+(c.custId||'')+'#'+(c.discount?'m':'');}
function offerFor(c){
  if(c!==U.cart||c.discount||!live())return null;
  const q=U.cartOffer;
  if(!q||q.sig!==cartOfferSig(c)||!(q.savings>0))return null;
  return{kind:'amt',value:q.savings,reason:'Offer: '+q.names.join(', '),auto:true};
}
let cartOfferTimer=null;
function scheduleCartOffers(){
  if(!live()||!U.cart||!U.cart.items.length||U.cart.discount){if(U.cartOffer&&U.cartOffer.savings){U.cartOffer=null;}return;}
  const sig=cartOfferSig(U.cart);
  if(U.cartOffer&&U.cartOffer.sig===sig)return;
  clearTimeout(cartOfferTimer);
  cartOfferTimer=setTimeout(async()=>{
    const c=U.cart;if(!c||cartOfferSig(c)!==sig)return;
    try{
      const r=await PlemmoAPI.post('/offers/preview',{items:c.items.map(l=>({product_id:l.pid,variant_id:l.vid||null,quantity:l.qty})),customer_id:c.custId||null},{idempotent:false});
      if(U.cart!==c||cartOfferSig(c)!==sig)return;
      U.cartOffer={sig,savings:(r.savings_minor||0)/100,names:(r.applications||[]).map(a=>a.name)};
    }catch(e){U.cartOffer={sig,savings:0,names:[]};}
    if(U.view==='pos')refreshPos({grid:false});
  },250);
}
