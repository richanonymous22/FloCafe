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
  if(!['log','take','value'].includes(t)||U.st[t+'Key'])return;
  U.st[t+'Key']=1;
  const done=()=>{if(U.view==='items')renderView();};
  if(t==='log')PlemmoAPI.get('/inventory/movements?limit=150').then(r=>{U.st.log=r.movements;done();}).catch(e=>{U.st.log=[];toast(stErr(e,'The stock ledger could not be read'),'warn');done();});
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
