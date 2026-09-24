
/* =====================================================================
   ANALYTICS HELPERS
   ===================================================================== */
function paidIn(a,b){return S.orders.filter(o=>o.status==='paid'&&o.ts>=a&&o.ts<b);}
function ordersIn(a,b){return S.orders.filter(o=>o.ts>=a&&o.ts<b&&o.status!=='open'&&o.status!=='void');}
function stats(a,b){
  const all=ordersIn(a,b),paid=all.filter(o=>o.status==='paid'),ref=all.filter(o=>o.status==='refunded');
  const gross=sum(paid,o=>o.total),tax=sum(paid,o=>o.tax),net=gross-tax,cost=sum(paid,o=>sum(o.items,l=>(l.cost||0)*l.qty));
  const pm=m=>sum(paid,o=>sum(o.payments.filter(p=>p.m===m),p=>p.a));
  return{paid,count:paid.length,gross,tax,net,cost,profit:net-cost,margin:net?(net-cost)/net:0,tips:sum(paid,o=>o.tip||0),disc:sum(paid,o=>o.discAmt||0),
    refunds:sum(ref,o=>o.total),refCount:ref.length,avg:paid.length?gross/paid.length:0,items:sum(paid,o=>sum(o.items,l=>l.qty)),card:pm('card'),cash:pm('cash'),members:paid.filter(o=>o.custId).length};
}
function itemStatsFrom(orders){
  const m={};
  orders.forEach(o=>o.items.forEach(l=>{const x=m[l.pid]||(m[l.pid]={pid:l.pid,name:l.name,qty:0,sales:0,cost:0});x.qty+=l.qty;x.sales+=lineTotal(l);x.cost+=(l.cost||0)*l.qty;}));
  return Object.values(m).map(x=>{const n=netPrice(1)*x.sales;return{...x,net:n,profit:n-x.cost,margin:n?(n-x.cost)/n:0};});
}
function niceMax(v){if(v<=0)return 1;const p=Math.pow(10,Math.floor(Math.log10(v))),n=v/p;return(n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p;}
function barsHTML({vals,prev,labels,tips,h=200,now=-1,fmt=moneyK,every=1,gap}){
  const n=vals.length,mx=niceMax(Math.max(1,...vals,...(prev||[])));
  const grid=[0,.25,.5,.75,1].map(f=>`<div style="top:${(1-f)*100}%"></div><span style="top:${(1-f)*100}%">${fmt(mx*f)}</span>`).join('');
  return`<div class="bars" style="--n:${n};--h:${h}px;${gap?'--gap:'+gap:''}"><div class="bars-grid" aria-hidden="true">${grid}</div>${vals.map((v,i)=>`<div class="bc ${i===now?'now':''}" data-tip="${esc(tips[i]||'')}">${prev?`<span class="bp" style="height:${clamp(prev[i]/mx*100,0,100)}%"></span>`:''}<span class="bv" style="height:${clamp(v/mx*100,0,100)}%;${v?'':'min-height:0'}"></span></div>`).join('')}</div>
   <div class="bars-x" style="--n:${n};${gap?'--gap:'+gap:''}" aria-hidden="true">${labels.map((l,i)=>`<span>${i%every===0?esc(l):''}</span>`).join('')}</div>`;
}
function sparkHTML(vals){
  if(vals.length<2)return'';const mx=Math.max(...vals),mn=Math.min(...vals);
  const pts=vals.map((v,i)=>`${(i/(vals.length-1)*100).toFixed(1)},${(25-(v-mn)/((mx-mn)||1)*22).toFixed(1)}`).join(' ');
  return`<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function deltaHTML(cur,prev,invert=false){
  if(!prev)return cur?'<span class="delta flat">New</span>':'<span class="delta flat">–</span>';
  const d=(cur-prev)/prev,up=d>=.005,down=d<=-.005,good=invert?down:up,bad=invert?up:down;
  return`<span class="delta ${good?'up':bad?'down':'flat'}">${up?ic('up',14):down?ic('down',14):''}${Math.abs(d*100).toFixed(Math.abs(d)<.1?1:0)}%</span>`;
}
function donutHTML(parts,size=156){
  const tot=sum(parts,p=>p.value)||1,r=size/2-16,C=2*Math.PI*r;let off=0;
  const segs=parts.map(p=>{const len=p.value/tot*C;const s=`<circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${p.color}" stroke-width="22" stroke-dasharray="${Math.max(0,len-2).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" data-tip="${esc(p.label)}: ${money(p.value)} (${pct(p.value/tot)})"></circle>`;off+=len;return s;}).join('');
  return`<div style="position:relative;width:${size}px;height:${size}px;flex:none"><svg class="donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Sales by category"><circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--sunken)" stroke-width="22"></circle>${segs}</svg><div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;pointer-events:none"><div><b class="num" style="font-family:var(--f-display);font-size:21px;display:block;letter-spacing:-.02em">${moneyK(tot)}</b><span class="muted" style="font-size:12px">item sales</span></div></div></div>`;
}
const weekday=t=>new Date(t).toLocaleDateString('en-GB',{weekday:'long'});
function labourFor(a,b){
  const wages=sum(S.employees,e=>hoursIn(e.id,a,b)*(e.rate||0)),net=stats(a,b).net;
  return{wages,net,pct:net?wages/net:0,hours:sum(S.employees,e=>hoursIn(e.id,a,b))};
}
function csv(rows){return rows.map(r=>r.map(v=>{v=String(v??'');return/[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;}).join(',')).join('\n');}
function ordersCSV(orders){
  return csv([['Order','Date','Time','Status','Type','Source','Staff','Customer','Items','Subtotal','Discount','Tax','Total','Tip','Payment'],
    ...orders.map(o=>[o.no,new Date(o.ts).toLocaleDateString('en-GB'),fmtT(o.ts),o.status,typeLabel(o.type),o.source==='kiosk'?'Kiosk':'Register',(emp(o.empId)||{}).name||'',o.custId?(cust(o.custId)||{}).name||'':'',o.items.map(l=>l.qty+'x '+l.name).join('; '),o.subtotal.toFixed(2),(o.discAmt||0).toFixed(2),o.tax.toFixed(2),o.total.toFixed(2),(o.tip||0).toFixed(2),payLabel(o)])]);
}

/* ---------- Downloads ---------- */
let SAMPLE=null,DL=null,TOOLS_OK=false,CAPS_READY=false;
async function offerDownload(filename,data){
  if(DL){
    try{const r=await DL.save({filename,data});if(r&&r.status==='saved')toast(`${filename} saved`);return;}
    catch(e){const c=e&&e.code;if(c==='declined')return;if(c==='rate_limited'){toast('A download is already waiting for you to confirm','warn');return;}if(c==='too_large'){toast('That file is too large to save here','warn');return;}}
  }
  let top=false;try{top=window.top===window;}catch(e){}
  if(top&&!window.claude){try{const u=URL.createObjectURL(new Blob([data],{type:filename.endsWith('.csv')?'text/csv':'application/json'}));const a=document.createElement('a');a.href=u;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000);toast(`${filename} downloaded`);return;}catch(e){}}
  try{await navigator.clipboard.writeText(data);toast(`Downloads aren’t available here, so ${filename} was copied to your clipboard`,'info',{ms:5000});return;}catch(e){}
  modal({title:'Copy your file',cls:'wide',body:`<p class="muted">Downloads aren’t available here. Copy the text below and save it as <b>${esc(filename)}</b>.</p><textarea class="input mt" style="min-height:280px;font-family:var(--f-mono);font-size:12px" readonly>${esc(data)}</textarea>`});
}

/* =====================================================================
   HOME
   ===================================================================== */
VIEWS.home=()=>{
  const e=me(),s=S.settings,now=Date.now(),t0=dayStart(0),lw=dayStart(-7),el=now-t0,fin=can('reports');
  const T=stats(t0,now),P=stats(lw,lw+el),PF=stats(lw,lw+DAY);
  const hrs=[];for(let h=s.openHour;h<s.closeHour;h++)hrs.push(h);
  const curH=new Date().getHours();
  const hv=hrs.map(h=>sum(paidIn(t0+h*HOUR,t0+(h+1)*HOUR),o=>o.total));
  const hp=hrs.map(h=>sum(paidIn(lw+h*HOUR,lw+(h+1)*HOUR),o=>o.total));
  const tips=hrs.map((h,i)=>`${String(h).padStart(2,'0')}:00 to ${String(h+1).padStart(2,'0')}:00\nToday ${t0+h*HOUR>now?'not yet':money(hv[i])}\nLast ${weekday(lw)} ${money(hp[i])}`);
  const tape=S.orders.filter(o=>o.ts>=t0&&o.status!=='open').sort((a,b)=>b.ts-a.ts).slice(0,11);
  // needs attention
  const att=[];
  lowStock().forEach(p=>att.push({sev:p.stock<=0?'bad':'warn',t:`${p.name}: ${p.stock<=0?'sold out':p.stock+' left'}`,s:'Reorder or mark it sold out',act:'goLow'}));
  const late=S.tickets.filter(t=>t.status!=='ready'&&t.status!=='done'&&now-t.ts>=10*MIN);
  if(late.length)att.unshift({sev:'bad',t:`${late.length} kitchen ticket${late.length>1?'s':''} over 10 minutes`,s:'Oldest is order '+late.sort((a,b)=>a.ts-b.ts)[0].no,act:'nav',v:'kitchen'});
  S.orders.filter(o=>o.status==='open'&&o.table&&now-o.opened>=60*MIN).forEach(o=>att.push({sev:'warn',t:`Table ${(tableOf(o.table)||{}).name} seated over an hour`,s:`${money(o.total)} not paid yet`,act:'nav',v:'tables'}));
  if(!S.drawer.open&&can('cash')&&new Date().getHours()>=s.openHour&&new Date().getHours()<s.closeHour)att.push({sev:'info',t:'The cash drawer isn’t open',s:'Open it with a float before taking cash',act:'nav',v:'cash'});
  if(S.held.length)att.push({sev:'info',t:`${S.held.length} held order${S.held.length>1?'s':''}`,s:'Waiting on the register',act:'nav',v:'pos'});
  const top=itemStatsFrom(T.paid).sort((a,b)=>b.qty-a.qty).slice(0,5),topMax=top.length?top[0].qty:1;
  const onNow=S.employees.filter(x=>onShift(x.id));
  const week=[...Array(7)].map((_,i)=>{const a=dayStart(i-6);return{a,v:sum(paidIn(a,Math.min(a+DAY,now)),o=>o.total)};}),wMax=Math.max(1,...week.map(w=>w.v));
  const ins=fin?insights().slice(0,3):[];
  const heroNum=fin?money(T.gross):String(salesBy(e.id,t0,now).length);
  return`<div class="page">
   <div class="page-head"><div><h2>${greeting()}, ${esc(first(e.name))}</h2><p class="greet-date">${fmtDL(now)}, open ${String(s.openHour).padStart(2,'0')}:00 to ${String(s.closeHour).padStart(2,'0')}:00</p></div>
    <div class="ph-actions">${can('pos')?`<button class="btn btn-primary btn-lg" data-act="nav" data-v="pos">${ic('register',18)} ${U.cart&&U.cart.items.length?'Back to the sale':'New sale'}</button>`:''}${s.kioskEnabled&&can('pos')?`<button class="btn btn-lg" data-act="nav" data-v="kiosk">${ic('kiosk',18)} Kiosk</button>`:''}${fin?`<button class="btn btn-lg" data-act="eod">${ic('receipt',18)} Day report</button>`:''}</div></div>
   <div class="grid g-hero">
    <section class="panel"><div class="panel-b" style="padding:22px 22px 18px">
     <div class="hero-top"><div><div class="muted" style="font-weight:600">${fin?'Takings today':'Orders you’ve taken today'}</div><div class="hero-num num">${heroNum}</div></div>
      ${fin?`<div style="text-align:right"><div>${deltaHTML(T.gross,P.gross)} <span class="muted" style="font-size:13px">vs this time last ${weekday(lw)}</span></div><div class="faint" style="font-size:12.5px;margin-top:4px">Last ${weekday(lw)} finished on ${money(PF.gross,0)}</div></div>`:''}</div>
     <div class="hero-stats"><div><b class="num">${T.count}</b><span>Orders</span></div>${fin?`<div><b class="num">${money(T.avg)}</b><span>Average order</span></div>`:''}<div><b class="num">${T.items}</b><span>Items sold</span></div><div><b class="num">${T.members}</b><span>Loyalty visits</span></div>${fin?`<div><b class="num">${moneyK(T.tips)}</b><span>Tips</span></div>`:''}</div>
     ${fin?`${barsHTML({vals:hv,prev:hp,labels:hrs.map(h=>String(h).padStart(2,'0')),tips,h:170,now:hrs.indexOf(curH)})}<div class="chart-key" style="margin-top:12px"><span><i></i>Today</span><span><i class="prev"></i>Last ${weekday(lw)}</span></div>`:''}
    </div></section>
    <section class="tape-card" aria-label="Live till tape"><div class="row" style="margin-bottom:12px"><h3 style="font-size:15px">Live till</h3><span class="spacer"></span>${can('orders')?`<button class="btn btn-sm btn-ghost" data-act="nav" data-v="orders">All orders ${ic('chevR',14)}</button>`:''}</div>
     <div class="paper" style="margin-bottom:0">${tape.length?tape.map(o=>`<div class="tt-row ${o.status!=='paid'?'ref':''}"><span>${o.no}</span><span class="pm">${fmtT(o.ts)}</span><span class="pm" style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${o.source==='kiosk'?'Kiosk':esc(first((emp(o.empId)||{}).name||''))}</span><span>${money(o.total)}</span></div>`).join(''):'<div class="pm" style="text-align:center;padding:20px 0">No sales yet today.<br>The first one prints here.</div>'}
     <div class="rule"></div><div class="kv b"><span>${T.count} sales</span><span>${fin?money(T.gross):''}</span></div></div></section>
   </div>
   <div class="grid g3 mt">
    <section class="panel"><div class="panel-h"><h3>Needs attention</h3>${att.length?`<span class="badge ${att.some(a=>a.sev==='bad')?'bad':'warn'}">${att.length}</span>`:''}</div><div class="panel-b flush"><div class="list">
     ${att.slice(0,6).map(a=>`<div class="li click" data-act="${a.act}" data-v="${a.v||''}" role="button" tabindex="0"><span class="sevbar ${a.sev}"></span><div class="li-t"><b>${esc(a.t)}</b><small>${esc(a.s)}</small></div>${ic('chevR',16)}</div>`).join('')||`<div class="empty" style="padding:28px 16px"><div class="e-ic" style="background:var(--ok-soft);color:var(--ok-text)">${ic('check',24)}</div><h3>All clear</h3><p>Stock, kitchen and tables look fine.</p></div>`}
    </div></div></section>
    <section class="panel"><div class="panel-h"><h3>Top sellers today</h3></div><div class="panel-b">
     ${top.length?top.map(x=>{const p=prod(x.pid),c=p?catOf(p.cat):null;return`<div style="display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:10px;align-items:center;padding:6px 0"><span class="it-em" style="--c:${c?c.color:'#888'};width:34px;height:34px;font-size:18px;border-radius:10px">${p?p.emoji:'•'}</span><div style="min-width:0"><div style="display:flex;justify-content:space-between;gap:8px;font-weight:600;font-size:13.5px"><span style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(x.name)}</span><span class="num">${x.qty}</span></div><div class="bar-mini" style="margin-top:5px"><i style="width:${x.qty/topMax*100}%;background:var(--accent)"></i></div></div><span class="num muted" style="font-size:12.5px;min-width:56px;text-align:right">${fin?money(x.sales):''}</span></div>`;}).join(''):`<p class="muted">Nothing sold yet today.</p>`}
    </div></section>
    <section class="panel"><div class="panel-h"><h3>On shift</h3><span class="ph-sub">${onNow.length} people</span></div><div class="panel-b">
     ${onNow.map(x=>{const sh=onShift(x.id);return`<div class="row" style="padding:5px 0;flex-wrap:nowrap"><span class="av" style="--c:${x.color}">${initials(x.name)}</span><div style="flex:1;min-width:0"><b style="font-size:14px">${esc(x.name)}</b><div class="faint" style="font-size:12px">${esc(x.position||'')}, since ${fmtT(sh.in)}</div></div><span class="num muted" style="font-size:12.5px" data-since="${sh.in}" data-fmt="dur">${fmtHrs((now-sh.in)/HOUR)}</span></div>`;}).join('')||'<p class="muted">No one is clocked in.</p>'}
     ${fin?`<div class="rule" style="border-top:1px solid var(--line);margin:14px 0 12px"></div><div class="row" style="margin-bottom:10px"><b style="font-size:13.5px">Last 7 days</b><span class="spacer"></span><span class="num muted" style="font-size:12.5px">${money(sum(week,w=>w.v),0)}</span></div>
     <div class="minibars">${week.map((w,i)=>`<div data-tip="${fmtD(w.a)}: ${money(w.v)}"><i class="${i===6?'today':''}" style="height:${Math.max(2,w.v/wMax*100)}%"></i><span>${new Date(w.a).toLocaleDateString('en-GB',{weekday:'narrow'})}</span></div>`).join('')}</div>`:''}
    </div></section>
   </div>
   ${ins.length?`<section class="mt"><div class="row" style="margin-bottom:12px"><h3 style="font-size:15px">Worth knowing</h3><span class="spacer"></span>${can('assistant')?`<button class="btn btn-sm" data-act="nav" data-v="assistant">${ic('sparkle',16)} Ask the assistant</button>`:''}</div><div class="grid g3">${ins.map(insHTML).join('')}</div></section>`:''}
  </div>`;
};
const insHTML=x=>`<div class="ins-card ${x.k}"><span class="ins-ic">${ic(x.icon,18)}</span><div><b>${esc(x.title)}</b><p>${esc(x.text)}</p></div></div>`;
A.goLow=()=>{U.items.tab='items';U.items.cat='low';go('items');};
A.eod=()=>showZ(dayStart(0));

/* =====================================================================
   REPORTS
   ===================================================================== */
function rangeOf(r){
  const now=Date.now();
  if(r==='today')return{a:dayStart(0),b:now,shift:7*DAY,hourly:true,label:'Today so far',prev:'the same time last '+weekday(dayStart(-7)),days:1};
  if(r==='yesterday')return{a:dayStart(-1),b:dayStart(0),shift:7*DAY,hourly:true,label:'Yesterday',prev:'the '+weekday(dayStart(-1))+' before',days:1};
  if(r==='30d')return{a:dayStart(-29),b:now,shift:30*DAY,hourly:false,label:'Last 30 days',prev:'the 30 days before',days:30};
  return{a:dayStart(-6),b:now,shift:7*DAY,hourly:false,label:'Last 7 days',prev:'the 7 days before',days:7};
}
function bucketsOf(R){
  const s=S.settings,out=[];
  if(R.hourly){for(let h=s.openHour;h<s.closeHour;h++)out.push({a:R.a+h*HOUR,b:R.a+(h+1)*HOUR,label:String(h).padStart(2,'0'),tip:`${String(h).padStart(2,'0')}:00`});}
  else for(let i=0;i<R.days;i++){const a=R.a+i*DAY;out.push({a,b:a+DAY,label:R.days>7?String(new Date(a).getDate()):new Date(a).toLocaleDateString('en-GB',{weekday:'short'}),tip:fmtD(a)});}
  return out;
}
VIEWS.reports=()=>{
  const R=rangeOf(U.reports.range),now=Date.now(),s=S.settings;
  const X=stats(R.a,R.b),P=stats(R.a-R.shift,R.b-R.shift);
  const B=bucketsOf(R);
  const bv=B.map(b=>b.a>now?0:stats(b.a,Math.min(b.b,now)).net),bp=B.map(b=>stats(b.a-R.shift,b.b-R.shift).net);
  const bc=B.map(b=>b.a>now?0:paidIn(b.a,Math.min(b.b,now)).length);
  const btips=B.map((b,i)=>`${b.tip}\n${b.a>now?'Not yet':money(bv[i])+' net, '+bc[i]+' orders'}\nBefore: ${money(bp[i])}`);
  const curIdx=B.findIndex(b=>now>=b.a&&now<b.b);
  // category donut
  const items=itemStatsFrom(X.paid);
  const catMap={};items.forEach(x=>{const p=prod(x.pid),c=p?catOf(p.cat):null,k=c?c.id:'other';const o=catMap[k]||(catMap[k]={label:c?c.name:'Other',value:0,color:c?c.color:'#999'});o.value+=x.sales;});
  const cats=Object.values(catMap).sort((a,b)=>b.value-a.value);const catTot=sum(cats,c=>c.value)||1;
  // mixes
  const mix=(label,parts)=>{const tot=sum(parts,p=>p[1])||1;return`<div class="mixrow"><div class="mh"><span>${label}</span></div><div class="stackbar">${parts.filter(p=>p[1]>0).map(p=>`<i style="width:${p[1]/tot*100}%;background:${p[2]}" data-tip="${p[0]}: ${money(p[1])} (${pct(p[1]/tot)})"></i>`).join('')}</div><div class="mixleg">${parts.map(p=>`<span><i style="background:${p[2]}"></i>${p[0]} <b class="num">${pct(p[1]/tot)}</b></span>`).join('')}</div></div>`;};
  const byType=t=>sum(X.paid.filter(o=>o.type===t),o=>o.total),bySrc=x=>sum(X.paid.filter(o=>o.source===x),o=>o.total);
  const typeParts=hospitality()?[['Takeaway',byType('takeaway'),'var(--accent)'],['Dine in',byType('dine'),'var(--info)'],['Delivery',byType('delivery'),'var(--ok)']]:[['In store',byType('instore'),'var(--accent)']];
  // heatmap
  const hs=R.days>=7?[R.a,R.b]:[dayStart(-27),now];
  const hrs=[];for(let h=s.openHour;h<s.closeHour;h++)hrs.push(h);
  const dows=[1,2,3,4,5,6,0],cnt={},nDow={};
  for(let t=hs[0];t<hs[1];t+=DAY){const d=new Date(t).getDay();nDow[d]=(nDow[d]||0)+1;}
  paidIn(hs[0],hs[1]).forEach(o=>{const d=new Date(o.ts);const k=d.getDay()+'-'+d.getHours();cnt[k]=(cnt[k]||0)+1;});
  const avgC=(d,h)=>(cnt[d+'-'+h]||0)/(nDow[d]||1);
  const hMax=Math.max(.01,...dows.flatMap(d=>hrs.map(h=>avgC(d,h))));
  const dn=d=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d];
  const heat=`<div class="heat" style="--n:${hrs.length}"><span></span>${hrs.map((h,i)=>`<span class="hx">${i%2===0?String(h).padStart(2,'0'):''}</span>`).join('')}${dows.map(d=>`<span class="hl">${dn(d)}</span>${hrs.map(h=>{const v=avgC(d,h);return`<div class="hc" style="background:${v?`color-mix(in srgb,var(--accent) ${Math.round(10+v/hMax*90)}%,var(--sunken))`:'var(--sunken)'}" data-tip="${dn(d)} ${String(h).padStart(2,'0')}:00\n${v.toFixed(1)} orders on average"></div>`;}).join('')}`).join('')}</div>`;
  // top items
  const topI=[...items].sort((a,b)=>b.sales-a.sales).slice(0,10),tMax=topI.length?topI[0].sales:1;
  // staff
  const staffRows=S.employees.map(e=>{const os=X.paid.filter(o=>o.empId===e.id),h=hoursIn(e.id,R.a,R.b);return{e,n:os.length,sales:sum(os,o=>o.total),h};}).filter(r=>r.n||r.h>0).sort((a,b)=>b.sales-a.sales);
  const kioskN=X.paid.filter(o=>o.source==='kiosk');
  const kpi=(l,v,d,sub,spark)=>`<div><div class="k-l"><span>${l}</span>${d}</div><div class="k-v num">${v}</div><div class="k-s">${sub}</div>${spark}</div>`;
  const netSeries=B.map((b,i)=>bv[i]),cntSeries=bc;
  return`<div class="page">
   <div class="page-head"><div><h2>Reports</h2><p class="sub">${R.label}, compared with ${R.prev}</p></div>
    <div class="ph-actions"><div class="seg" role="tablist">${[['today','Today'],['yesterday','Yesterday'],['7d','7 days'],['30d','30 days']].map(([k,l])=>`<button class="${U.reports.range===k?'on':''}" data-act="repRange" data-r="${k}" role="tab" aria-selected="${U.reports.range===k}">${l}</button>`).join('')}</div>
     <button class="btn" data-act="repExport" data-k="orders">${ic('download',16)} Orders CSV</button><button class="btn" data-act="repExport" data-k="items">${ic('download',16)} Items CSV</button><button class="btn btn-dark" data-act="eod">${ic('receipt',16)} Day report</button></div></div>
   <div class="strip" style="--n:4">
    ${kpi('Net sales',money(X.net,X.net>=1e4?0:2),deltaHTML(X.net,P.net),`${money(X.gross,0)} incl. ${esc(s.taxName)}`,sparkHTML(netSeries))}
    ${kpi('Orders',X.count.toLocaleString('en-GB'),deltaHTML(X.count,P.count),`${X.items.toLocaleString('en-GB')} items sold`,sparkHTML(cntSeries))}
    ${kpi('Average order',money(X.avg),deltaHTML(X.avg,P.avg),`${(X.items/Math.max(1,X.count)).toFixed(1)} items per order`,'')}
    ${kpi('Gross profit',money(X.profit,X.profit>=1e4?0:2),deltaHTML(X.profit,P.profit),`${pct(X.margin)} margin after item costs`,'')}
   </div>
   <div class="grid g-73 mt">
    <section class="panel"><div class="panel-h"><h3>Net sales ${R.hourly?'by hour':'by day'}</h3><div class="chart-key"><span><i></i>${R.label}</span><span><i class="prev"></i>${R.prev.replace(/^the /,'').replace(/^./,c=>c.toUpperCase())}</span></div></div><div class="panel-b">${barsHTML({vals:bv,prev:bp,labels:B.map(b=>b.label),tips:btips,h:220,now:curIdx,every:R.days>7?3:1,gap:R.days>7?'3px':''})}</div></section>
    <section class="panel"><div class="panel-h"><h3>Sales by category</h3></div><div class="panel-b"><div class="donut-wrap">${donutHTML(cats)}<div class="leg">${cats.map(c=>`<div><i style="background:${c.color}"></i><span>${esc(c.label)}</span><em class="num">${moneyK(c.value)}</em><em class="num">${pct(c.value/catTot)}</em></div>`).join('')||'<p class="muted">No sales in this period</p>'}</div></div></div></section>
   </div>
   <div class="grid g-73 mt">
    <section class="panel"><div class="panel-h"><h3>Busiest times</h3><span class="ph-sub">Average orders per hour${R.days<7?', last 4 weeks':''}</span></div><div class="panel-b">${heat}</div></section>
    <section class="panel"><div class="panel-h"><h3>How people buy</h3></div><div class="panel-b">
     ${mix('Payment',[['Card',X.card,'var(--info)'],['Cash',X.cash,'var(--ok)']])}
     ${s.kioskEnabled?mix('Channel',[['Register',bySrc('pos'),'var(--text)'],['Kiosk',bySrc('kiosk'),'var(--accent)']]):''}
     ${mix('Order type',typeParts)}
     ${kioskN.length?`<p class="hint" style="margin-top:8px">Kiosk orders average ${money(sum(kioskN,o=>o.total)/kioskN.length)}, register orders ${money(sum(X.paid.filter(o=>o.source!=='kiosk'),o=>o.total)/Math.max(1,X.paid.length-kioskN.length))}.</p>`:''}
    </div></section>
   </div>
   <section class="panel mt"><div class="panel-h"><h3>Top items</h3><span class="ph-sub">By sales, with margin after ${esc(s.taxName)} and cost</span></div><div class="panel-b flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Item</th><th class="r">Sold</th><th class="r">Sales</th><th style="width:22%">Share</th><th class="r">Profit</th><th class="r">Margin</th></tr></thead><tbody>
    ${topI.map((x,i)=>{const p=prod(x.pid),c=p?catOf(p.cat):null;return`<tr><td class="num faint">${i+1}</td><td><div class="it-cell"><span class="it-em" style="--c:${c?c.color:'#888'};width:32px;height:32px;font-size:17px;border-radius:10px">${p?p.emoji:'•'}</span><b>${esc(x.name)}</b></div></td><td class="r num">${x.qty}</td><td class="r num">${money(x.sales)}</td><td><div class="bar-mini"><i style="width:${x.sales/tMax*100}%;background:var(--accent)"></i></div></td><td class="r num">${money(x.profit)}</td><td class="r">${marginBadge(x.margin)}</td></tr>`;}).join('')||'<tr><td colspan="7" class="muted">No sales in this period</td></tr>'}
   </tbody></table></div></div></section>
   <div class="grid g2 mt">
    <section class="panel"><div class="panel-h"><h3>Team performance</h3></div><div class="panel-b flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th class="r">Orders</th><th class="r">Sales</th><th class="r">Hours</th><th class="r">Sales per hour</th></tr></thead><tbody>
     ${staffRows.map(r=>`<tr><td><div class="it-cell"><span class="av" style="--c:${r.e.color}">${initials(r.e.name)}</span><b>${esc(r.e.name)}</b></div></td><td class="r num">${r.n}</td><td class="r num">${money(r.sales)}</td><td class="r num">${r.h.toFixed(1)}</td><td class="r num">${r.h>.1?money(r.sales/r.h):'–'}</td></tr>`).join('')}
     ${kioskN.length?`<tr><td><div class="it-cell"><span class="av" style="--c:var(--accent)">${ic('kiosk',16)}</span><b>Self-service kiosk</b></div></td><td class="r num">${kioskN.length}</td><td class="r num">${money(sum(kioskN,o=>o.total))}</td><td class="r faint">–</td><td class="r faint">–</td></tr>`:''}
    </tbody></table></div></div></section>
    <section class="panel"><div class="panel-h"><h3>Tax summary</h3><span class="ph-sub">For your ${esc(s.taxName)} return</span></div><div class="panel-b flush"><div class="tbl-wrap"><table class="tbl"><tbody>
     <tr><td>Gross sales, incl. ${esc(s.taxName)}</td><td class="r num">${money(X.gross+X.disc)}</td></tr>
     <tr><td>Discounts given</td><td class="r num">−${money(X.disc)}</td></tr>
     <tr><td>Sales after discounts</td><td class="r num">${money(X.gross)}</td></tr>
     <tr><td>${esc(s.taxName)} collected at ${s.taxRate}%</td><td class="r num">${money(X.tax)}</td></tr>
     <tr><td>Net sales</td><td class="r num">${money(X.net)}</td></tr>
     <tr><td>Refunded (${X.refCount} order${X.refCount===1?'':'s'})</td><td class="r num">${money(X.refunds)}</td></tr>
     <tr><td>Tips, passed to the team</td><td class="r num">${money(X.tips)}</td></tr>
    </tbody><tfoot><tr><td>Card ${money(X.card,0)}, cash ${money(X.cash,0)}</td><td class="r num">${money(X.card+X.cash)}</td></tr></tfoot></table></div></div></section>
   </div></div>`;
};
A.repRange=d=>{U.reports.range=d.r;renderView();};
A.repExport=d=>{
  const R=rangeOf(U.reports.range),tag=U.reports.range+'-'+new Date().toISOString().slice(0,10);
  if(d.k==='orders'){const os=S.orders.filter(o=>o.ts>=R.a&&o.ts<R.b&&o.status!=='open').sort((a,b)=>a.ts-b.ts);offerDownload(`orders-${tag}.csv`,ordersCSV(os));}
  else{const it=itemStatsFrom(paidIn(R.a,R.b)).sort((a,b)=>b.sales-a.sales);offerDownload(`items-${tag}.csv`,csv([['Item','Category','Sold','Sales','Net of tax','Cost','Profit','Margin'],...it.map(x=>{const p=prod(x.pid);return[x.name,p?(catOf(p.cat)||{}).name||'':'',x.qty,x.sales.toFixed(2),x.net.toFixed(2),x.cost.toFixed(2),x.profit.toFixed(2),pct(x.margin,1)];})]));}
};

/* ---------- End-of-day (X/Z) report ---------- */
function showZ(day){
  const now=Date.now(),a=day,b=Math.min(day+DAY,now),isToday=day===dayStart(0),x=stats(a,b),s=S.settings;
  const it=itemStatsFrom(x.paid).sort((p,q)=>q.qty-p.qty).slice(0,6);
  const byT={};x.paid.forEach(o=>{byT[o.type]=(byT[o.type]||0)+o.total;});
  const byS={};x.paid.forEach(o=>{const k=o.source==='kiosk'?'Kiosk':first((emp(o.empId)||{}).name||'Unknown');byS[k]=(byS[k]||0)+o.total;});
  const hrs={};x.paid.forEach(o=>{const h=new Date(o.ts).getHours();hrs[h]=(hrs[h]||0)+o.total;});
  const peak=Object.entries(hrs).sort((p,q)=>q[1]-p[1])[0];
  const sess=[...S.drawer.history,...(S.drawer.open?[S.drawer.open]:[])].filter(d=>d.ts>=a&&d.ts<a+DAY);
  const code=new Date(day).toISOString().slice(0,10).replace(/-/g,'');
  const kv=(k,v,cls='')=>`<div class="kv ${cls}"><span>${k}</span><span>${v}</span></div>`;
  const body=`<div class="paper receipt rc-print">
   <div class="p-h"><b>${esc(s.name)}</b>${s.address?`<span class="pm">${esc(s.address)}</span>`:''}</div>
   <div class="rule"></div>
   <div class="p-h"><b>${isToday?'X REPORT, DAY SO FAR':'Z REPORT, END OF DAY'}</b><span class="pm">${isToday?'X':'Z'}-${code}</span></div>
   ${kv(fmtD(day),isToday?'at '+fmtT(now):'closed','pm')}
   <div class="rule"></div><div class="p-sec">SALES</div>
   ${kv('Orders',x.count)}${kv('Items sold',x.items)}
   ${kv('Gross sales',money(x.gross+x.disc))}${kv('Discounts','−'+money(x.disc))}
   ${kv('Sales',money(x.gross),'b')}
   ${kv(`${esc(s.taxName)} ${s.taxRate}%`,money(x.tax),'pm')}${kv('Net sales',money(x.net))}
   ${kv(`Refunds (${x.refCount})`,money(x.refunds))}${kv('Tips',money(x.tips))}
   <div class="rule"></div><div class="p-sec">TAKINGS</div>
   ${kv('Card',money(x.card))}${kv('Cash',money(x.cash))}${kv('Total',money(x.card+x.cash),'b')}
   <div class="rule"></div><div class="p-sec">BY TYPE</div>
   ${Object.entries(byT).map(([k,v])=>kv(typeLabel(k),money(v))).join('')||'<div class="pm">No sales</div>'}
   <div class="rule"></div><div class="p-sec">BY TEAM MEMBER</div>
   ${Object.entries(byS).sort((p,q)=>q[1]-p[1]).map(([k,v])=>kv(esc(k),money(v))).join('')||'<div class="pm">No sales</div>'}
   <div class="rule"></div><div class="p-sec">TOP ITEMS</div>
   ${it.map(i=>kv(`${i.qty} ${esc(i.name)}`,money(i.sales))).join('')||'<div class="pm">No sales</div>'}
   <div class="rule"></div><div class="p-sec">CASH DRAWER</div>
   ${sess.length?sess.map(d=>{const n=drawerNumbers(d);return kv('Float',money(d.float))+kv('Expected in drawer',money(d.closedTs?d.expected:n.expected))+(d.closedTs?kv('Counted',money(d.counted))+kv('Result',Math.abs(d.variance)<.01?'Balanced':(d.variance>0?'Over ':'Short ')+money(Math.abs(d.variance)),'b'):kv('Status','Still open'));}).join('<div class="rule"></div>'):'<div class="pm">No drawer session</div>'}
   ${peak?`<div class="rule"></div>${kv('Busiest hour',`${String(peak[0]).padStart(2,'0')}:00, ${money(peak[1])}`)}`:''}
   <div class="rule"></div><div class="p-h pm">Printed ${fmtDT(now)} by ${esc(first((me()||{}).name||''))}</div>
  </div>`;
  modal({title:isToday?'Day so far':'End of day',sub:fmtDL(day),cls:'rc-modal',body,foot:`<button class="btn" data-act="printRc">${ic('printer',18)} Print</button><button class="btn" data-act="zCsv" data-t="${day}">${ic('download',18)} Orders CSV</button><span class="spacer"></span><button class="btn btn-primary" data-act="closeTop">Done</button>`});
}
A.zCsv=d=>{const a=+d.t;offerDownload(`orders-${new Date(a).toISOString().slice(0,10)}.csv`,ordersCSV(S.orders.filter(o=>o.ts>=a&&o.ts<a+DAY&&o.status!=='open').sort((p,q)=>p.ts-q.ts)));};

/* =====================================================================
   INSIGHTS ENGINE (works offline)
   ===================================================================== */
function runOut(){
  const a=dayStart(-14),q={};
  paidIn(a,dayStart(0)).forEach(o=>o.items.forEach(l=>q[l.pid]=(q[l.pid]||0)+l.qty));
  return S.products.filter(p=>p.stock!=null&&p.available).map(p=>{const perDay=(q[p.id]||0)/14;return{p,perDay,days:perDay?p.stock/perDay:99};}).sort((x,y)=>x.days-y.days);
}
function insights(){
  const out=[],now=Date.now(),t0=dayStart(0),s=S.settings,L=s.loyalty;
  const T=stats(t0,now),P=stats(t0-7*DAY,now-7*DAY);
  if(T.count>=3&&P.gross){const d=(T.gross-P.gross)/P.gross;out.push({k:d>=0?'good':'watch',icon:d>=0?'up':'down',title:`Sales ${d>=0?'up':'down'} ${Math.abs(d*100).toFixed(0)}% on last ${weekday(t0-7*DAY)}`,text:`${money(T.gross)} so far against ${money(P.gross)} by this time last week, from ${T.count} orders.`});}
  const ro=runOut().filter(x=>x.days<1.6);
  if(ro.length){const x=ro[0];out.push({k:'risk',icon:'alert',title:`${x.p.name} could run out ${x.days<.8?'today':'tomorrow'}`,text:`${x.p.stock} left and you sell about ${x.perDay.toFixed(1)} a day.${ro.length>1?` ${ro.length-1} more item${ro.length>2?'s are':' is'} close too.`:''} Reorder before the morning rush.`});}
  const cur=itemStatsFrom(paidIn(dayStart(-6),now)),prv=itemStatsFrom(paidIn(dayStart(-13),dayStart(-6)));
  const trend=cur.filter(x=>x.qty>=10).map(x=>{const p=prv.find(y=>y.pid===x.pid);return{...x,g:p&&p.qty?(x.qty-p.qty)/p.qty:0};}).sort((a,b)=>b.g-a.g)[0];
  if(trend&&trend.g>.12)out.push({k:'good',icon:'star',title:`${trend.name} is trending`,text:`${trend.qty} sold this week, up ${pct(trend.g)} on the week before. Keep it stocked and visible at the counter.`});
  const lab=labourFor(weekStart(0),now);
  if(lab.net>200)out.push({k:lab.pct<.25?'good':lab.pct<.32?'watch':'risk',icon:'users',title:`Labour is ${pct(lab.pct,1)} of sales this week`,text:lab.pct<.25?`Healthy. ${money(lab.wages,0)} in wages against ${money(lab.net,0)} net sales.`:`${money(lab.wages,0)} in wages against ${money(lab.net,0)} net sales. Check quiet afternoons on the heatmap before the next rota.`});
  const lapsed=S.customers.filter(c=>c.visits>=4&&c.last&&now-c.last>21*DAY).sort((a,b)=>b.spend-a.spend);
  if(lapsed.length)out.push({k:'watch',icon:'heart',title:lapsed.length>1?`${lapsed.length} regulars haven’t been in for 3 weeks`:`${first(lapsed[0].name)}, a regular, hasn’t been in for 3 weeks`,text:`${lapsed.slice(0,3).map(c=>first(c.name)).join(', ')}${lapsed.length>3?' and others':''}. A points bonus could bring them back.`});
  const ready=S.customers.filter(c=>c.points>=L.redeemPts).length;
  if(L.on&&ready)out.push({k:'good',icon:'heart',title:`${ready} customer${ready>1?'s have':' has'} a reward waiting`,text:`They have ${L.redeemPts}+ points, worth ${money(L.redeemVal)} off. Mention it when they’re at the till.`});
  const cof=paidIn(dayStart(-6),now).flatMap(o=>o.items).filter(l=>{const p=prod(l.pid);return p&&(p.mods||[]).includes('m-extra');});
  if(cof.length>40){const withX=cof.filter(l=>l.mods.some(m=>m.g==='m-extra'&&m.p>0)).length,r=withX/cof.length;if(r<.2)out.push({k:'watch',icon:'bulb',title:`Only ${pct(r)} of coffees get a paid extra`,text:`Offering a syrup or extra shot on one in ten more of this week’s ${cof.length} coffees would add about ${money(cof.length*.1*.55,0)} a week.`});}
  const k=paidIn(dayStart(-6),now),ko=k.filter(o=>o.source==='kiosk'),po=k.filter(o=>o.source!=='kiosk');
  if(ko.length>10&&po.length){const ka=sum(ko,o=>o.total)/ko.length,pa=sum(po,o=>o.total)/po.length;if(ka>pa*1.03)out.push({k:'good',icon:'kiosk',title:`Kiosk orders are ${pct((ka-pa)/pa)} bigger`,text:`${money(ka)} on average against ${money(pa)} at the register. The add-on suggestions are working.`});}
  const lowM=cur.filter(x=>x.qty>=12&&x.margin<.62).sort((a,b)=>a.margin-b.margin)[0];
  if(lowM)out.push({k:'watch',icon:'tag',title:`${lowM.name} earns the least per sale`,text:`${pct(lowM.margin)} margin on ${lowM.qty} sold this week. A ${money(.3)} price rise would add about ${money(lowM.qty*.25,0)} a week.`});
  const v=S.drawer.history.slice(-7).filter(h=>h.variance<-2);
  if(v.length)out.push({k:'watch',icon:'cash',title:`Cash drawer short on ${v.length} day${v.length>1?'s':''} this week`,text:`Biggest gap ${money(Math.abs(Math.min(...v.map(h=>h.variance))))} on ${fmtD(v.sort((a,b)=>a.variance-b.variance)[0].ts)}. Check no-sale opens and pay-outs.`});
  const order={risk:0,watch:1,good:2};
  return out.sort((a,b)=>order[a.k]-order[b.k]);
}

/* ---------- Data snapshot for Claude ---------- */
function snapshot(){
  const now=Date.now(),t0=dayStart(0),s=S.settings;
  const st=(a,b)=>{const x=stats(a,b);return{orders:x.count,sales:r2(x.gross),netSales:r2(x.net),tax:r2(x.tax),avgOrder:r2(x.avg),itemsSold:x.items,discounts:r2(x.disc),refunds:r2(x.refunds),tips:r2(x.tips),grossProfit:r2(x.profit),card:r2(x.card),cash:r2(x.cash)};};
  const days=[...Array(14)].map((_,i)=>{const a=dayStart(i-13),x=stats(a,Math.min(a+DAY,now));return[fmtD(a),x.count,r2(x.gross)];});
  const hrs={};const a28=dayStart(-28);paidIn(a28,t0).forEach(o=>{const h=new Date(o.ts).getHours();hrs[h]=(hrs[h]||0)+1;});
  const top=itemStatsFrom(paidIn(dayStart(-6),now)).sort((a,b)=>b.sales-a.sales).slice(0,15).map(x=>[x.name,x.qty,r2(x.sales),Math.round(x.margin*100)]);
  const ws=weekStart(0),lab=labourFor(ws,now);
  const tiers={gold:0,silver:0,bronze:0};S.customers.forEach(c=>tiers[tierOf(c).k]++);
  return{
    business:{name:s.name,type:s.type,address:s.address,currency:s.currency.trim(),tax:`${s.taxName} ${s.taxRate}% ${s.taxInclusive?'included in prices':'added to prices'}`,hours:`${s.openHour}:00-${s.closeHour}:00`},
    now:fmtDT(now),
    today:st(t0,now),sameTimeLastWeek:st(t0-7*DAY,now-7*DAY),yesterday:st(dayStart(-1),t0),last7Days:st(dayStart(-6),now),previous7Days:st(dayStart(-13),dayStart(-6)),
    dailyLast14:{columns:['day','orders','sales'],rows:days},
    avgOrdersPerHourLast4Weeks:Object.fromEntries(Object.entries(hrs).map(([h,n])=>[h+':00',r2(n/28)])),
    topItemsLast7Days:{columns:['item','qty','sales','marginPct'],rows:top},
    menu:{columns:['item','category','price','cost','stock','onSale'],rows:S.products.map(p=>[p.name,(catOf(p.cat)||{}).name||'',p.price,p.cost,p.stock,p.available])},
    stockRunOut:runOut().filter(x=>x.days<5).slice(0,8).map(x=>({item:x.p.name,stock:x.p.stock,sellsPerDay:r2(x.perDay),daysLeft:r2(x.days)})),
    team:S.employees.filter(e=>e.active!==false).map(e=>{const sh=onShift(e.id),so=salesBy(e.id,ws,now);return{name:e.name,role:roleLabel(e.role),job:e.position,onShiftSince:sh?fmtT(sh.in):null,hoursThisWeek:r2(hoursIn(e.id,ws,now)),salesThisWeek:r2(sum(so,o=>o.total)),ordersThisWeek:so.length,rate:e.rate};}),
    labourThisWeek:{wages:r2(lab.wages),netSales:r2(lab.net),labourPctOfSales:Math.round(lab.pct*1000)/10},
    customers:{members:S.customers.length,tiers,readyForReward:S.customers.filter(c=>c.points>=s.loyalty.redeemPts).length,loyalty:`${s.loyalty.earn} point per ${s.currency.trim()}1, ${s.loyalty.redeemPts} points = ${money(s.loyalty.redeemVal)} off`,
      top:[...S.customers].sort((a,b)=>b.spend-a.spend).slice(0,6).map(c=>({name:c.name,visits:c.visits,spend:r2(c.spend),points:c.points,lastVisit:c.last?fmtDay(c.last):null})),
      lapsedRegulars:S.customers.filter(c=>c.visits>=4&&c.last&&now-c.last>21*DAY).map(c=>c.name)},
    live:{kitchenTickets:S.tickets.filter(t=>t.status!=='done').map(t=>({order:t.no,status:t.status,minutes:Math.floor((now-t.ts)/MIN)})),openTables:S.orders.filter(o=>o.status==='open').map(o=>({table:(tableOf(o.table)||{}).name,minutes:Math.floor((now-o.opened)/MIN),total:o.total})),heldOrders:S.held.length,
      cashDrawer:S.drawer.open?{openSince:fmtT(S.drawer.open.ts),expectedCash:drawerNumbers(S.drawer.open).expected}:'closed'},
    cashVarianceLast7:S.drawer.history.slice(-7).map(h=>[fmtD(h.ts),h.variance]),
    channelLast7Days:(()=>{const os=paidIn(dayStart(-6),now);const k=os.filter(o=>o.source==='kiosk');return{kioskOrders:k.length,kioskSales:r2(sum(k,o=>o.total)),registerOrders:os.length-k.length,registerSales:r2(sum(os,o=>o.total)-sum(k,o=>o.total))};})(),
    insights:insights().map(i=>i.title+'. '+i.text),
  };
}

/* ---------- Local answers ---------- */
function findProduct(q){
  q=String(q||'').toLowerCase().trim().replace(/^the\s+/,'').replace(/s$/,'');if(!q)return null;
  return S.products.find(p=>p.name.toLowerCase()===q)||S.products.find(p=>p.name.toLowerCase().startsWith(q))||S.products.find(p=>p.name.toLowerCase().includes(q))||
    S.products.map(p=>{const w=p.name.toLowerCase().split(/\s+/);return{p,n:q.split(/\s+/).filter(t=>t.length>2&&w.some(x=>x.startsWith(t))).length};}).filter(x=>x.n).sort((a,b)=>b.n-a.n)[0]?.p||null;
}
const AI_UNDO=new Map();
function applyItemChange(input,m){
  if(!can('products'))throw new Error('This team member can’t change items.');
  const p=findProduct(input.item);
  if(!p)throw new Error(`No item called "${input.item}". Items on the menu: ${S.products.map(x=>x.name).join(', ')}`);
  const before={price:p.price,stock:p.stock,available:p.available},ch=[];
  if(input.price!=null&&input.price!==''){const v=r2(Number(input.price));if(!(v>0&&v<10000))throw new Error('Price must be a positive number');if(v!==p.price){p.price=v;ch.push(`price ${money(before.price)} to ${money(v)}`);}}
  if(input.stock!=null&&input.stock!==''){if(before.stock==null)throw new Error(`${p.name} doesn’t have stock tracking turned on`);const v=Math.max(0,Math.round(Number(input.stock)));if(isNaN(v))throw new Error('Stock must be a number');if(v!==p.stock){p.stock=v;S.stockLog.push({id:uid('sl'),ts:Date.now(),pid:p.id,name:p.name,change:v-(before.stock||0),kind:'count',reason:'Changed by the assistant',by:U.user,after:v});ch.push(`stock ${before.stock} to ${v}`);}}
  if(input.available!=null&&input.available!==''){const v=input.available===true||input.available==='true';if(v!==p.available){p.available=v;ch.push(v?'back on sale':'marked sold out');}}
  if(!ch.length)return{ok:true,item:p.name,changes:[],note:'Nothing needed changing'};
  const id=uid('u');
  AI_UNDO.set(id,()=>{Object.assign(p,before);save();renderRail();});
  m.actions.push({id,label:`${p.name}: ${ch.join(', ')}`,undone:false});
  save();renderRail();
  return{ok:true,item:p.name,changes:ch};
}
function localAnswer(q,m){
  const t=q.toLowerCase(),now=Date.now(),t0=dayStart(0),s=S.settings;let r;
  if((r=t.match(/(?:set|change|make|put)\s+(?:the\s+)?price\s+(?:of\s+)?(?:the\s+)?(.+?)\s+(?:to|at)\s+\D{0,4}?(\d+(?:\.\d{1,2})?)/))||(r=t.match(/(?:set|change|make|put)\s+(.+?)\s+(?:price\s+)?(?:to|at)\s+\D{0,4}?(\d+(?:\.\d{1,2})?)/))){
    try{const x=applyItemChange({item:r[1],price:+r[2]},m);return x.changes.length?`Done. **${x.item}** now costs **${money(+r[2])}** on the register and kiosk. You can undo this below.`:`${x.item} already costs ${money(+r[2])}.`;}catch(e){return e.message;}
  }
  if((r=t.match(/(?:mark|set|make)\s+(?:the\s+)?(.+?)\s+(?:as\s+)?(?:sold\s*out|unavailable|off\s+sale|out\s+of\s+stock)/))||(r=t.match(/^86\s+(.+)/))||(r=t.match(/(.+?)\s+is\s+(?:sold\s*out|out\s+of\s+stock)/))){
    try{const x=applyItemChange({item:r[1],available:false},m);return x.changes.length?`Done. **${x.item}** is marked sold out, so it’s greyed out on the register and hidden from kiosk orders. Undo below if that was a mistake.`:`${x.item} is already marked sold out.`;}catch(e){return e.message;}
  }
  if((r=t.match(/(?:put|mark|set)\s+(?:the\s+)?(.+?)\s+(?:back\s+)?on\s+sale/))||(r=t.match(/(?:un-?86|back in stock)\s+(.+)/))){
    try{const x=applyItemChange({item:r[1],available:true},m);return x.changes.length?`**${x.item}** is back on sale.`:`${x.item} is already on sale.`;}catch(e){return e.message;}
  }
  const sm=(x,lbl)=>`**${lbl}: ${money(x.gross)}** from ${x.count} orders, averaging ${money(x.avg)}.`;
  if(/forecast|tomorrow|predict|expect|prep/.test(t)){
    const tm=dayStart(1),ws=[1,2,3,4].map(w=>tm-w*7*DAY).map(a=>stats(a,a+DAY));const avg=sum(ws,x=>x.gross)/4,avgN=sum(ws,x=>x.count)/4;
    const it=itemStatsFrom(ws.flatMap(x=>x.paid)).sort((a,b)=>b.qty-a.qty).slice(0,6);
    return`Based on the last four ${weekday(tm)}s, expect about **${money(avg,0)}** from **${Math.round(avgN)} orders** tomorrow.\n\n#### Prep list\n| Item | Usually sold |\n|---|---|\n${it.map(x=>`| ${x.name} | ${Math.round(x.qty/4)} |`).join('\n')}\n\nThe range over those weeks was ${money(Math.min(...ws.map(x=>x.gross)),0)} to ${money(Math.max(...ws.map(x=>x.gross)),0)}.`;
  }
  if(/stock|run(ning)? out|reorder|order more|low on|supplier/.test(t)){
    const ro=runOut().slice(0,6);if(!ro.length)return'No items have stock tracking turned on. Turn it on per item in **Items & stock**.';
    return`Here’s what runs out first, based on the last two weeks of sales:\n\n| Item | In stock | Sells a day | Lasts |\n|---|---|---|---|\n${ro.map(x=>`| ${x.p.name} | ${x.p.stock} | ${x.perDay.toFixed(1)} | ${x.days>=30?'30+ days':x.days<1?'under a day':x.days.toFixed(1)+' days'} |`).join('\n')}\n\nReorder anything under two days before tomorrow’s delivery.`;
  }
  if(/margin|profit|cost|least money|earn/.test(t)){
    const it=itemStatsFrom(paidIn(dayStart(-6),now)).filter(x=>x.qty>=5);const lo=[...it].sort((a,b)=>a.margin-b.margin).slice(0,4),hi=[...it].sort((a,b)=>b.profit-a.profit).slice(0,3);
    return`**Lowest margins this week** (after ${s.taxName} and item cost):\n${lo.map(x=>`- ${x.name}: ${pct(x.margin)}, ${x.qty} sold`).join('\n')}\n\n**Biggest profit makers:**\n${hi.map(x=>`- ${x.name}: ${money(x.profit)} profit from ${x.qty} sold`).join('\n')}\n\nA small price rise on the low-margin items that sell well usually goes unnoticed.`;
  }
  if(/best|top|popular|selling|sell most/.test(t)){
    const it=itemStatsFrom(paidIn(dayStart(-6),now)).sort((a,b)=>b.qty-a.qty).slice(0,6);
    return`**Best sellers over the last 7 days:**\n\n| Item | Sold | Sales |\n|---|---|---|\n${it.map(x=>`| ${x.name} | ${x.qty} | ${money(x.sales)} |`).join('\n')}`;
  }
  if(/staff|labou?r|wage|shift|team|rota|clocked/.test(t)){
    const lab=labourFor(weekStart(0),now),on=S.employees.filter(e=>onShift(e.id));
    return`Labour is **${pct(lab.pct,1)} of net sales** this week: ${money(lab.wages,0)} in wages over ${lab.hours.toFixed(0)} hours, against ${money(lab.net,0)}. ${lab.pct<.25?'That’s healthy for a café.':lab.pct<.32?'That needs watching; aim for under 25%.':'That’s high; look at quiet afternoons on the heatmap.'}\n\n**On shift now:** ${on.map(e=>`${first(e.name)} (since ${fmtT(onShift(e.id).in)})`).join(', ')||'no one'}.`;
  }
  if(/customer|loyal|regular|reward|points|member/.test(t)){
    const top=[...S.customers].sort((a,b)=>b.spend-a.spend).slice(0,5),lap=S.customers.filter(c=>c.visits>=4&&c.last&&now-c.last>21*DAY);
    return`You have **${S.customers.length} members**. Your best customers by spend:\n\n| Customer | Visits | Spent | Points |\n|---|---|---|---|\n${top.map(c=>`| ${c.name} | ${c.visits} | ${money(c.spend)} | ${c.points} |`).join('\n')}\n\n${lap.length?`**${lap.length} regulars** haven’t been in for three weeks: ${lap.slice(0,4).map(c=>c.name).join(', ')}.`:'No regulars have lapsed recently.'}`;
  }
  if(/peak|busiest|busy|quiet|hour|when/.test(t)){
    const hrs={};paidIn(dayStart(-28),t0).forEach(o=>{const h=new Date(o.ts).getHours();hrs[h]=(hrs[h]||0)+1;});const e=Object.entries(hrs).sort((a,b)=>b[1]-a[1]);
    return`Over the last four weeks, the busiest hour is **${e[0][0]}:00** with about ${(e[0][1]/28).toFixed(1)} orders a day, then ${e[1][0]}:00 and ${e[2][0]}:00. The quietest is ${e[e.length-1][0]}:00. The **Busiest times** heatmap in Reports breaks this down by day.`;
  }
  if(/kiosk|self.?serv/.test(t)){
    const os=paidIn(dayStart(-6),now),k=os.filter(o=>o.source==='kiosk'),p=os.filter(o=>o.source!=='kiosk');
    return`The kiosk took **${k.length} orders** (${pct(k.length/Math.max(1,os.length))} of all orders) for ${money(sum(k,o=>o.total))} this week. Kiosk orders average ${money(sum(k,o=>o.total)/Math.max(1,k.length))} against ${money(sum(p,o=>o.total)/Math.max(1,p.length))} at the register.`;
  }
  if(/refund|void/.test(t)){
    const rf=S.orders.filter(o=>(o.status==='refunded'||o.status==='void')&&o.ts>=dayStart(-29));
    return rf.length?`**${rf.length} refunds or voids** in the last 30 days, worth ${money(sum(rf,o=>o.total))}:\n${rf.slice(-5).reverse().map(o=>`- Order ${o.no}, ${fmtD(o.ts)}: ${money(o.total)}, ${o.refund?o.refund.reason:''}`).join('\n')}`:'No refunds or voids in the last 30 days.';
  }
  if(/yesterday/.test(t))return sm(stats(dayStart(-1),t0),'Yesterday')+` That’s ${deltaText(stats(dayStart(-1),t0).gross,stats(dayStart(-8),dayStart(-7)).gross)} the ${weekday(dayStart(-1))} before.`;
  if(/week|7 days/.test(t)){const x=stats(dayStart(-6),now),p=stats(dayStart(-13),dayStart(-6));const best=[...Array(7)].map((_,i)=>{const a=dayStart(i-6);return[a,sum(paidIn(a,a+DAY),o=>o.total)];}).sort((a,b)=>b[1]-a[1])[0];return sm(x,'Last 7 days')+` That’s ${deltaText(x.gross,p.gross)} the week before. The best day was ${fmtD(best[0])} with ${money(best[1])}. Gross profit after item costs: ${money(x.profit)} (${pct(x.margin)} margin).`;}
  if(/today|so far|how.*(doing|going)|sales|takings/.test(t)){const x=stats(t0,now),p=stats(t0-7*DAY,now-7*DAY);return sm(x,'Today so far')+` That’s ${deltaText(x.gross,p.gross)} this time last ${weekday(t0-7*DAY)}.\n\n${insights().slice(0,2).map(i=>`- **${i.title}.** ${i.text}`).join('\n')}`;}
  return`I can answer questions about this till’s sales, stock, team, customers and kitchen. Try:\n- How are we doing today?\n- What should I reorder before tomorrow?\n- Which items make the least money?\n- Forecast tomorrow’s sales\n- Set the price of Latte to 3.60\n- Mark Almond Croissant as sold out`;
}
function deltaText(c,p){if(!p)return'with nothing to compare against';const d=(c-p)/p;return Math.abs(d)<.005?'level with':`${Math.abs(d*100).toFixed(0)}% ${d>0?'up on':'down on'}`;}

/* ---------- Markdown ---------- */
function md(src){
  const lines=String(src||'').replace(/\r/g,'').split('\n');let html='',i=0;
  const inl=s=>esc(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/__([^_]+)__/g,'<b>$1</b>');
  const isTbl=l=>/^\s*\|.*\|\s*$/.test(l),blockStart=/^(#{1,6}\s|\s*[-*•]\s|\s*\d+[.)]\s|\s*\|)/;
  while(i<lines.length){
    const l=lines[i];let m;
    if(!l.trim()){i++;continue;}
    if((m=l.match(/^#{1,6}\s+(.*)/))){html+=`<h4>${inl(m[1])}</h4>`;i++;continue;}
    if(isTbl(l)&&i+1<lines.length&&/^\s*\|?\s*:?-{2,}/.test(lines[i+1])){
      const row=s=>s.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());const head=row(l);i+=2;const body=[];
      while(i<lines.length&&isTbl(lines[i])){body.push(row(lines[i]));i++;}
      html+=`<table><thead><tr>${head.map(h=>`<th>${inl(h)}</th>`).join('')}</tr></thead><tbody>${body.map(r=>`<tr>${r.map(c=>`<td>${inl(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;continue;}
    if(/^\s*[-*•]\s+/.test(l)){html+='<ul>';while(i<lines.length&&/^\s*[-*•]\s+/.test(lines[i])){html+=`<li>${inl(lines[i].replace(/^\s*[-*•]\s+/,''))}</li>`;i++;}html+='</ul>';continue;}
    if(/^\s*\d+[.)]\s+/.test(l)){html+='<ol>';while(i<lines.length&&/^\s*\d+[.)]\s+/.test(lines[i])){html+=`<li>${inl(lines[i].replace(/^\s*\d+[.)]\s+/,''))}</li>`;i++;}html+='</ol>';continue;}
    const para=[];do{para.push(lines[i]);i++;}while(i<lines.length&&lines[i].trim()&&!blockStart.test(lines[i]));
    html+=`<p>${para.map(inl).join('<br>')}</p>`;
  }
  return html;
}

/* =====================================================================
   ASSISTANT
   ===================================================================== */
let AI_CTL=null;
const AI_SUGS=['How are we doing today?','What should I reorder before tomorrow?','Which items make the least money?','Who are my best customers?','Is labour too high this week?','Forecast tomorrow’s sales'];
function aiLive(){return!!(SAMPLE&&!U.aiOff);}
VIEWS.assistant=()=>{
  const now=Date.now(),t0=dayStart(0),T=stats(t0,now),live=aiLive(),toolsOn=live&&TOOLS_OK&&can('products');
  const ins=insights().slice(0,4);
  return`<div class="asst">
   <section class="chat" aria-label="Assistant chat">
    <div class="chat-head"><div><h2>Assistant</h2><div class="ai-state"><i class="dot ${live?'ok':CAPS_READY?'warn':'info'}"></i>${live?`Claude, reading this till’s live data${toolsOn?', can edit items with undo':''}`:CAPS_READY?'Built-in insights. Works offline, no account needed':'Connecting to Claude…'}</div></div>
     <div class="row">${live?`<div class="seg" aria-label="Answer speed"><button class="${U.aiMode==='fast'?'on':''}" data-act="aiMode" data-m="fast" data-tip="Quick answers in a second or two">Fast</button><button class="${U.aiMode==='deep'?'on':''}" data-act="aiMode" data-m="deep" data-tip="Thinks first. Better for analysis, takes longer">Thorough</button></div>`:''}${U.chat.length?`<button class="btn btn-sm btn-ghost" data-act="aiClear">${ic('plus',16)} New chat</button>`:''}</div></div>
    <div class="chat-log" id="chatLog" aria-live="polite">${chatHTML()}</div>
    <div class="composer"><label class="sr" for="aiIn">Message</label><textarea id="aiIn" rows="1" placeholder="Ask about sales, stock, staff or customers" data-in="aiGrow"></textarea><button class="btn ${AI_CTL?'btn-dark':'btn-primary'}" id="aiSend" data-act="${AI_CTL?'aiStop':'aiSend'}" aria-label="${AI_CTL?'Stop':'Send'}">${ic(AI_CTL?'stop':'send',20)}</button></div>
   </section>
   <aside class="brief" aria-label="Today at a glance">
    <h3>Today so far</h3>
    <div class="stats-2"><div><b class="num">${moneyK(T.gross)}</b><span>Takings</span></div><div><b class="num">${T.count}</b><span>Orders</span></div><div><b class="num">${money(T.avg)}</b><span>Average</span></div><div><b class="num">${S.tickets.filter(t=>t.status==='new'||t.status==='prep').length}</b><span>Cooking now</span></div></div>
    <h3 style="margin-top:6px">Worth knowing</h3>
    <div class="ins">${ins.map(insHTML).join('')||'<p class="muted">Nothing unusual right now.</p>'}</div>
   </aside></div>`;
};
function chatHTML(){
  if(!U.chat.length){const plemmo=window.PlemmoAI&&PlemmoAPI.isAuthenticated();
    return`<div class="chat-welcome"><div class="it-em" style="--c:var(--accent);width:56px;height:56px;border-radius:18px;color:var(--accent-text)">${ic('sparkle',28)}</div><h3>Ask anything about ${esc(S.settings.name)}.</h3><p class="muted" style="font-size:15px">I read this business’s live sales, stock, team and customers from Plemmo. ${plemmo?'Answers come from Plemmo’s assistant and are advisory — I don’t change anything on my own; use the Items and Team pages for that.':'Plemmo isn’t connected, so answers come from the built-in offline insights engine.'}</p>
     <div class="sugs">${AI_SUGS.map(s=>`<button class="sug" data-act="aiSug" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;}
  return U.chat.map(msgHTML).join('');
}
function msgHTML(m){
  if(m.role==='user')return`<div class="msg user">${esc(m.text)}</div>`;
  return`<div class="msg ai" id="m-${m.id}"><span class="ai-av">${ic('sparkle',18)}</span><div class="bub"><div class="bub-body">${m.state==='thinking'?'<span class="thinking" role="status" aria-label="Thinking"><i></i><i></i><i></i></span>':md(m.text)}</div>
   <div class="bub-acts">${actsHTML(m)}</div>
   ${m.state==='done'?`<div class="bub-foot">${m.src==='claude'?`${ic('sparkle',13)} Claude via Plemmo`:m.src==='plemmo'?`${ic('sparkle',13)} Plemmo insights`:`${ic('bulb',13)} Built-in insights (offline)`}${m.note?`<span>· ${esc(m.note)}</span>`:''}</div>`:''}</div></div>`;
}
function actsHTML(m){return(m.actions||[]).map(a=>`<div class="ai-act ${a.undone?'undone':''}">${ic('check',16)}<span>${esc(a.label)}</span><span class="spacer"></span>${a.undone?'<span>Undone</span>':`<button class="btn btn-sm" data-act="aiUndo" data-id="${a.id}" data-m="${m.id}">Undo</button>`}</div>`).join('');}
function renderChat(){const log=$('#chatLog');if(!log)return;log.innerHTML=chatHTML();log.scrollTop=log.scrollHeight;setSendBtn();}
function updateBubble(m){
  const el=$('#m-'+m.id);if(!el){return;}
  const log=$('#chatLog'),near=log&&log.scrollHeight-log.scrollTop-log.clientHeight<120;
  el.querySelector('.bub-body').innerHTML=m.state==='thinking'?'<span class="thinking"><i></i><i></i><i></i></span>':md(m.text);
  el.querySelector('.bub-acts').innerHTML=actsHTML(m);
  if(near)log.scrollTop=log.scrollHeight;
}
function setSendBtn(){const b=$('#aiSend');if(!b)return;b.dataset.act=AI_CTL?'aiStop':'aiSend';b.className='btn '+(AI_CTL?'btn-dark':'btn-primary');b.setAttribute('aria-label',AI_CTL?'Stop':'Send');b.innerHTML=ic(AI_CTL?'stop':'send',20);}
function buildTurns(q,tools){
  const e=me(),s=S.settings;
  const rules=`You are the assistant built into Meridian, the point-of-sale system at ${s.name}, a ${s.type} at ${s.address||'an unlisted address'}. You're talking with ${e.name}, the ${roleLabel(e.role).toLowerCase()}. It is ${fmtDL(Date.now())}, ${fmtT(Date.now())}.
Answer only from the live till data in the JSON below. If the data doesn't cover the question, say what's missing instead of guessing.
How to answer: lead with the answer in one sentence. Then a few short lines or a short list. Use a Markdown table only when comparing three or more rows. Write money with the ${s.currency.trim()} symbol. Keep it under 170 words unless asked for detail. End with one practical next step when it helps.
${tools?'You can change menu items with the update_item tool: price, stock count, or whether an item is on sale. Only use it when the user clearly asks for a change, then confirm exactly what changed. The user sees an Undo button for each change.':'You cannot change anything in the till. If asked, say where to do it: prices and stock are on the Items page, staff on the Team page.'}

LIVE TILL DATA (JSON):
${JSON.stringify(snapshot())}`;
  const hist=U.chat.slice(0,-2).filter(x=>x.text&&x.text.trim()).slice(-8).map(x=>({role:x.role==='user'?'user':'assistant',content:x.text.slice(0,2400)}));
  return[{role:'user',content:rules},...hist,{role:'user',content:q}];
}
function updateTool(m){
  return{name:'update_item',description:'Change one menu item in this till: its price (including tax), its stock count (only for items with stock tracking), or whether it is on sale. Returns the item name and what changed. Only call it when the user clearly asks for a change.',
    inputSchema:{type:'object',properties:{item:{type:'string',description:'The item name as it appears on the menu'},price:{type:'number',description:'New price including tax'},stock:{type:'integer',description:'New stock count'},available:{type:'boolean',description:'false marks it sold out, true puts it back on sale'}},required:['item']},
    execute:(input,ctx)=>{if(ctx&&ctx.signal&&ctx.signal.aborted)throw new Error('Stopped');const r=applyItemChange(input,m);updateBubble(m);return r;}};
}
async function aiSend(text){
  text=String(text||'').trim();if(!text||AI_CTL)return;
  const inp=$('#aiIn');if(inp){inp.value='';inp.style.height='';}
  U.chat.push({role:'user',text,id:uid('m')});
  const m={role:'ai',id:uid('m'),text:'',state:'thinking',actions:[],src:'plemmo'};U.chat.push(m);
  if(U.chat.length===2)renderView();else renderChat();

  // Plemmo integration: the assistant is advisory and answers through the
  // authoritative Plemmo AI service (permission-gated, audited, computed from
  // real business data — never the local S cache, never a client-side mutation
  // tool). If the service is unreachable, fall back to the built-in offline
  // engine over the local snapshot so the till still answers.
  if(window.PlemmoAI&&PlemmoAPI.isAuthenticated()){
    try{
      const res=await PlemmoAI.ask(text);
      m.text=res.answer||'';
      m.src=res.source==='anthropic'?'claude':'plemmo';
    }catch(e){
      m.text=localAnswer(text,m);m.src='local';
      m.note=(e&&e.status===403)?'You don’t have permission to use the assistant':'Plemmo is unreachable, so the built-in insights answered';
    }finally{m.state='done';if(U.view==='assistant'){renderChat();const i=$('#aiIn');if(i&&matchMedia('(pointer:fine)').matches)i.focus();}}
    return;
  }

  // No Plemmo session — offline built-in insights over the local snapshot.
  await sleep(380+Math.random()*300);m.text=localAnswer(text,m);m.src='local';m.state='done';renderChat();
}
A.aiSend=()=>{const i=$('#aiIn');aiSend(i?i.value:'');};
A.aiStop=()=>{if(AI_CTL)AI_CTL.abort();};
A.aiSug=d=>aiSend(d.q);
A.aiMode=d=>{U.aiMode=d.m;$$('.chat-head .seg button').forEach(b=>b.classList.toggle('on',b.dataset.m===d.m));};
A.aiClear=()=>{if(AI_CTL)AI_CTL.abort();U.chat=[];renderView();};
A.aiUndo=d=>{const f=AI_UNDO.get(d.id);if(!f)return;f();AI_UNDO.delete(d.id);const m=U.chat.find(x=>x.id===d.m);if(m){const a=m.actions.find(x=>x.id===d.id);if(a)a.undone=true;updateBubble(m);}toast('Change undone');};
IN.aiGrow=(v,el)=>{el.style.height='auto';el.style.height=Math.min(160,el.scrollHeight)+'px';};
AFTER.assistant=()=>{const l=$('#chatLog');if(l)l.scrollTop=l.scrollHeight;const i=$('#aiIn');if(i&&matchMedia('(pointer:fine)').matches)i.focus({preventScroll:true});};

/* =====================================================================
   SELF-SERVICE KIOSK
   ===================================================================== */
const K={screen:'attract',items:[],type:null,cat:null,sheet:null,order:null,last:0,warn:false,warnAt:0,doneAt:0,pay:'wait'};
function openKiosk(){
  if(!S.settings.kioskEnabled){toast('Turn the kiosk on in Settings first','warn');return;}
  closeAll();U.user=null;$('#rail').classList.remove('open');
  $('#app').hidden=true;$('#lock').hidden=true;$('#onboard').hidden=true;$('#kiosk').hidden=false;
  kReset();
}
function kReset(){Object.assign(K,{screen:'attract',items:[],type:null,cat:(kCats()[0]||{}).id,sheet:null,order:null,warn:false,last:Date.now()});renderKiosk();}
function kCats(){return S.categories.filter(c=>S.products.some(p=>p.cat===c.id&&p.kiosk!==false));}
const kOut=p=>!p.available||(p.stock!=null&&p.stock-sum(K.items.filter(l=>l.pid===p.id),l=>l.qty)<=0);
function kTotals(){return totalsFor(K.items,null);}
function renderKiosk(){
  const s=S.settings,el=$('#kiosk'),t=kTotals();
  let h='';
  if(K.screen==='attract'){
    const em=[...new Set(popularIds().slice(0,8).map(id=>(prod(id)||{}).emoji).filter(Boolean))].slice(0,6);
    const pos=[[62,10],[80,34],[58,52],[84,68],[70,4],[48,76]];
    h=`<div class="k-attract" role="button" tabindex="0" data-act="kStart" aria-label="Tap to start your order"><span class="k-float" aria-hidden="true">${em.map((e,i)=>`<span style="left:${pos[i][0]}%;top:${pos[i][1]}%;animation-delay:${-i*1.7}s">${e}</span>`).join('')}</span>
      <span class="k-hero"><span class="k-biz" style="display:block">${esc(s.name)}</span><h1>${esc(s.kioskWelcome||'Order here')}</h1><span class="k-tap">Tap to start ${ic('chevR',22)}</span></span></div>
      <button class="k-staff" data-act="kExit">${ic('lock',14)} Staff</button>`;
  }else if(K.screen==='type'){
    h=`<div class="k-center"><div><h1>Eating in or<br>taking away?</h1><p>You can change this before you pay.</p><div class="k-choice"><button data-act="kSetType" data-t="dine"><span aria-hidden="true">🍽️</span>Eating in</button><button data-act="kSetType" data-t="takeaway"><span aria-hidden="true">🛍️</span>Taking away</button></div><button class="k-btn ghost" style="margin-top:36px" data-act="kCancel">Start over</button></div></div>`;
  }else if(K.screen==='menu'){
    const c=catOf(K.cat)||kCats()[0],pop=new Set(popularIds().slice(0,4));
    const list=c?S.products.filter(p=>p.cat===c.id&&p.kiosk!==false):[];
    h=`<div class="k-wrap"><header class="k-top"><div class="mark sm" aria-hidden="true">M</div><span class="kt-biz">${esc(s.name)}</span><span class="spacer"></span>${hospitality()&&s.kioskEatIn?`<button class="k-pill" data-act="kType">${ic(typeIcon(K.type),18)} ${typeLabel(K.type)}</button>`:''}<button class="k-pill" data-act="kCancel">Start over</button></header>
     <div class="k-body"><nav class="k-cats" aria-label="Menu sections">${kCats().map(x=>`<button class="k-cat ${c&&x.id===c.id?'on':''}" style="--c:${x.color}" data-act="kCat" data-id="${x.id}" aria-pressed="${c&&x.id===c.id}"><span class="e" aria-hidden="true">${x.emoji}</span>${esc(x.name)}</button>`).join('')}</nav>
      <main class="k-main" id="kMain"><h2>${c?esc(c.name):'Menu'}</h2><div class="k-grid">${list.map(p=>{const out=kOut(p);return`<button class="k-item" style="--c:${c.color};${out?'opacity:.45':''}" data-act="kItem" data-id="${p.id}" ${out?'aria-disabled="true"':''}><span class="e" aria-hidden="true">${p.emoji}${out?'<em>Sold out</em>':pop.has(p.id)?'<em>Popular</em>':''}</span><span class="t"><b>${esc(p.name)}</b><small>${esc(p.desc||'')}</small><span class="pr num">${money(p.price)}</span></span></button>`;}).join('')}</div></main></div>
     <footer class="k-bar"><div class="kb-t"><b class="num">${money(t.total)}</b><span>${t.count?`${t.count} item${t.count>1?'s':''} in your order`:'Your order is empty'}</span></div><button class="k-btn" data-act="kReview" ${t.count?'':'disabled'}>Review and pay ${ic('chevR',22)}</button></footer></div>`;
  }else if(K.screen==='review'){
    const inCart=new Set(K.items.map(l=>l.pid));
    const ups=s.kioskUpsell?S.products.filter(p=>!inCart.has(p.id)&&p.kiosk!==false&&!kOut(p)&&(hospitality()?['c-bake','c-sweet','c-cold'].includes(p.cat):p.price<15)).sort((a,b)=>b.w-a.w).slice(0,5):[];
    h=`<div class="k-wrap"><header class="k-top"><button class="k-pill" data-act="kBack">${ic('chevL',18)} Add more</button><span class="spacer"></span><span class="kt-biz">Your order</span><span class="spacer"></span>${hospitality()&&s.kioskEatIn?`<button class="k-pill" data-act="kType">${ic(typeIcon(K.type),18)} ${typeLabel(K.type)}</button>`:'<span></span>'}</header>
     <div class="k-review"><div class="kr-l">${K.items.map(l=>{const p=prod(l.pid),c=p?catOf(p.cat):null;return`<div class="k-line" style="--c:${c?c.color:'#999'}"><span class="e" aria-hidden="true">${p?p.emoji:'•'}</span><div><b>${esc(l.name)}</b><small>${l.mods.map(m=>esc(m.n)).join(', ')||'&nbsp;'}</small><div class="num" style="font-weight:800;font-size:17px;margin-top:4px">${money(lineTotal(l))}</div></div><div class="k-step"><button data-act="kLine" data-id="${l.uid}" data-d="-1" aria-label="${l.qty===1?'Remove':'One fewer'} ${esc(l.name)}">${ic(l.qty===1?'trash':'minus',22)}</button><b class="num">${l.qty}</b><button data-act="kLine" data-id="${l.uid}" data-d="1" aria-label="One more ${esc(l.name)}">${ic('plus',22)}</button></div></div>`;}).join('')}
      ${ups.length?`<h3 style="font-size:19px;margin:28px 0 12px">Goes well with</h3><div class="k-up">${ups.map(p=>`<button data-act="kUp" data-id="${p.id}"><span aria-hidden="true">${p.emoji}</span><b>${esc(p.name)}</b><em class="num">+ ${money(p.price)}</em></button>`).join('')}</div>`:''}</div>
      <div class="kr-r"><div class="k-tot"><span>Items</span><span class="num">${t.count}</span></div><div class="k-tot"><span>${esc(s.taxName)} ${s.taxInclusive?'included':''}</span><span class="num">${money(t.tax)}</span></div><div class="k-tot big"><span>Total</span><span class="num">${money(t.total)}</span></div><div class="spacer"></div>
       <button class="k-btn" data-act="kPay" style="width:100%">${ic('contactless',24)} Pay ${money(t.total)}</button><button class="k-btn ghost" data-act="kCancel" style="width:100%">Cancel order</button></div></div></div>`;
  }else if(K.screen==='pay'){
    h=`<div class="k-center"><div><h1>${K.pay==='ok'?'Payment approved':'Tap, insert or swipe'}</h1><p>${K.pay==='ok'?'Printing your receipt…':'Use the card reader below the screen.'}</p>
     <div class="k-term"><div class="scr">${K.pay==='ok'?`<span style="color:var(--accent)">${ic('check',44)}</span><b>Approved</b>`:`<small>${esc(s.name)}</small><b class="num">${money(t.total)}</b><small>Contactless or card</small>`}</div><div class="cl" aria-hidden="true">${ic('contactless',46)}</div><div class="keys" aria-hidden="true">${'<i></i>'.repeat(9)}</div></div>
     ${K.pay!=='ok'?`<button class="k-btn ghost" style="margin-top:30px" data-act="kPayCancel">Cancel payment</button>`:''}</div></div>`;
  }else if(K.screen==='done'){
    h=`<div class="k-center"><div><p style="margin:0;font-size:22px;font-weight:700;color:var(--k-ink)">Thank you! Your order number is</p><div class="k-no num">${K.order.no}</div><p>${hospitality()?'Watch the screen by the counter. We’ll call your number when it’s ready.':'Your receipt is printing below.'}</p><button class="k-btn dark" style="margin-top:28px" data-act="kNew">Start a new order</button><div class="k-count"><i style="animation-duration:12s"></i></div></div></div>`;
  }
  if(K.sheet){
    const sh=K.sheet,p=sh.p,c=catOf(p.cat)||{color:'#999'},unit=r2(p.price+sum(kSheetMods(),m=>m.p));
    h+=`<div class="k-sheet-scrim" data-act="kSheetClose"><div class="k-sheet" data-stop role="dialog" aria-modal="true" aria-label="${esc(p.name)}"><div class="ks-b"><div class="ks-hero" style="--c:${c.color}" aria-hidden="true">${p.emoji}</div><h2>${esc(p.name)}</h2><p class="ks-d">${esc(p.desc||'')}</p>
      ${p.allergens&&p.allergens.length?`<p style="margin-top:10px;font-size:14px;color:var(--k-muted)"><b>Contains:</b> ${p.allergens.map(esc).join(', ')}</p>`:''}
      ${sh.groups.map(g=>`<div class="k-grp"><h3>${esc(g.name)} <small>${g.req?'Choose one':g.multi?'Choose any':'Optional'}</small></h3><div class="k-opts">${g.opts.map(([n,pr])=>{const on=(sh.sel[g.id]||[]).includes(n);return`<button class="k-opt ${on?'on':''}" data-act="kOpt" data-g="${g.id}" data-n="${esc(n)}" aria-pressed="${on}">${esc(n)}${pr?` <small>+${money(pr)}</small>`:''}</button>`;}).join('')}</div></div>`).join('')}</div>
      <div class="ks-f"><div class="k-step"><button data-act="kSheetQty" data-d="-1" aria-label="Fewer">${ic('minus',22)}</button><b class="num">${sh.qty}</b><button data-act="kSheetQty" data-d="1" aria-label="More">${ic('plus',22)}</button></div><button class="k-btn" style="flex:1" data-act="kSheetAdd">Add to order <span class="num">${money(unit*sh.qty)}</span></button><button class="k-btn ghost" data-act="kSheetClose" aria-label="Close">${ic('x',22)}</button></div></div></div>`;
  }
  if(K.warn)h+=`<div class="k-warn" data-act="kStill" role="alertdialog" aria-modal="true" aria-label="Still there?"><div><h2>Still there?</h2><p style="font-size:18px;color:var(--k-muted);margin:12px 0 26px">Your order will clear in <b id="kWarnN">15</b> seconds.</p><button class="k-btn" style="width:100%">I’m still here</button></div></div>`;
  el.innerHTML=h;
}
function kSheetMods(){const sh=K.sheet,out=[];sh.groups.forEach(g=>(sh.sel[g.id]||[]).forEach(n=>{const o=g.opts.find(x=>x[0]===n);if(o&&!isStd(g,n))out.push({g:g.id,n,p:o[1]});}));return out;}
function kAdd(p,mods,qty){
  const key=p.id+'|'+mods.map(m=>m.n).join(','),ex=K.items.find(l=>l.key===key);
  if(ex)ex.qty+=qty;else K.items.push({key,pid:p.id,name:p.name,price:p.price,cost:p.cost,qty,mods,note:'',uid:uid('l'),sent:false});
}
A.kStart=()=>{K.last=Date.now();if(hospitality()&&S.settings.kioskEatIn){K.screen='type';}else{K.type=hospitality()?'takeaway':'instore';K.screen='menu';}renderKiosk();};
A.kSetType=d=>{K.type=d.t;K.screen='menu';renderKiosk();};
A.kType=()=>{K.type=K.type==='dine'?'takeaway':'dine';renderKiosk();};
A.kCat=d=>{K.cat=d.id;renderKiosk();const m=$('#kMain');if(m)m.scrollTop=0;};
A.kItem=d=>{
  const p=prod(d.id);if(!p||kOut(p))return;
  const groups=(p.mods||[]).map(id=>S.modGroups.find(g=>g.id===id)).filter(Boolean);
  if(!groups.length){kAdd(p,[],1);renderKiosk();toast(`${p.name} added`,'',{ms:1300});return;}
  const sel={};groups.forEach(g=>sel[g.id]=g.req&&!g.multi?[g.opts[0][0]]:[]);
  K.sheet={p,groups,sel,qty:1};renderKiosk();
};
A.kOpt=d=>{const g=K.sheet.groups.find(x=>x.id===d.g);let s=K.sheet.sel[d.g]||[];if(g.multi)s=s.includes(d.n)?s.filter(x=>x!==d.n):[...s,d.n];else s=s.includes(d.n)&&!g.req?[]:[d.n];K.sheet.sel[d.g]=s;renderKiosk();};
A.kSheetQty=d=>{const p=K.sheet.p;let q=clamp(K.sheet.qty+(+d.d),1,20);if(p.stock!=null)q=Math.min(q,Math.max(1,p.stock-sum(K.items.filter(l=>l.pid===p.id),l=>l.qty)));K.sheet.qty=q;renderKiosk();};
A.kSheetAdd=()=>{const sh=K.sheet;kAdd(sh.p,kSheetMods(),sh.qty);K.sheet=null;renderKiosk();toast(`${sh.p.name} added`,'',{ms:1300});};
A.kSheetClose=()=>{K.sheet=null;renderKiosk();};
A.kReview=()=>{if(!K.items.length)return;K.screen='review';renderKiosk();};
A.kBack=()=>{K.screen='menu';renderKiosk();};
A.kLine=d=>{const l=K.items.find(x=>x.uid===d.id);if(!l)return;const p=prod(l.pid);if(+d.d>0&&p&&kOut(p)){toast(`That’s all the ${p.name} we have`,'warn',{ms:1800});return;}l.qty+=+d.d;if(l.qty<=0)K.items=K.items.filter(x=>x!==l);if(!K.items.length)K.screen='menu';renderKiosk();};
A.kUp=d=>{const p=prod(d.id);if(!p)return;const groups=(p.mods||[]).map(id=>S.modGroups.find(g=>g.id===id)).filter(Boolean);if(groups.length){A.kItem({id:p.id});return;}kAdd(p,[],1);renderKiosk();};
A.kCancel=async()=>{if(K.items.length&&!await confirmBox({title:'Start over?',text:'Your order will be cleared.',ok:'Clear my order',danger:true}))return;kReset();};
A.kPay=async()=>{
  K.screen='pay';K.pay='wait';renderKiosk();const token=K.payToken=uid('kp');
  await sleep(2600);if(K.payToken!==token||K.screen!=='pay')return;
  K.pay='ok';renderKiosk();await sleep(1100);if(K.payToken!==token)return;
  kFinish();
};
A.kPayCancel=()=>{K.payToken=null;K.screen='review';renderKiosk();};
function kFinish(){
  const t=kTotals();
  const o={id:uid('o'),no:S.seq++,ts:Date.now(),opened:Date.now(),items:K.items.map(l=>({...l,sent:true})),type:K.type||'takeaway',table:null,custId:null,empId:null,source:'kiosk',discount:null,discAmt:0,subtotal:t.subtotal,tax:t.tax,total:t.total,tip:0,payments:[{m:'card',a:t.total}],status:'paid',pts:0,note:''};
  S.orders.push(o);
  o.items.forEach(l=>{const p=prod(l.pid);if(p&&p.stock!=null)p.stock=Math.max(0,p.stock-l.qty);});
  if(S.settings.kitchen&&hospitality())addTicket(o,o.items);
  save();K.order=o;K.items=[];K.screen='done';K.doneAt=Date.now();renderKiosk();
}
A.kNew=()=>kReset();
A.kStill=()=>{K.warn=false;K.last=Date.now();renderKiosk();};
A.kExit=async()=>{const e=await pinPrompt({title:'Staff sign-in',text:'Enter a team PIN to leave kiosk mode.'});if(!e)return;$('#kiosk').hidden=true;K.screen='attract';signIn(e);};
function kioskTick(now){
  if($('#kiosk').hidden)return;
  if(K.screen==='done'&&now-K.doneAt>12000){kReset();return;}
  if(!['type','menu','review'].includes(K.screen))return;
  if(!K.warn&&now-K.last>45000){K.warn=true;K.warnAt=now;renderKiosk();return;}
  if(K.warn){const left=15-Math.floor((now-K.warnAt)/1000);if(left<=0){kReset();return;}const n=$('#kWarnN');if(n)n.textContent=left;}
}

/* =====================================================================
   GLOBAL WIRING
   ===================================================================== */
A.nav=d=>go(d.v);
A.closeTop=()=>closeTop();
A.palette=()=>openPalette();
A.theme=()=>toggleTheme();
A.mobNav=()=>$('#rail').classList.toggle('open');
A.userMenu=(d,el)=>{
  const e=me(),sh=onShift(e.id);
  popover(el,`<div class="pop-h"><b style="color:var(--text);font-size:14px">${esc(e.name)}</b><br>${sh?'On shift since '+fmtT(sh.in):'Not clocked in'}</div>
   <button class="pop-i" data-act="lock">${ic('users',18)} Switch user</button>
   ${sh?`<button class="pop-i" data-act="clockOutLock">${ic('logout',18)} Clock out and lock</button>`:`<button class="pop-i" data-act="clockInMe">${ic('clock',18)} Clock in</button>`}
   <div class="pop-sep"></div><button class="pop-i" data-act="theme">${ic(isDark()?'sun':'moon',18)} ${isDark()?'Light':'Dark'} theme</button><button class="pop-i" data-act="palette">${ic('search',18)} Search <kbd style="margin-left:auto">${isMac?'⌘':'Ctrl'} K</kbd></button>`);
};
A.clockOutLock=()=>{const e=me();clockOut(e.id);showLock();toast(`${first(e.name)} clocked out at ${fmtT(Date.now())}`);};
A.clockInMe=()=>{clockIn(U.user);toast('Clocked in');if(U.view==='team'||U.view==='home')renderView();};

document.addEventListener('click',e=>{
  const rail=$('#rail');
  if(rail.classList.contains('open')&&!e.target.closest('#rail')&&!e.target.closest('[data-act="mobNav"]'))rail.classList.remove('open');
  const el=e.target.closest('[data-act]');if(!el)return;
  const stop=e.target.closest('[data-stop]');if(stop&&el.contains(stop)&&el!==stop)return;
  if(el.disabled)return;
  const fn=A[el.dataset.act];if(!fn)return;
  if(el.closest('.pop')){const L=topLayer();if(L&&L.el.contains(el))L.close();}
  try{const r=fn(el.dataset,el,e);if(r&&r.catch)r.catch(err=>{console.error(err);toast('Something went wrong. Try that again.','bad');});}
  catch(err){console.error(err);toast('Something went wrong. Try that again.','bad');}
});
document.addEventListener('input',e=>{const el=e.target.closest('[data-in]');if(!el)return;const f=IN[el.dataset.in];if(f)f(el.value,el);});
document.addEventListener('change',e=>{const el=e.target.closest('[data-ch]');if(!el)return;const f=CH[el.dataset.ch];if(f)f(el.value,el);});
document.addEventListener('pointerdown',()=>{U.lastAct=Date.now();if(!$('#kiosk').hidden)K.last=Date.now();},{passive:true});
document.addEventListener('keydown',e=>{
  U.lastAct=Date.now();if(!$('#kiosk').hidden)K.last=Date.now();
  const tg=e.target,typing=tg&&(tg.tagName==='INPUT'||tg.tagName==='TEXTAREA'||tg.tagName==='SELECT'||tg.isContentEditable);
  const L=topLayer(),appOn=U.user&&!$('#app').hidden;
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){if(appOn){e.preventDefault();if(L&&PAL&&L===PAL.L)closeTop();else if(!L)openPalette();}return;}
  if(e.key==='Escape'){
    if(L){if(L.dismiss!==false){e.preventDefault();L.close();}else if(PAY&&PAY.stage==='idle'&&L===PAY.L){L.close();}return;}
    if(!$('#kiosk').hidden&&K.sheet){K.sheet=null;renderKiosk();return;}
    if($('#rail').classList.contains('open')){$('#rail').classList.remove('open');return;}
    if(appOn&&U.view==='pos'){if(typing&&tg.id==='posQ'&&tg.value){tg.value='';U.pos.q='';$('#posGrid').innerHTML=gridHTML();return;}if(U.selLine){U.selLine=null;refreshPos({grid:false});return;}if(U.mobCart){A.mobCart();return;}}
    return;
  }
  if(e.key==='Tab'&&L){
    const box=L.el.querySelector('.modal,.drawer,.pop,.palette')||L.el;
    const f=$$('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea,[tabindex]:not([tabindex="-1"]),a[href]',box).filter(x=>x.offsetParent!==null);
    if(!f.length)return;const a=f[0],z=f[f.length-1],act=document.activeElement;
    if(e.shiftKey&&(act===a||!box.contains(act))){e.preventDefault();z.focus();}
    else if(!e.shiftKey&&(act===z||!box.contains(act))){e.preventDefault();a.focus();}
    return;
  }
  if(!typing&&(e.key==='Enter'||e.key===' ')&&tg&&tg.getAttribute&&tg.getAttribute('role')==='button'&&tg.dataset&&tg.dataset.act){e.preventDefault();tg.click();return;}
  if(!typing&&!e.metaKey&&!e.ctrlKey&&!e.altKey){
    const pad=activePad();
    if(pad){let k=null;if(/^\d$/.test(e.key))k=e.key;else if(e.key==='Backspace')k='back';else if(e.key==='.'||e.key===',')k='.';
      if(k){const b=pad.root.querySelector(`[data-pad] [data-key="${k}"]`);if(!b)return;e.preventDefault();pad.fn(k);const nb=pad.root.querySelector(`[data-pad] [data-key="${k}"]`);if(nb){nb.classList.add('hit');setTimeout(()=>nb.classList.remove('hit'),120);}return;}}
  }
  if(appOn&&!L&&U.view==='pos'){
    if(e.key==='/'&&!typing){e.preventDefault();const q=$('#posQ');if(q){q.focus();q.select();}return;}
    if(e.key==='F2'||((e.metaKey||e.ctrlKey)&&e.key==='Enter')){e.preventDefault();A.charge();return;}
    if(e.key==='Enter'&&tg&&tg.id==='posQ'){
      e.preventDefault();const q=U.pos.q.trim().toLowerCase();if(!q)return;
      const list=posProducts(),p=S.products.find(x=>String(x.sku)===q)||S.products.find(x=>x.name.toLowerCase()===q)||(list.length===1?list[0]:null);
      if(p){U.pos.q='';tg.value='';$('#posGrid').innerHTML=gridHTML();addProduct(p.id);}
      else toast(list.length?`${list.length} items match. Keep typing or tap one.`:'Nothing matches that','info',{ms:1600});
      return;
    }
  }
  if(appOn&&U.view==='assistant'&&tg&&tg.id==='aiIn'&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();A.aiSend();}
});
setInterval(()=>{
  const now=Date.now();
  const c=$('#tbClock');if(c)c.textContent=fmtT(now);
  if(!$('#lock').hidden){const lt=$('#lockTime');if(lt)lt.textContent=fmtT(now);}
  $$('[data-since]').forEach(el=>{const t=+el.dataset.since,f=el.dataset.fmt;el.textContent=f==='min'?Math.floor((now-t)/MIN)+' min':f==='dur'?fmtHrs((now-t)/HOUR):mmss(now-t);});
  $$('.kt[data-kt]').forEach(k=>{if(k.dataset.ready==='1')return;const s=k.querySelector('[data-since]');if(!s)return;const m=(now-+s.dataset.since)/MIN;const v=m>=10?'bad':m>=5?'warn':'ok';if(k.dataset.lvl!==v)k.dataset.lvl=v;});
  kioskTick(now);
  if(U.user&&S&&!$('#app').hidden&&S.settings.autoLock>0&&now-U.lastAct>S.settings.autoLock*MIN&&!(PAY&&!PAY.L.closed)&&!AI_CTL){showLock();toast('Locked after inactivity','info');}
},1000);
addEventListener('online',()=>{if(U.user)renderTopbar();toast('Back online. Everything is synced.');});
addEventListener('offline',()=>{if(U.user)renderTopbar();toast('You’re offline. Keep selling, sales are saved on this device.','warn',{ms:5000});});
addEventListener('pagehide',()=>saveNow());
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')saveNow();});
try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(U.user)renderTopbar();});}catch(e){}

/* ---------- Boot ---------- */
async function resolveCaps(){
  const c=window.claude;
  if(c&&typeof c.use==='function'){
    const [smp,dl]=await Promise.all([c.use('sample').catch(()=>null),c.use('downloads').catch(()=>null)]);
    SAMPLE=smp||null;DL=dl||null;
    if(SAMPLE&&typeof SAMPLE.limits==='function'){try{const l=await SAMPLE.limits();TOOLS_OK=!!(l&&l.tools);}catch(e){TOOLS_OK=false;}}
  }
  CAPS_READY=true;
  if(U.user&&U.view==='assistant'&&!AI_CTL&&!$('#app').hidden)renderView();
}
// Meridian's boot, gated behind real Plemmo authentication.
// When a Plemmo session exists, build the running state from the authoritative
// tenant + data and enter the app signed in as the real user (no local
// onboarding, no per-staff PIN). Only the un-authenticated / offline path falls
// back to Meridian's original local flow.
function meridianBoot(){
  if(typeof bootstrapFromPlemmo==='function'&&window.PlemmoAPI&&PlemmoAPI.isAuthenticated()){
    bootstrapFromPlemmo().catch((e)=>{
      // If bootstrapping from Plemmo fails unexpectedly, don't strand the user.
      try{if(typeof toast==='function')toast('Could not load your business from Plemmo','warn');}catch(_){}
      console&&console.error&&console.error('[Plemmo] bootstrap failed',e);
    });
    return;
  }
  try{S=loadState();}catch(e){S=null;}
  if(S&&S.onboarded&&S.settings&&Array.isArray(S.orders)){applyTheme();LK.sel=(S.employees[0]||{}).id;showLock();hydratePlemmoCatalogue();}
  else{S=null;showOnboarding();}
  resolveCaps();
  updatePlemmoStatus();
}
// Phase 2: pull the authoritative catalogue (categories/products/modifiers/
// customers) from Plemmo into the running state, so the register renders real
// data. Plemmo is authoritative; this is a read-through cache. On failure
// (offline / not reachable) the last cached catalogue is kept.
async function hydratePlemmoCatalogue(){
  if(!S||!window.PlemmoCatalogue||!PlemmoAPI.isAuthenticated())return;
  try{
    const n=await PlemmoCatalogue.load(S);
    saveNow();
    if(U.user)render();
    updatePlemmoStatus();
    if(typeof toast==='function'&&n.products>0)toast(`Catalogue synced from Plemmo — ${n.products} products`,'ok');
  }catch(e){
    if(typeof toast==='function')toast('Using the last saved catalogue — Plemmo is unreachable','warn');
  }
}
A.plemmoSyncCatalogue=()=>hydratePlemmoCatalogue();
(function boot(){
  // Phase 1 foundation: authenticate against Plemmo first, then run Meridian.
  // window.PlemmoAPI is always present (00-plemmo-api.js). If it is somehow
  // unavailable, fall back to Meridian's standalone boot so the app still runs.
  if(typeof plemmoStart==='function'&&window.PlemmoAPI){plemmoStart(meridianBoot);}
  else{meridianBoot();}
})();

// Read-only access to core state for tests/diagnostics (never a write path).
if(typeof window!=="undefined"){window.__meridian={get S(){return S;},get U(){return U;}};}
