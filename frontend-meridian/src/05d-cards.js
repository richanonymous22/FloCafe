/* ============================================================================
 * 05d-cards.js — Settings → Card payments
 * ----------------------------------------------------------------------------
 * Which card provider this till uses, whether its terminal answers, and the reconciliation list of card money
 * the provider approved that the till has no record of. All of it is the till server's answer
 * (/api/card/config, /terminals, /reconciliation); nothing is guessed here.
 * ==========================================================================*/
U.cards=U.cards||{cfg:null,terminals:null,termErr:null,rec:null,err:null,busy:false};
async function cardsLoad(){
  if(!window.PlemmoAPI||!PlemmoAPI.isAuthenticated())return;
  const c=U.cards;
  try{c.cfg=await PlemmoAPI.get('/card/config');c.err=null;}catch(e){c.err=(e&&e.data&&e.data.error)||'Card settings could not be read.';c.cfg=null;}
  c.terminals=null;c.termErr=null;
  if(c.cfg&&c.cfg.enabled){
    try{c.terminals=(await PlemmoAPI.get('/card/terminals')).terminals;}catch(e){c.termErr=(e&&e.data&&e.data.error)||'The card terminal could not be reached.';}
  }
  c.rec=null;
  if(me()&&(me().plemmoRole==='owner'||me().plemmoRole==='manager')){try{c.rec=await PlemmoAPI.get('/card/reconciliation');}catch(e){}}
  if(U.view==='settings'&&U.set.tab==='cards')renderView();
}
const PROVIDER_NAMES={none:'None: I take cards on a separate terminal',simulator:'Simulated terminal (testing only)'};
function cardsHTML(){
  const c=U.cards;
  if(!live())return`<div class="panel"><div class="panel-b"><p class="muted">Card terminals are set up on a till that is connected to its server.</p></div></div>`;
  if(c.err)return`<div class="panel"><div class="panel-b"><p class="muted">${esc(c.err)}</p></div></div>`;
  if(!c.cfg)return`<div class="panel"><div class="panel-b"><p class="muted">Reading card settings…</p></div></div>`;
  const owner=!!(me()&&(me().plemmoRole==='owner'||me().plemmoRole==='manager'));
  const row=(t,sub,ctl)=>`<div class="set-row"><div class="sr-t"><b>${t}</b>${sub?`<small>${sub}</small>`:''}</div>${ctl||''}</div>`;
  const opts=['none',...c.cfg.available].map(id=>`<option value="${esc(id)}" ${c.cfg.provider===id?'selected':''}>${esc(PROVIDER_NAMES[id]||id)}</option>`).join('');
  const pilotNote=(U.lic&&U.lic.status&&U.lic.status.pilot)?row('Pilot version','Choose the simulated terminal to try card payments end to end. No real card is ever charged. Takings are labelled simulated on receipts and reports.',''):'';
  const state=!c.cfg.enabled?'Cards are taken on a separate terminal and recorded by hand. The till labels them as not confirmed by a card provider.'
    :c.termErr?`<span style="color:var(--bad-text)">${esc(c.termErr)}</span>`
    :(c.terminals||[]).length?(c.terminals.map(t=>`${esc(t.label)}: ${t.online?'online':'offline'}`).join('; ')):'No terminal found.';
  const rec=c.rec;
  const orph=rec?rec.orphans:[],mism=rec?rec.mismatches:[];
  return`<div class="panel"><div class="panel-b">
   ${pilotNote}
   ${row('Card provider','Cards the terminal approves are recorded as confirmed card payments. Everything else stays marked unconfirmed.',`<select class="input" style="width:auto" data-ch="cardProvider" ${owner?'':'disabled'}>${opts}</select>`)}
   ${row('Terminal',state,c.cfg.enabled?`<button class="btn" data-act="cardsRefresh">Check again</button>`:'')}
   ${c.cfg.simulated?row('Simulated terminal','No real card is ever charged. Amounts ending .05 are declined, .06 never answer, .07 are offline, and refunds ending .13 are rejected, so you can practise every outcome.',''):''}
  </div></div>
  ${rec?`<section class="panel mt"><div class="panel-h"><h3>Needs checking</h3><span class="ph-sub">Card money the provider approved that the till could not match</span></div><div class="panel-b flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>What</th><th class="r">Amount</th><th>What to do</th></tr></thead><tbody>
   ${orph.map(o=>`<tr><td>${licWhen(o.created_at)}</td><td>${o.kind==='sale'?'Charged, no payment recorded':'Refunded, no refund recorded'}${o.simulated?' <span class="badge warn">simulated</span>':''}<small class="muted" style="display:block">Ref ${esc(o.provider_reference||'')}</small></td><td class="r num">${money(o.amount_minor/100)}</td><td>${esc(o.reason)}</td></tr>`).join('')}
   ${mism.map(m=>`<tr><td></td><td>Payment ${esc(m.payment_id.slice(-8))}</td><td class="r num">${money(m.amount_minor/100)}</td><td>${esc(m.reason)}</td></tr>`).join('')}
   ${orph.length+mism.length?'':'<tr><td colspan="4" class="muted">Nothing needs checking. Every approved card payment has a matching record.</td></tr>'}
  </tbody></table></div></div></section>`:''}`;
}
A.cardsRefresh=()=>cardsLoad();
CH.cardProvider=async v=>{
  try{await PlemmoAPI.request('/card/config',{method:'PUT',body:{provider:v},idempotent:false});toast(v==='none'?'Card terminal turned off':'Card provider saved','ok');}
  catch(e){toast((e&&e.data&&e.data.error)||'That did not save','warn');}
  await cardsLoad();
};
