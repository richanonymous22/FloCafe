/* ============================================================================
 * 05b-stock-tools.js — stocktake, stock value, stock import and the live stock history
 * ----------------------------------------------------------------------------
 * These screens exist only on a till connected to its server: the stock ledger lives there, and every
 * figure and every change below is the server's. Nothing is kept or "counted" in the browser.
 *   Stocktake    start → count (type or scan) → review the variance → approve (posts the adjustments)
 *   Stock value  ledger balance × cost, by category and item, with CSV
 *   Import       a CSV of counts or deliveries: checked first (dry run), applied only if every row is valid
 *   History      the ledger's movements with who and why
 * ==========================================================================*/
U.st=U.st||{};
const stEsc=esc;
const stQty=n=>(Math.round((+n||0)*1000)/1000).toString();
const stWhen=s=>s?fmtDT(Date.parse(String(s).replace(' ','T')+(/[zZ]|[+-]\d\d:?\d\d$/.test(String(s))?'':'Z'))):'';
const stMoney=(minor,exp)=>tmoney(minor,exp);
function stErr(e,fallback){return window.PlemmoAdmin?PlemmoAdmin.errorMessage(e,fallback):fallback;}
function stReload(tab){U.st[tab+'Key']=0;renderView();}

function liveLogBody(){
  const log=U.st.log;
  if(!log)return`<div class="panel"><div class="panel-b"><p class="muted">Loading the stock ledger…</p></div></div>`;
  return`<div class="panel"><div class="tbl-wrap">${log.length?`<table class="tbl"><thead><tr><th>When</th><th>Item</th><th>Type</th><th class="r">Change</th><th>Reason</th><th>By</th><th class="r">Stock after</th></tr></thead><tbody>${log.map(m=>`<tr><td class="num">${stEsc(stWhen(m.created_at))}</td><td>${stEsc(m.product_name||'')}${m.variant_name?` — ${stEsc(m.variant_name)}`:''}</td><td>${stEsc(m.movement_type)}</td><td class="r num"><b style="color:${m.quantity_delta<0?'var(--bad-text)':'var(--ok-text)'}">${m.quantity_delta>0?'+':''}${stQty(m.quantity_delta)}</b></td><td>${stEsc(m.reason||'')}</td><td>${stEsc(m.actor_name||'')}</td><td class="r num">${stQty(m.balance_after)}</td></tr>`).join('')}</tbody></table>`:`<div class="empty"><h3>No stock movements yet</h3><p>Every sale, delivery, count and correction appears here.</p></div>`}</div></div>`;
}

function stockToolsBody(tab){
  if(tab==='take')return stocktakeBody();
  if(tab==='value')return valueBody();
  if(tab==='sup')return suppliersBody();
  if(tab==='po')return purchasesBody();
  if(tab==='menu')return menuFileBody();
  if(tab==='offers')return offersBody();
  return importBody();
}

/* ---------- Stocktake ---------- */
function stocktakeBody(){
  const s=U.st;
  if(s.err)return`<div class="panel"><div class="panel-b"><div class="empty"><h3>Stocktake unavailable</h3><p>${stEsc(s.err)}</p><button class="btn" data-act="stRetry">Try again</button></div></div></div>`;
  if(!s.list)return`<div class="panel"><div class="panel-b"><p class="muted">Loading stocktakes…</p></div></div>`;
  if(s.cur)return stocktakeCount(s.cur);
  const open=s.list.find(x=>x.status==='counting');
  const hist=s.list.filter(x=>x.status!=='counting');
  const start=open?`<div class="panel"><div class="panel-b"><div class="row"><div style="flex:1"><b>${stEsc(open.name)}</b><div class="muted">A stocktake is in progress: ${open.summary.counted} of ${open.summary.lines} items counted.</div></div><button class="btn btn-primary" data-act="stOpen" data-id="${stEsc(open.id)}">Continue counting</button></div></div></div>`
    :`<div class="panel"><div class="panel-h"><h3>Start a stocktake</h3></div><div class="panel-b"><div class="fgrid">
       <label class="field"><span>Name</span><input class="input" id="stName" placeholder="For example, Month end count" maxlength="80"></label>
       <label class="field"><span>What to count</span><select class="input" id="stCat"><option value="">All items with tracked stock</option>${S.categories.map(c=>`<option value="${stEsc(c.id)}">${stEsc(c.name)} only</option>`).join('')}</select></label></div>
       <p class="hint">Count with the shelf in front of you. You can keep selling while you count: sales made meanwhile are kept when you approve.</p>
       <button class="btn btn-primary" data-act="stStart">${ic('plus',16)} Start counting</button></div></div>`;
  return`${start}<section class="panel mt"><div class="panel-h"><h3>Past stocktakes</h3></div><div class="panel-b flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>No.</th><th>Name</th><th>Status</th><th class="r">Counted</th><th class="r">Variance</th><th></th></tr></thead><tbody>
    ${hist.map(h=>`<tr><td>${h.number}</td><td>${stEsc(h.name)}<small class="muted" style="display:block">${stEsc(stWhen(h.approved_at||h.cancelled_at||h.created_at))}</small></td><td><span class="badge ${h.status==='approved'?'ok':''}">${h.status==='approved'?'Approved':'Cancelled'}</span></td><td class="r num">${h.summary.counted}/${h.summary.lines}</td><td class="r num">${h.status==='approved'?stMoney(h.summary.variance_value_minor,h.exponent):''}</td><td class="r"><button class="btn btn-sm" data-act="stOpen" data-id="${stEsc(h.id)}">View</button></td></tr>`).join('')||'<tr><td colspan="6" class="muted">No finished stocktakes yet.</td></tr>'}
   </tbody></table></div></div></section>`;
}
function stocktakeCount(c){
  const st=c.stocktake,ls=c.lines,sm=c.summary,exp=st.exponent,counting=st.status==='counting',reveal=U.st.reveal||!counting;
  const rows=ls.map(l=>{
    const v=l.counted==null?null:(l.counted-(l.expected_at_count!=null?l.expected_at_count:l.expected));
    const vc=v==null?'':(Math.abs(v)<1e-9?'':`<b style="color:${v<0?'var(--bad-text)':'var(--ok-text)'}">${v>0?'+':''}${stQty(v)}</b>`);
    return`<tr data-line="${l.id}"><td><b>${stEsc(l.name)}</b><small class="num" style="display:block">${stEsc(l.sku||l.barcode||'')}</small></td>
      ${reveal?`<td class="r num">${stQty(l.expected_at_count!=null?l.expected_at_count:l.expected)}</td>`:''}
      <td class="r">${counting?`<input class="input num" style="width:92px;text-align:right" inputmode="decimal" data-ch="stSet" data-pid="${stEsc(l.product_id)}" data-vid="${stEsc(l.product_variant_id||'')}" value="${l.counted==null?'':stQty(l.counted)}" placeholder="–" aria-label="Counted ${stEsc(l.name)}">`:`<span class="num">${l.counted==null?'–':stQty(l.counted)}</span>`}</td>
      ${reveal?`<td class="r num">${vc}${l.clamped?' <span class="badge warn" data-tip="Stock was lower than the count implied, so the correction was limited to zero.">limited</span>':''}</td><td class="r num">${l.variance_value_minor?stMoney(l.variance_value_minor,exp):''}</td>`:''}</tr>`;
  }).join('');
  const head=`<div class="row" style="margin-bottom:12px"><button class="btn btn-ghost" data-act="stBack">← All stocktakes</button><div style="flex:1;min-width:0"><b>${stEsc(st.name)}</b> <span class="badge ${st.status==='approved'?'ok':''}">${st.status}</span><div class="muted" style="font-size:12.5px">${sm.counted} of ${sm.lines} counted${reveal?` · ${sm.short} short, ${sm.over} over · net ${stMoney(sm.variance_value_minor,exp)} at cost`:''}</div></div></div>`;
  const scan=counting?`<form id="stScanForm" class="row" style="margin-bottom:12px;gap:8px"><label class="search" style="flex:1;max-width:420px">${ic('search',18)}<input id="stCode" autocomplete="off" placeholder="Scan a barcode or type a SKU, then Enter"></label><button class="btn" type="submit">Add one</button><span id="stLast" class="muted" aria-live="polite">${U.st.last?stEsc(U.st.last):''}</span></form>`:'';
  const actions=counting?`<div class="row mt" style="gap:8px"><button class="btn" data-act="stReveal">${U.st.reveal?'Hide expected quantities':'Review variances'}</button><span class="spacer"></span><button class="btn" data-act="stCancel">Cancel stocktake</button><button class="btn btn-primary" data-act="stApprove" ${sm.counted?'':'disabled'}>Approve and adjust stock</button></div>`:'';
  return`${head}${scan}<div class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Item</th>${reveal?'<th class="r">Expected</th>':''}<th class="r">Counted</th>${reveal?'<th class="r">Difference</th><th class="r">Value</th>':''}</tr></thead><tbody>${rows}</tbody></table></div></div>${actions}`;
}
function stRefreshCur(){if(!U.st.cur)return Promise.resolve();return PlemmoAPI.get('/stocktakes/'+encodeURIComponent(U.st.cur.stocktake.id)).then(r=>{U.st.cur=r;});}
A.stRetry=()=>{U.st.err=null;U.st.list=null;stReload('take');};
A.stBack=()=>{U.st.cur=null;stReload('take');};
A.stOpen=async d=>{try{U.st.cur=await PlemmoAPI.get('/stocktakes/'+encodeURIComponent(d.id));U.st.reveal=U.st.cur.stocktake.status!=='counting'?true:false;renderView();}catch(e){toast(stErr(e,'The stocktake could not be opened'),'warn');}};
A.stStart=async()=>{
  const name=($('#stName')||{}).value||'',cat=($('#stCat')||{}).value||'';
  try{
    U.st.cur=await PlemmoAPI.post('/stocktakes',{name:name.trim(),category_ids:cat?[cat]:[]},{idempotent:false});U.st.reveal=false;U.st.last='';
    toast(`Stocktake started: ${U.st.cur.lines.length} items to count`);renderView();
  }catch(e){toast(stErr(e,'The stocktake could not be started'),'warn',{ms:5200});}
};
A.stReveal=()=>{U.st.reveal=!U.st.reveal;renderView();};
CH.stSet=async(v,el)=>{
  const raw=String(v).trim();if(raw==='')return;
  const n=Number(raw);if(!isFinite(n)||n<0){toast('Enter a number, zero or more','warn');await stRefreshCur();renderView();return;}
  try{await PlemmoAPI.request('/stocktakes/'+encodeURIComponent(U.st.cur.stocktake.id)+'/lines',{method:'PUT',body:{product_id:el.dataset.pid,variant_id:el.dataset.vid||null,quantity:n,mode:'set'},idempotent:false});await stRefreshCur();renderView();}
  catch(e){toast(stErr(e,'That count was not saved'),'warn');await stRefreshCur().catch(()=>{});renderView();}
};
async function stScan(code){
  code=String(code||'').trim();if(!code)return;
  try{
    const r=await PlemmoAPI.post('/stocktakes/'+encodeURIComponent(U.st.cur.stocktake.id)+'/scan',{code:code},{idempotent:false});
    U.st.last=`${r.line.name}: ${stQty(r.line.counted)} counted`;await stRefreshCur();renderView();
  }catch(e){U.st.last='';toast((e&&e.data&&e.data.code==='unknown_code')?`Nothing in this stocktake has the code “${code}”`:stErr(e,'That scan was not saved'),'warn');renderView();}
}
AFTER.items=()=>{
  if(!adminLive())return;
  const t=U.items.tab;
  const f=$('#stScanForm');
  if(f){f.onsubmit=async ev=>{ev.preventDefault();const i=$('#stCode');const c=i?i.value:'';await stScan(c);const n=$('#stCode');if(n){n.value='';n.focus();}};const i=$('#stCode');if(i&&matchMedia('(pointer:fine)').matches)i.focus({preventScroll:true});}
  if(!['log','take','value','sup','po'].includes(t)||U.st[t+'Key'])return;
  U.st[t+'Key']=1;
  const done=()=>{if(U.view==='items')renderView();};
  if(t==='log')PlemmoAPI.get('/inventory/movements?limit=150').then(r=>{U.st.log=r.movements;done();}).catch(e=>{U.st.log=[];toast(stErr(e,'The stock ledger could not be read'),'warn');done();});
  else if(t==='sup')PlemmoAPI.get('/suppliers').then(r=>{U.st.sup=r.suppliers;U.st.err=null;done();}).catch(e=>{U.st.err=stErr(e,'The suppliers could not be read');done();});
  else if(t==='po')Promise.all([PlemmoAPI.get('/purchase-orders'),PlemmoAPI.get('/suppliers')]).then(async r=>{U.st.pos=r[0].purchaseOrders;U.st.sup=r[1].suppliers;if(U.st.poCur){try{U.st.poCur=(await PlemmoAPI.get('/purchase-orders/'+encodeURIComponent(U.st.poCur.id))).purchaseOrder;}catch(e){U.st.poCur=null;}}U.st.err=null;done();}).catch(e=>{U.st.err=stErr(e,'The purchases could not be read');done();});
  else if(t==='value')PlemmoAPI.get('/inventory/valuation').then(r=>{U.st.val=r.valuation;U.st.err=null;done();}).catch(e=>{U.st.err=stErr(e,'The stock value could not be read');done();});
  else PlemmoAPI.get('/stocktakes').then(r=>{U.st.list=r.stocktakes;U.st.err=null;done();}).catch(e=>{U.st.err=(e&&e.status===403)?'You don’t have permission to count stock.':stErr(e,'The stocktakes could not be read');done();});
};
A.stCancel=async()=>{
  if(!await confirmBox({title:'Cancel this stocktake?',text:'The counts so far are thrown away and no stock is changed.',ok:'Cancel stocktake',danger:true}))return;
  try{await PlemmoAPI.post('/stocktakes/'+encodeURIComponent(U.st.cur.stocktake.id)+'/cancel',{},{idempotent:false});U.st.cur=null;toast('Stocktake cancelled. No stock was changed.');stReload('take');}
  catch(e){toast(stErr(e,'It could not be cancelled'),'warn');}
};
A.stApprove=async()=>{
  const c=U.st.cur,sm=c.summary,exp=c.stocktake.exponent;
  const zero=sm.uncounted>0?await new Promise(res=>{
    const L=modal({title:'Approve the stocktake',cls:'narrow',body:`<p>${sm.counted} of ${sm.lines} items were counted: ${sm.short} short, ${sm.over} over, net ${stMoney(sm.variance_value_minor,exp)} at cost.</p><p><b>${sm.uncounted} item${sm.uncounted===1?' was':'s were'} not counted.</b> What should happen to ${sm.uncounted===1?'it':'them'}?</p>`,
      foot:`<button class="btn" data-x="cancel">Back</button><span class="spacer"></span><button class="btn" data-x="ignore">Leave them as they are</button><button class="btn btn-danger" data-x="zero">Set them to zero</button>`,onClose:()=>res(null)});
    L.el.addEventListener('click',e=>{const b=e.target.closest('[data-x]');if(!b)return;const x=b.dataset.x;L.close();res(x==='zero'?'zero':x==='ignore'?'ignore':null);});
  }):(await confirmBox({title:'Approve the stocktake?',text:`${sm.counted} items counted: ${sm.short} short, ${sm.over} over, net ${stMoney(sm.variance_value_minor,exp)} at cost. This adjusts the stock and cannot be undone.`,ok:'Approve and adjust stock'})?'ignore':null);
  if(!zero)return;
  try{
    const r=await PlemmoAPI.post('/stocktakes/'+encodeURIComponent(c.stocktake.id)+'/approve',{uncounted:zero},{idempotent:false});
    U.st.cur=r;U.st.reveal=true;
    if(window.PlemmoCatalogue&&PlemmoCatalogue.load)try{await PlemmoCatalogue.load(S);}catch(e){/* shelf figures refresh on the next load */}
    renderView();renderRail();toast(`Stocktake approved: ${r.adjustments} stock adjustment${r.adjustments===1?'':'s'}`,'ok',{ms:5200});
  }catch(e){toast(stErr(e,'The stocktake could not be approved'),'warn',{ms:6000});}
};

/* ---------- Stock value ---------- */
function valueBody(){
  const s=U.st;
  if(s.err)return`<div class="panel"><div class="panel-b"><div class="empty"><h3>Stock value unavailable</h3><p>${stEsc(s.err)}</p><button class="btn" data-act="stRetryValue">Try again</button></div></div></div>`;
  const v=s.val;if(!v)return`<div class="panel"><div class="panel-b"><p class="muted">Loading stock value…</p></div></div>`;
  const tm=m=>stMoney(m,v.exponent);
  return`<div class="strip" style="--n:3"><div><div class="k-l"><span>Stock at cost</span></div><div class="k-v num">${tm(v.total_minor)}</div><div class="k-s">${stQty(v.total_units)} units on hand</div></div>
    <div><div class="k-l"><span>Items</span></div><div class="k-v num">${v.rows.length}</div><div class="k-s">with tracked stock</div></div>
    <div><div class="k-l"><span>Without a cost</span></div><div class="k-v num">${v.uncosted_items}</div><div class="k-s">${v.uncosted_items?'in stock but valued at £0: set their cost':'every item in stock has a cost'}</div></div></div>
   <div class="grid g-73 mt"><section class="panel"><div class="panel-h"><h3>By item</h3><button class="btn btn-sm" data-act="stValueCsv">${ic('download',14)} CSV</button></div><div class="panel-b flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Category</th><th class="r">On hand</th><th class="r">Cost</th><th class="r">Value</th></tr></thead><tbody>
    ${v.rows.map(r=>`<tr><td><b>${stEsc(r.name)}</b><small class="num" style="display:block">${stEsc(r.sku||'')}</small></td><td>${stEsc(r.category)}</td><td class="r num">${stQty(r.quantity)}</td><td class="r num">${tm(r.unit_cost_minor)}</td><td class="r num">${tm(r.value_minor)}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">No items have stock tracking switched on.</td></tr>'}
   </tbody></table></div></div></section>
   <section class="panel"><div class="panel-h"><h3>By category</h3></div><div class="panel-b flush"><div class="tbl-wrap"><table class="tbl"><tbody>${v.by_category.map(c=>`<tr><td>${stEsc(c.category)}</td><td class="r num">${stQty(c.quantity)}</td><td class="r num">${tm(c.value_minor)}</td></tr>`).join('')}</tbody></table></div></div></section></div>`;
}
A.stRetryValue=()=>{U.st.err=null;U.st.val=null;stReload('value');};
A.stValueCsv=async()=>{try{offerDownload(`stock-value-${new Date().toISOString().slice(0,10)}.csv`,await PlemmoAPI.get('/inventory/valuation/csv'));}catch(e){toast('The CSV could not be downloaded','warn');}};

/* ---------- Import ---------- */
function importBody(){
  const i=U.st.imp||{mode:'set',text:'',report:null,done:null};U.st.imp=i;
  const r=i.report;
  const tbl=r?`<div class="panel mt"><div class="panel-h"><h3>${i.checkedOnly?'Check result':'Imported'}</h3><span class="ph-sub">${r.ok} to change, ${r.unchanged} unchanged, ${r.errors} with a problem</span></div><div class="panel-b flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Row</th><th>Code</th><th>Item</th><th class="r">Now</th><th class="r">After</th><th>Result</th></tr></thead><tbody>
    ${r.rows.map(x=>`<tr><td class="num">${x.row}</td><td class="num">${stEsc(x.code)}</td><td>${stEsc(x.name||'')}</td><td class="r num">${x.current==null?'':stQty(x.current)}</td><td class="r num">${x.new_quantity==null?'':stQty(x.new_quantity)}</td><td>${x.status==='error'?`<span class="badge bad">${stEsc(x.error)}</span>`:x.status==='unchanged'?'<span class="badge">No change</span>':`<span class="badge ok">${x.delta>0?'+':''}${stQty(x.delta)}</span>`}</td></tr>`).join('')}
   </tbody></table></div></div></div>`:'';
  return`<div class="panel"><div class="panel-b"><p class="muted" style="margin-top:0">A CSV with a <b>sku</b> or <b>barcode</b> column and a <b>quantity</b> column (and an optional <b>reason</b>). The file is checked first; it is only applied when every row is valid.</p>
    <div class="fgrid"><label class="field"><span>File</span><input class="input" type="file" accept=".csv,text/csv" data-ch="impFile"></label>
    <label class="field"><span>What does the file say?</span><select class="input" data-ch="impMode"><option value="set" ${i.mode==='set'?'selected':''}>What is on the shelf now (counts)</option><option value="add" ${i.mode==='add'?'selected':''}>What has just arrived (a delivery)</option></select></label></div>
    <label class="field"><span>Or paste the CSV</span><textarea class="input" id="impText" rows="6" data-in="impText" placeholder="sku,quantity&#10;ABC123,12">${stEsc(i.text)}</textarea></label>
    <div class="row" style="gap:8px"><button class="btn" data-act="impCheck" ${i.text.trim()?'':'disabled'}>Check the file</button><button class="btn btn-primary" data-act="impApply" ${r&&i.checkedOnly&&!r.errors&&r.ok?'':'disabled'}>Apply the import</button></div>
    ${i.done?`<p class="hint" style="color:var(--ok-text)">${stEsc(i.done)}</p>`:''}</div></div>${tbl}`;
}
IN.impText=v=>{const i=U.st.imp;i.text=v;i.report=null;i.checkedOnly=false;i.done=null;const c=document.querySelector('[data-act="impCheck"]');if(c)c.disabled=!v.trim();const a=document.querySelector('[data-act="impApply"]');if(a)a.disabled=true;};
CH.impMode=v=>{const i=U.st.imp;i.mode=v==='add'?'add':'set';i.report=null;i.checkedOnly=false;renderView();};
CH.impFile=async(v,el)=>{const f=el.files&&el.files[0];if(!f)return;if(f.size>100000){toast('That file is too large (limit 100 KB). Split it into smaller files.','warn');return;}const i=U.st.imp;i.text=await f.text();i.report=null;i.checkedOnly=false;i.done=null;renderView();};
async function impRun(dry){
  const i=U.st.imp;
  const body={csv:i.text,mode:i.mode,dry_run:dry};if(!dry)body.import_id='imp-'+uid('i');
  try{const r=await PlemmoAPI.post('/inventory/import',body,{idempotent:false});i.report=r.report;i.checkedOnly=dry;return r.report;}
  catch(e){if(e&&e.data&&e.data.report){i.report=e.data.report;i.checkedOnly=false;}toast(stErr(e,'The file could not be read'),'warn',{ms:5200});return null;}
}
A.impCheck=async()=>{await impRun(true);renderView();};
A.impApply=async()=>{
  const i=U.st.imp;if(!i.report||!i.checkedOnly)return;
  if(!await confirmBox({title:'Apply this import?',text:`${i.report.ok} item${i.report.ok===1?'':'s'} will change. Every change is recorded in the stock history.`,ok:'Apply the import'}))return;
  const r=await impRun(false);
  if(r){i.done=`Imported: ${r.adjustments} stock change${r.adjustments===1?'':'s'}, ${r.unchanged} unchanged.`;i.text='';
    if(window.PlemmoCatalogue&&PlemmoCatalogue.load)try{await PlemmoCatalogue.load(S);}catch(e){/* refreshed on next load */}
    U.st.logKey=0;renderRail();}
  renderView();
};

/* ---------- Items file: export, template and import of items, categories and option groups ---------- */
const MENU_KINDS={products:['Items','items'],categories:['Categories','categories'],addons:['Option groups','option groups']};
function menuFileBody(){
  const m=U.st.mc||{kind:'products',text:'',name:'',result:null,busy:false};U.st.mc=m;
  const r=m.result;
  const lines=m.text.trim()?m.text.trim().split(/\r?\n/):[];
  const res=r?`<div class="panel mt"><div class="panel-h"><h3>Import result</h3></div><div class="panel-b"><div class="strip" style="--n:5">${[['Added',r.created],['Updated',r.updated],['Brought back',r.reactivated],['Skipped',r.skipped],['Problems',r.failed]].map(([l,v])=>`<div><div class="k-l"><span>${l}</span></div><div class="k-v num">${+v||0}</div></div>`).join('')}</div>
    ${(r.errors||[]).length?`<p class="hint" style="margin-top:12px"><b>Rows that were not imported</b></p><ul class="muted" style="margin:6px 0 0 18px">${r.errors.slice(0,25).map(e=>`<li>${stEsc(e)}</li>`).join('')}</ul>${r.errors.length>25?`<p class="hint">…and ${r.errors.length-25} more</p>`:''}`:''}</div></div>`:'';
  return`<div class="panel"><div class="panel-b"><p class="muted" style="margin-top:0">Move ${MENU_KINDS[m.kind][1]} in and out as a spreadsheet file (CSV). Start from the template, fill it in, then import. Rows that match something you already have are updated or skipped; nothing is deleted.</p>
    <div class="fgrid"><label class="field"><span>What are you moving?</span><select class="input" data-ch="mcKind">${Object.entries(MENU_KINDS).map(([k,v])=>`<option value="${k}" ${m.kind===k?'selected':''}>${v[0]}</option>`).join('')}</select></label>
    <div class="field"><span>Download</span><div class="row" style="gap:8px"><button class="btn" data-act="mcExport">${ic('download',14)} Everything now in the till</button><button class="btn" data-act="mcTemplate">${ic('download',14)} Blank template</button></div></div></div>
    <div class="fgrid"><label class="field"><span>File to import</span><input class="input" type="file" accept=".csv,text/csv" data-ch="mcFile"></label>
    <label class="field"><span>Or paste the CSV</span><textarea class="input" rows="5" data-in="mcText" placeholder="Paste a CSV here">${stEsc(m.text)}</textarea></label></div>
    <p class="hint" id="mcHint">${mcHint(m)}</p>
    <button class="btn btn-primary" data-act="mcImport" ${lines.length>1&&!m.busy?'':'disabled'}>Import ${MENU_KINDS[m.kind][1]}</button></div></div>${res}`;
}
function mcHint(m){const l=m.text.trim()?m.text.trim().split(/\r?\n/):[];return l.length?`${l.length-1} row${l.length===2?'':'s'} ready to import${m.name?' from '+stEsc(m.name):''}. First line: <span class="num">${stEsc(l[0].slice(0,120))}</span>`:'';}
CH.mcKind=v=>{const m=U.st.mc;m.kind=MENU_KINDS[v]?v:'products';m.result=null;renderView();};
IN.mcText=v=>{const m=U.st.mc;m.text=v;m.name='';m.result=null;const b=document.querySelector('[data-act="mcImport"]');if(b)b.disabled=!(v.trim().split(/\r?\n/).length>1)||m.busy;const hn=document.getElementById('mcHint');if(hn)hn.innerHTML=mcHint(m);};
CH.mcFile=async(v,el)=>{const f=el.files&&el.files[0];if(!f)return;if(f.size>500000){toast('That file is too large (limit 500 KB). Split it into smaller files.','warn');return;}const m=U.st.mc;m.text=await f.text();m.name=f.name;m.result=null;renderView();};
A.mcExport=async()=>{const k=U.st.mc.kind;try{offerDownload(`${k}-${new Date().toISOString().slice(0,10)}.csv`,await PlemmoAPI.get('/menu-csv/export/'+k));}catch(e){toast(stErr(e,'The file could not be downloaded'),'warn');}};
A.mcTemplate=async()=>{const k=U.st.mc.kind;try{offerDownload(`${k}-template.csv`,await PlemmoAPI.get('/menu-csv/template/'+k));}catch(e){toast(stErr(e,'The template could not be downloaded'),'warn');}};
A.mcImport=async()=>{
  const m=U.st.mc;if(m.busy||m.text.trim().split(/\r?\n/).length<2)return;
  if(!await confirmBox({title:`Import ${MENU_KINDS[m.kind][1]}?`,text:'Matching rows are updated or skipped and new ones are added. Nothing is deleted. Take a backup first if you are unsure.',ok:'Import'}))return;
  m.busy=true;renderView();
  try{
    m.result=await PlemmoAPI.post('/menu-csv/import/'+m.kind,{csv:m.text},{idempotent:false});
    toast(`Imported: ${m.result.created} added, ${m.result.updated} updated${m.result.failed?`, ${m.result.failed} with a problem`:''}`,m.result.failed?'warn':'ok',{ms:5200});
    if(window.PlemmoCatalogue&&PlemmoCatalogue.load)try{await PlemmoCatalogue.load(S);}catch(e){/* refreshed on next load */}
    renderRail();
  }catch(e){toast(stErr(e,'The file could not be imported'),'warn',{ms:6000});}
  finally{m.busy=false;renderView();}
};

/* ---------- Suppliers ---------- */
function suppliersBody(){
  const s=U.st;
  if(s.err)return`<div class="panel"><div class="panel-b"><div class="empty"><h3>Suppliers unavailable</h3><p>${stEsc(s.err)}</p><button class="btn" data-act="stRetrySup">Try again</button></div></div></div>`;
  if(!s.sup)return`<div class="panel"><div class="panel-b"><p class="muted">Loading suppliers…</p></div></div>`;
  return`<div class="row" style="margin-bottom:12px"><span class="spacer"></span><button class="btn btn-primary" data-act="supEdit">${ic('plus',16)} New supplier</button></div>
   <div class="panel"><div class="tbl-wrap">${s.sup.length?`<table class="tbl"><thead><tr><th>Supplier</th><th>Contact</th><th>Phone</th><th>Email</th><th></th></tr></thead><tbody>${s.sup.map(x=>`<tr><td><b>${stEsc(x.name)}</b>${x.business_name?`<small style="display:block" class="muted">${stEsc(x.business_name)}</small>`:''}</td><td>${stEsc(x.contact_person||'')}</td><td>${stEsc(x.phone||'')}</td><td>${stEsc(x.email||'')}</td><td class="r"><button class="btn btn-sm" data-act="supEdit" data-id="${stEsc(x.id)}">Edit</button></td></tr>`).join('')}</tbody></table>`:`<div class="empty"><h3>No suppliers yet</h3><p>Add the people you buy stock from, then raise purchase orders to them.</p><button class="btn btn-primary" data-act="supEdit">${ic('plus',16)} New supplier</button></div>`}</div></div>`;
}
A.stRetrySup=()=>{U.st.err=null;U.st.sup=null;stReload('sup');};
A.supEdit=d=>{
  const cur=d.id?(U.st.sup||[]).find(x=>x.id===d.id):null;
  const f=(id,label,val,ph)=>`<label class="field"><span>${label}</span><input class="input" id="${id}" value="${stEsc(val||'')}" placeholder="${ph||''}" maxlength="200"></label>`;
  const L=modal({title:cur?'Edit supplier':'New supplier',cls:'narrow',body:`<div class="fgrid">${f('spName','Name *',cur&&cur.name)}${f('spBiz','Business name',cur&&cur.business_name)}${f('spPerson','Contact person',cur&&cur.contact_person)}${f('spPhone','Phone',cur&&cur.phone)}${f('spEmail','Email',cur&&cur.email)}${f('spVat','VAT number',cur&&cur.tax_registration_number)}</div>${f('spAddr','Address',cur&&cur.address)}`,
    foot:`${cur?`<button class="btn btn-danger" id="spDel">Delete</button>`:''}<span class="spacer"></span><button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="spSave">Save</button>`});
  const v=id=>(L.el.querySelector('#'+id)||{}).value||'';
  L.el.querySelector('#spSave').onclick=async()=>{
    const body={name:v('spName').trim(),business_name:v('spBiz'),contact_person:v('spPerson'),phone:v('spPhone'),email:v('spEmail'),tax_registration_number:v('spVat'),address:v('spAddr')};
    if(!body.name){toast('Give the supplier a name','warn');return;}
    try{if(cur)await PlemmoAPI.request('/suppliers/'+encodeURIComponent(cur.id),{method:'PUT',body,idempotent:false});else await PlemmoAPI.post('/suppliers',body,{idempotent:false});L.close();toast('Supplier saved');stReload('sup');}
    catch(e){toast(stErr(e,'The supplier was not saved'),'warn');}
  };
  const del=L.el.querySelector('#spDel');
  if(del)del.onclick=async()=>{if(!await confirmBox({title:'Delete this supplier?',text:'Their purchase orders are kept.',ok:'Delete',danger:true}))return;try{await PlemmoAPI.del('/suppliers/'+encodeURIComponent(cur.id),{idempotent:false});L.close();closeAll();toast('Supplier deleted');stReload('sup');}catch(e){toast(stErr(e,'It could not be deleted'),'warn');}};
};

/* ---------- Purchase orders ---------- */
const poLabel={draft:'Draft',ordered:'Ordered',partially_received:'Part received',received:'Received',cancelled:'Cancelled'};
const supName=id=>{const x=(U.st.sup||[]).find(y=>y.id===id);return x?x.name:'Unknown supplier';};
const pName=id=>{const p=S.products.find(x=>x.id===id);return p?p.name:id;};
const poOutstanding=po=>sum(po.items||[],i=>Math.max(0,i.quantity_ordered-i.quantity_received));
function purchasesBody(){
  const s=U.st;
  if(s.err)return`<div class="panel"><div class="panel-b"><div class="empty"><h3>Purchases unavailable</h3><p>${stEsc(s.err)}</p><button class="btn" data-act="stRetryPo">Try again</button></div></div></div>`;
  if(!s.pos)return`<div class="panel"><div class="panel-b"><p class="muted">Loading purchases…</p></div></div>`;
  if(s.poCur)return poDetail(s.poCur);
  return`<div class="row" style="margin-bottom:12px"><span class="spacer"></span><button class="btn btn-primary" data-act="poNew">${ic('plus',16)} New purchase order</button></div>
   <div class="panel"><div class="tbl-wrap">${s.pos.length?`<table class="tbl"><thead><tr><th>Order</th><th>Supplier</th><th>Status</th><th>Expected</th><th class="r">Total</th><th></th></tr></thead><tbody>${s.pos.map(p=>`<tr><td><b>${stEsc(p.reference_number||p.id.slice(-6).toUpperCase())}</b><small class="muted" style="display:block">${stEsc(stWhen(p.created_at))}</small></td><td>${stEsc(supName(p.supplier_id))}</td><td><span class="badge ${p.status==='received'?'ok':p.status==='cancelled'?'':'warn'}">${poLabel[p.status]||p.status}</span></td><td>${stEsc(p.expected_date||'')}</td><td class="r num">${money(p.total)}</td><td class="r"><button class="btn btn-sm" data-act="poOpen" data-id="${stEsc(p.id)}">Open</button></td></tr>`).join('')}</tbody></table>`:`<div class="empty"><h3>No purchase orders yet</h3><p>Order stock from a supplier, then receive it here when it arrives. Receiving adds it to your stock.</p><button class="btn btn-primary" data-act="poNew">${ic('plus',16)} New purchase order</button></div>`}</div></div>`;
}
function poDetail(po){
  const draft=po.status==='draft',recv=po.status==='ordered'||po.status==='partially_received';
  return`<div class="row" style="margin-bottom:12px"><button class="btn btn-ghost" data-act="poBack">← All purchase orders</button><div style="flex:1;min-width:0"><b>${stEsc(po.reference_number||'Purchase order')}</b> <span class="badge ${po.status==='received'?'ok':'warn'}">${poLabel[po.status]||po.status}</span><div class="muted" style="font-size:12.5px">${stEsc(supName(po.supplier_id))}${po.expected_date?` · expected ${stEsc(po.expected_date)}`:''}</div></div></div>
   <div class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Item</th><th class="r">Ordered</th><th class="r">Received</th><th class="r">Unit cost</th><th class="r">Line total</th><th></th></tr></thead><tbody>
    ${(po.items||[]).map(i=>`<tr><td><b>${stEsc(pName(i.product_id))}</b></td><td class="r num">${stQty(i.quantity_ordered)}</td><td class="r num">${stQty(i.quantity_received)}</td><td class="r num">${money(i.unit_cost)}</td><td class="r num">${money(i.line_total)}</td><td class="r">${draft?`<button class="btn btn-sm btn-ghost" data-act="poDelItem" data-id="${stEsc(i.id)}">Remove</button>`:''}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">No items yet. Add what you are ordering.</td></tr>'}
   </tbody><tfoot><tr><td colspan="4">Total${po.tax?` (incl. ${money(po.tax)} VAT)`:''}</td><td class="r num">${money(po.total)}</td><td></td></tr></tfoot></table></div></div>
   <div class="row mt" style="gap:8px">${draft?`<button class="btn" data-act="poAddItem">${ic('plus',16)} Add an item</button>`:''}<span class="spacer"></span>
    ${draft||recv?`<button class="btn" data-act="poCancel">Cancel order</button>`:''}
    ${draft?`<button class="btn btn-primary" data-act="poOrder" ${(po.items||[]).length?'':'disabled'}>Mark as ordered</button>`:''}
    ${recv?`<button class="btn btn-primary" data-act="poReceive">Receive goods</button>`:''}</div>`;
}
A.stRetryPo=()=>{U.st.err=null;U.st.pos=null;stReload('po');};
A.poBack=()=>{U.st.poCur=null;stReload('po');};
A.poOpen=async d=>{try{U.st.poCur=(await PlemmoAPI.get('/purchase-orders/'+encodeURIComponent(d.id))).purchaseOrder;renderView();}catch(e){toast(stErr(e,'The order could not be opened'),'warn');}};
async function poRefresh(){U.st.poCur=(await PlemmoAPI.get('/purchase-orders/'+encodeURIComponent(U.st.poCur.id))).purchaseOrder;renderView();}
A.poNew=()=>{
  const sup=(U.st.sup||[]).filter(x=>x.is_active!==0);
  if(!sup.length){toast('Add a supplier first (Suppliers tab)','warn');return;}
  const L=modal({title:'New purchase order',cls:'narrow',body:`<div class="fgrid"><label class="field"><span>Supplier</span><select class="input" id="poSup">${sup.map(x=>`<option value="${stEsc(x.id)}">${stEsc(x.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Your reference</span><input class="input" id="poRef" maxlength="60" placeholder="For example, PO-1001"></label>
    <label class="field"><span>Expected on</span><input class="input" id="poExp" type="date"></label></div>`,foot:`<button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="poGo">Create</button>`});
  L.el.querySelector('#poGo').onclick=async()=>{
    try{const r=await PlemmoAPI.post('/purchase-orders',{supplier_id:L.el.querySelector('#poSup').value,reference_number:L.el.querySelector('#poRef').value.trim()||undefined,expected_date:L.el.querySelector('#poExp').value||undefined},{idempotent:false});L.close();U.st.poCur=(await PlemmoAPI.get('/purchase-orders/'+encodeURIComponent(r.purchaseOrder.id))).purchaseOrder;renderView();}
    catch(e){toast(stErr(e,'The order could not be created'),'warn');}
  };
};
A.poAddItem=()=>{
  const prods=S.products.filter(p=>p.stock!=null);
  if(!prods.length){toast('No items have stock tracking switched on','warn');return;}
  const L=modal({title:'Add an item',cls:'narrow',body:`<div class="fgrid"><label class="field"><span>Item</span><select class="input" id="piP">${prods.map(p=>`<option value="${stEsc(p.id)}" data-cost="${p.cost||0}">${stEsc(p.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Quantity</span><input class="input" id="piQ" type="number" min="1" step="1" value="1"></label>
    <label class="field"><span>Cost each</span><input class="input" id="piC" type="number" min="0" step="0.01" value="${prods[0].cost||0}"></label></div>`,foot:`<button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="piGo">Add</button>`});
  L.el.querySelector('#piP').onchange=e=>{L.el.querySelector('#piC').value=e.target.selectedOptions[0].dataset.cost;};
  L.el.querySelector('#piGo').onclick=async()=>{
    const q=Number(L.el.querySelector('#piQ').value),c=Number(L.el.querySelector('#piC').value);
    if(!(q>0)||!(c>=0)){toast('Enter a quantity above zero and a cost','warn');return;}
    try{await PlemmoAPI.post('/purchase-orders/'+encodeURIComponent(U.st.poCur.id)+'/items',{product_id:L.el.querySelector('#piP').value,quantity_ordered:q,unit_cost:c},{idempotent:false});L.close();await poRefresh();}
    catch(e){toast(stErr(e,'The item was not added'),'warn');}
  };
};
A.poDelItem=async d=>{try{await PlemmoAPI.del('/purchase-orders/'+encodeURIComponent(U.st.poCur.id)+'/items/'+encodeURIComponent(d.id),{idempotent:false});await poRefresh();}catch(e){toast(stErr(e,'It could not be removed'),'warn');}};
A.poOrder=async()=>{if(!await confirmBox({title:'Mark as ordered?',text:'The order can no longer be edited. You can receive the goods when they arrive.',ok:'Mark as ordered'}))return;try{await PlemmoAPI.post('/purchase-orders/'+encodeURIComponent(U.st.poCur.id)+'/mark-ordered',{},{idempotent:false});toast('Order marked as ordered');await poRefresh();}catch(e){toast(stErr(e,'It could not be marked as ordered'),'warn');}};
A.poCancel=async()=>{if(!await confirmBox({title:'Cancel this order?',text:'Anything already received stays in stock.',ok:'Cancel order',danger:true}))return;try{await PlemmoAPI.post('/purchase-orders/'+encodeURIComponent(U.st.poCur.id)+'/cancel',{},{idempotent:false});await poRefresh();}catch(e){toast(stErr(e,'It could not be cancelled'),'warn');}};
A.poReceive=()=>{
  const po=U.st.poCur,items=(po.items||[]).filter(i=>i.quantity_ordered-i.quantity_received>0);
  const L=modal({title:'Receive goods',sub:'Enter what actually arrived. It is added to your stock.',body:`<table class="tbl"><thead><tr><th>Item</th><th class="r">Outstanding</th><th class="r">Arrived</th><th class="r">Cost each</th></tr></thead><tbody>${items.map(i=>`<tr data-i="${stEsc(i.id)}"><td>${stEsc(pName(i.product_id))}</td><td class="r num">${stQty(i.quantity_ordered-i.quantity_received)}</td><td class="r"><input class="input num" style="width:80px;text-align:right" type="number" min="0" step="1" data-q value="${i.quantity_ordered-i.quantity_received}"></td><td class="r"><input class="input num" style="width:90px;text-align:right" type="number" min="0" step="0.01" data-c value="${i.unit_cost}"></td></tr>`).join('')}</tbody></table>`,
    foot:`<button class="btn" data-act="closeTop">Cancel</button><button class="btn btn-primary" id="rcGo">Receive into stock</button>`});
  L.el.querySelector('#rcGo').onclick=async()=>{
    const lines=Array.from(L.el.querySelectorAll('tr[data-i]')).map(r=>({itemId:r.dataset.i,quantity:Number(r.querySelector('[data-q]').value),unitCost:Number(r.querySelector('[data-c]').value)})).filter(l=>l.quantity>0);
    if(!lines.length){toast('Enter how many arrived','warn');return;}
    try{
      const key='rcv-'+uid('r');
      await PlemmoAPI.post('/purchase-orders/'+encodeURIComponent(po.id)+'/receive',{items:lines,idempotency_key:key,request_hash:JSON.stringify(lines)},{idempotent:false});
      L.close();if(window.PlemmoCatalogue&&PlemmoCatalogue.load)try{await PlemmoCatalogue.load(S);}catch(e){/* refreshed later */}
      toast('Goods received into stock');renderRail();await poRefresh();
    }catch(e){toast(stErr(e,'The goods were not received'),'warn',{ms:5200});}
  };
};

/* ---------- Options (sizes, colours …) of an item ---------- */
function variantStockCell(p){const n=p.variants.length,tot=sum(p.variants,v=>v.stock||0);return`<b class="num">${stQty(tot)}</b> <span class="muted">across ${n} option${n===1?'':'s'}</span>`;}
A.varEdit=async d=>{
  const p=prod(d.id);if(!p)return;
  let list;
  try{list=((await PlemmoAPI.get('/retail/variants?product_id='+encodeURIComponent(p.id))).variants||[]).filter(v=>v.is_active!==0);}
  catch(e){toast(stErr(e,'The options could not be read'),'warn');return;}
  const inp=(cls,val,w,ph,type)=>`<input class="input ${cls}" ${type?`type="${type}"`:''} style="width:${w}px" value="${stEsc(val==null?'':val)}" placeholder="${ph||''}">`;
  const rows=list.map(v=>{const live=(p.variants||[]).find(x=>x.id===v.id);return`<tr data-v="${stEsc(v.id)}"><td>${inp('vn',v.name,110,'Name')}</td><td>${inp('vp',v.price,80,'Price','number')}</td><td>${inp('vc',v.cost,70,'Cost','number')}</td><td>${inp('vs',v.sku,90,'SKU')}</td><td>${inp('vb',v.barcode,120,'Barcode')}</td><td class="num">${live&&live.stock!=null?stQty(live.stock):''}</td><td class="r" style="white-space:nowrap"><button class="btn btn-sm" data-s>Save</button> <button class="btn btn-sm btn-ghost" data-r>Remove</button></td></tr>`;}).join('');
  const L=modal({title:`Options: ${esc(p.name)}`,sub:'Sizes, colours or anything with its own price, barcode and stock',cls:'rc-modal',body:`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Price</th><th>Cost</th><th>SKU</th><th>Barcode</th><th>Stock</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="7" class="muted">No options yet. An item with options is sold as one of them.</td></tr>'}</tbody></table></div>
    <h4 style="margin:16px 0 8px">Add an option</h4><div class="row" style="gap:8px;flex-wrap:wrap" id="vnew">${inp('vn',"",110,'Name')}${inp('vp',p.price,80,'Price','number')}${inp('vc',p.cost||0,70,'Cost','number')}${inp('vs',"",90,'SKU')}${inp('vb',"",120,'Barcode')}${inp('vq',0,80,'Opening stock','number')}<button class="btn btn-primary" id="vadd">Add option</button></div>
    <p class="hint">Stock of each option is counted and corrected with Stocktake or Import stock. Opening stock is recorded in the stock history.</p>`,foot:`<span class="spacer"></span><button class="btn btn-primary" data-act="closeTop">Done</button>`});
  const reload=async()=>{try{await PlemmoCatalogue.load(S);}catch(e){/* shown next load */}L.close();renderView();A.varEdit({id:p.id});};
  const val=(el,c)=>(el.querySelector('.'+c)||{}).value||'';
  L.el.addEventListener('click',async e=>{
    const tr=e.target.closest('tr[data-v]');
    if(tr&&e.target.closest('[data-s]')){
      try{await PlemmoAPI.request('/retail/variants/'+encodeURIComponent(tr.dataset.v),{method:'PUT',body:{name:val(tr,'vn').trim(),price:Number(val(tr,'vp')),cost:Number(val(tr,'vc'))||0,sku:val(tr,'vs').trim()||null,barcode:val(tr,'vb').trim()||null},idempotent:false});toast('Option saved');await reload();}
      catch(er){toast(stErr(er,'The option was not saved'),'warn');}
    }else if(tr&&e.target.closest('[data-r]')){
      if(!await confirmBox({title:'Remove this option?',text:'It can no longer be sold. Past sales keep it.',ok:'Remove',danger:true}))return;
      try{await PlemmoAPI.del('/retail/variants/'+encodeURIComponent(tr.dataset.v),{idempotent:false});toast('Option removed');await reload();}catch(er){toast(stErr(er,'It could not be removed'),'warn');}
    }else if(e.target.closest('#vadd')){
      const n=L.el.querySelector('#vnew');const name=val(n,'vn').trim(),price=Number(val(n,'vp')),qty=Math.round(Number(val(n,'vq'))||0);
      if(!name||!(price>=0)||val(n,'vp')===''){toast('Give the option a name and a price','warn');return;}
      try{
        const r=await PlemmoAPI.post('/retail/variants',{product_id:p.id,name,price,cost:Number(val(n,'vc'))||0,sku:val(n,'vs').trim()||null,barcode:val(n,'vb').trim()||null},{idempotent:false});
        if(qty>0)await PlemmoAPI.post('/inventory/adjust',{product_id:p.id,variant_id:r.variant.id,quantity_delta:qty,movement_type:'receipt',reason:'Opening stock'},{idempotent:false});
        toast(`${name} added`);await reload();
      }catch(er){toast(stErr(er,'The option was not added'),'warn');}
    }
  });
};
