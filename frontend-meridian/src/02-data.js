'use strict';
/* =====================================================================
   Meridian POS — single-file point of sale
   ===================================================================== */

/* ---------- Utilities ---------- */
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=(p='id')=>p+'_'+Math.random().toString(36).slice(2,8)+(Date.now()%1e6).toString(36);
const r2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const sum=(a,f=x=>x)=>a.reduce((s,x)=>s+(Number(f(x))||0),0);
const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clone=o=>JSON.parse(JSON.stringify(o));
const DAY=864e5,HOUR=36e5,MIN=6e4;
function dayStart(off=0,base=Date.now()){const d=new Date(base);return new Date(d.getFullYear(),d.getMonth(),d.getDate()+off).getTime();}
function weekStart(off=0){const d=new Date(dayStart(0));const w=(d.getDay()+6)%7;return new Date(d.getFullYear(),d.getMonth(),d.getDate()-w+off*7).getTime();}
function money(n,dp=2){const c=(S&&S.settings&&S.settings.currency)||'£';const v=Math.abs(+n||0);return (n<-0.004?'−':'')+c+v.toLocaleString('en-GB',{minimumFractionDigits:dp,maximumFractionDigits:dp});}
function moneyK(n){const c=(S&&S.settings&&S.settings.currency)||'£';const v=Math.abs(+n||0);if(v>=1e4)return c+(n/1000).toFixed(v>=1e5?0:1)+'k';return money(n,v>=1000||Number.isInteger(n)?0:2);}
const pct=(n,dp=0)=>(isFinite(n)?(n*100).toFixed(dp):'0')+'%';
const fmtT=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
const fmtD=t=>new Date(t).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
const fmtDL=t=>new Date(t).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'});
const fmtDT=t=>fmtD(t)+', '+fmtT(t);
const fmtDay=t=>new Date(t).toLocaleDateString('en-GB',{day:'numeric',month:'short'});
function ago(t){const m=Math.floor((Date.now()-t)/MIN);if(m<1)return'just now';if(m<60)return m+' min ago';const h=Math.floor(m/60);if(h<24)return h+'h ago';const d=Math.floor(h/24);return d===1?'yesterday':d<7?d+' days ago':fmtDay(t);}
function mmss(ms){const s=Math.max(0,Math.floor(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
function fmtHrs(h){const H=Math.floor(h);const M=Math.round((h-H)*60);return H+'h '+String(M===60?59:M).padStart(2,'0')+'m';}
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function pickW(rng,items,wf){const ws=items.map(wf);const tot=ws.reduce((a,b)=>a+b,0);let r=rng()*tot;for(let i=0;i<items.length;i++){r-=ws[i];if(r<=0)return items[i];}return items[items.length-1];}
const initials=n=>String(n||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
const first=n=>String(n||'').split(' ')[0];
const isMac=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent);
function greeting(){const h=new Date().getHours();return h<12?'Good morning':h<18?'Good afternoon':'Good evening';}
function setPath(o,p,v){const k=p.split('.');let x=o;for(let i=0;i<k.length-1;i++){x[k[i]]=x[k[i]]||{};x=x[k[i]];}x[k[k.length-1]]=v;}
function getPath(o,p){return p.split('.').reduce((x,k)=>x==null?x:x[k],o);}

/* ---------- Icons ---------- */
const ICONS={
 home:'<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
 register:'<rect x="5" y="2.5" width="14" height="19" rx="2.5"/><path d="M8.5 6.5h7v3.5h-7z"/><path d="M8.5 14h.01M12 14h.01M15.5 14h.01M8.5 17.5h.01M12 17.5h.01M15.5 17.5h.01"/>',
 tables:'<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
 chef:'<path d="M6 13.9V21h12v-7.1A4 4 0 0 0 17 6a5 5 0 0 0-10 0 4 4 0 0 0-1 7.9Z"/><path d="M6 17h12"/>',
 receipt:'<path d="M5 2.5v19l2.3-1.5 2.4 1.5 2.3-1.5 2.3 1.5 2.4-1.5 2.3 1.5v-19l-2.3 1.5-2.4-1.5L12 4l-2.3-1.5L7.3 4Z"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
 kiosk:'<rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M10.5 18h3"/>',
 box:'<path d="m21 7.5-9-4.5-9 4.5 9 4.5 9-4.5Z"/><path d="M3 7.5v9l9 4.5 9-4.5v-9"/><path d="M12 12v9"/>',
 heart:'<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
 users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
 chart:'<path d="M3 3v18h18"/><path d="M7.5 16v-4M12 16V8M16.5 16v-6"/>',
 cash:'<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 12h.01M18 12h.01"/>',
 sparkle:'<path d="M11 3.5l1.8 4.9 4.9 1.8-4.9 1.8L11 16.9l-1.8-4.9-4.9-1.8 4.9-1.8Z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"/>',
 settings:'<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5"/>',
 lock:'<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
 search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',minus:'<path d="M5 12h14"/>',x:'<path d="M18 6 6 18M6 6l12 12"/>',check:'<path d="M20 6 9 17l-5-5"/>',
 chevR:'<path d="m9 18 6-6-6-6"/>',chevL:'<path d="m15 18-6-6 6-6"/>',chevD:'<path d="m6 9 6 6 6-6"/>',chevU:'<path d="m18 15-6-6-6 6"/>',
 trash:'<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
 edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
 card:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
 user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 alert:'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
 up:'<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>',down:'<path d="m3 7 6 6 4-4 8 8"/><path d="M14 17h7v-7"/>',
 printer:'<path d="M6 9V2h12v7"/><rect x="2" y="9" width="20" height="9" rx="2"/><path d="M6 14h12v8H6z"/>',
 mail:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
 sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
 moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
 download:'<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
 tag:'<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
 note:'<path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V10"/><path d="M8 9h5M8 13h8M8 17h6"/>',
 pause:'<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
 send:'<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
 star:'<path d="m12 2.5 3 6.2 6.8 1-4.9 4.8 1.2 6.8L12 18l-6.1 3.3 1.2-6.8-4.9-4.8 6.8-1Z"/>',
 logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
 menu:'<path d="M3 6h18M3 12h18M3 18h18"/>',
 more:'<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
 backspace:'<path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z"/><path d="m18 9-6 6M12 9l6 6"/>',
 ban:'<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
 refund:'<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
 bag:'<path d="M6 7h12l1 14H5Z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
 dine:'<path d="M4 2v7a3 3 0 0 0 6 0V2M7 2v20M17 22V2c-2 1-3 4-3 7v4h3"/>',
 truck:'<path d="M1 4h13v12H1zM14 8h4l3 4v4h-7"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="17.5" cy="18.5" r="2"/>',
 copy:'<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
 contactless:'<path d="M8.5 7.5a6 6 0 0 1 0 9M12 5a9.5 9.5 0 0 1 0 14M15.5 2.5a13 13 0 0 1 0 19M5 10a2.5 2.5 0 0 1 0 4"/>',
 stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',
 split:'<path d="M16 3h5v5M8 3H3v5M21 3l-7 7M3 3l7 7M12 22v-8"/>',
 cmd:'<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
 inbox:'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z"/>',
 wifi:'<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01"/>',
 drawer:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 13h20M10 16.5h4"/>',
 battery:'<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2M5 10v4M8 10v4M11 10v4"/>',
 bulb:'<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V16h8v-1.3A7 7 0 0 0 12 2Z"/>',
 target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
 play:'<path d="M6 4l14 8-14 8Z"/>',
};
const ic=(n,s=20)=>`<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]||''}</svg>`;

/* ---------- Sample data ---------- */
const ALLERGENS=['Celery','Gluten','Crustaceans','Eggs','Fish','Lupin','Milk','Molluscs','Mustard','Tree nuts','Peanuts','Sesame','Soya','Sulphites'];
const EMP_COLORS=['#E8912D','#3E7CB1','#2E9E6B','#C2477E','#7A5AC8','#B8962E','#D2553F','#2B9DB5'];
const CAT_COLORS=['#B7794B','#6E9B5B','#3E9BC7','#E0A526','#D8663A','#C9964A','#D2587F','#7A5AC8','#2E9E6B','#3E7CB1'];
const EMOJIS=['☕','🫖','🍵','🧉','🍫','🥤','🧊','🍊','🍋','💧','🫐','🍓','🍳','🥚','🥑','🥣','🥞','🥓','🥪','🌯','🍲','🥗','🧀','🍔','🍕','🍝','🍟','🌮','🥐','🍞','🥖','🥯','🧁','🍰','🎂','🍪','🍩','🍌','🥕','🌰','🌀','🍷','🍺','🍸','🧃','🍹','🕯️','📓','🖊️','💌','🎁','👜','🧣','🧼','🧩','🪵','🏺','🌿','🛋️','💳','🗓️','🧺','🍽️','✏️','🛍️'];
const CAT_HOSP={
 cats:[
  {id:'c-coffee',name:'Coffee',emoji:'☕',color:'#B7794B'},
  {id:'c-tea',name:'Tea & chocolate',emoji:'🫖',color:'#6E9B5B'},
  {id:'c-cold',name:'Cold drinks',emoji:'🧊',color:'#3E9BC7'},
  {id:'c-bfast',name:'Breakfast',emoji:'🍳',color:'#E0A526'},
  {id:'c-lunch',name:'Lunch',emoji:'🥪',color:'#D8663A'},
  {id:'c-bake',name:'Bakery',emoji:'🥐',color:'#C9964A'},
  {id:'c-sweet',name:'Cakes & sweets',emoji:'🍰',color:'#D2587F'},
 ],
 mods:[
  {id:'m-size',name:'Size',req:true,multi:false,std:true,opts:[['Regular',0],['Large',0.5]]},
  {id:'m-milk',name:'Milk',req:true,multi:false,std:true,opts:[['Whole',0],['Semi-skimmed',0],['Oat',0.4],['Almond',0.4],['Soya',0.3]]},
  {id:'m-extra',name:'Extras',req:false,multi:true,opts:[['Extra shot',0.6],['Vanilla syrup',0.5],['Caramel syrup',0.5],['Decaf',0],['Extra hot',0]]},
  {id:'m-eggs',name:'Eggs',req:true,multi:false,opts:[['Fried',0],['Poached',0],['Scrambled',0]]},
  {id:'m-add',name:'Add-ons',req:false,multi:true,opts:[['Bacon',1.8],['Avocado',1.5],['Halloumi',1.9],['Gluten-free bread',0.8]]},
  {id:'m-warm',name:'Serve it',req:false,multi:false,opts:[['Warmed',0],['As it comes',0]]},
 ],
 items:[
  ['Espresso','c-coffee',2.40,0.38,'☕',null,5,['m-extra'],[],'A double shot of our house blend'],
  ['Americano','c-coffee',2.90,0.42,'☕',null,9,['m-size','m-extra'],[],'Espresso lengthened with hot water'],
  ['Flat White','c-coffee',3.30,0.62,'☕',null,16,['m-milk','m-extra'],[6],'Double ristretto with velvety milk'],
  ['Latte','c-coffee',3.40,0.66,'☕',null,15,['m-size','m-milk','m-extra'],[6],'Espresso with plenty of steamed milk'],
  ['Cappuccino','c-coffee',3.40,0.64,'☕',null,12,['m-size','m-milk','m-extra'],[6],'Espresso, milk and a deep layer of foam'],
  ['Cortado','c-coffee',3.10,0.52,'☕',null,5,['m-milk'],[6],'Espresso cut with a little warm milk'],
  ['Mocha','c-coffee',3.70,0.78,'☕',null,6,['m-size','m-milk','m-extra'],[6,12],'Espresso, dark chocolate and steamed milk'],
  ['English Breakfast','c-tea',2.50,0.18,'🫖',null,6,['m-milk'],[],'Loose-leaf black tea in a pot'],
  ['Earl Grey','c-tea',2.60,0.20,'🫖',null,3,['m-milk'],[],'Black tea with bergamot'],
  ['Matcha Latte','c-tea',3.90,0.95,'🍵',null,6,['m-size','m-milk'],[6],'Ceremonial-grade matcha, steamed milk'],
  ['Chai Latte','c-tea',3.60,0.70,'🧉',null,6,['m-size','m-milk'],[6],'Spiced black tea with steamed milk'],
  ['Hot Chocolate','c-tea',3.40,0.60,'🍫',null,6,['m-size','m-milk'],[6,12],'Belgian chocolate, topped with cream'],
  ['Iced Latte','c-cold',3.80,0.70,'🥤',null,8,['m-milk','m-extra'],[6],'Double shot over ice and cold milk'],
  ['Fresh Orange Juice','c-cold',3.20,0.90,'🍊',24,5,[],[],'Squeezed every morning'],
  ['Sparkling Water','c-cold',1.80,0.35,'💧',48,4,[],[],'330ml glass bottle'],
  ['Cloudy Lemonade','c-cold',2.90,0.55,'🍋',30,4,[],[],'Made here with real lemons'],
  ['Berry Smoothie','c-cold',4.50,1.30,'🫐',null,4,[],[6],'Mixed berries, banana and yoghurt'],
  ['Full Breakfast','c-bfast',10.50,3.40,'🍳',null,6,['m-eggs','m-add'],[1,3,8,13],'Bacon, sausage, eggs, beans, mushrooms, toast'],
  ['Eggs Benedict','c-bfast',8.90,2.30,'🥚',null,5,['m-add'],[1,3,6,8],'English muffin, ham, poached eggs, hollandaise'],
  ['Avocado Toast','c-bfast',7.90,2.10,'🥑',null,6,['m-eggs','m-add'],[1,11],'Sourdough, smashed avocado, chilli, seeds'],
  ['Granola Bowl','c-bfast',5.90,1.40,'🥣',null,4,[],[1,6,9],'Greek yoghurt, honey and seasonal fruit'],
  ['Pancake Stack','c-bfast',7.50,1.60,'🥞',null,4,['m-add'],[1,3,6],'Maple syrup, berries, crème fraîche'],
  ['Bacon Bap','c-bfast',4.90,1.30,'🥓',null,6,['m-add'],[1],'Dry-cured bacon in a soft white bap'],
  ['Chicken Club','c-lunch',8.50,2.60,'🥪',null,6,['m-add'],[1,3,8],'Chicken, bacon, lettuce, tomato, mayo'],
  ['Halloumi Wrap','c-lunch',7.90,2.20,'🌯',null,5,[],[1,6],'Grilled halloumi, roast peppers, hummus'],
  ['Soup of the Day','c-lunch',5.90,1.20,'🍲',null,4,[],[0,1],'Served with buttered sourdough'],
  ['Caesar Salad','c-lunch',8.20,2.30,'🥗',null,4,['m-add'],[1,3,4,6,8],'Cos lettuce, parmesan, croutons, anchovy dressing'],
  ['Cheese & Ham Toastie','c-lunch',6.40,1.50,'🧀',null,5,[],[1,6,8],'Mature cheddar, ham and mustard'],
  ['Butter Croissant','c-bake',2.60,0.55,'🥐',18,10,['m-warm'],[1,3,6],'Laminated and baked here every morning'],
  ['Pain au Chocolat','c-bake',2.90,0.62,'🥐',14,7,['m-warm'],[1,3,6,12],'Two batons of dark chocolate'],
  ['Almond Croissant','c-bake',3.40,0.80,'🌰',8,5,['m-warm'],[1,3,6,9],'Frangipane and toasted almonds'],
  ['Cinnamon Swirl','c-bake',3.10,0.60,'🌀',10,6,['m-warm'],[1,3,6],'Brown butter and cinnamon sugar'],
  ['Sourdough Toast','c-bake',3.50,0.50,'🍞',null,4,[],[1],'Two slices with butter and jam'],
  ['Carrot Cake','c-sweet',3.90,0.90,'🥕',12,5,[],[1,3,6,9],'Cream cheese frosting and walnuts'],
  ['Chocolate Brownie','c-sweet',3.20,0.60,'🍫',4,6,['m-warm'],[1,3,6,12],'Dark chocolate with a soft middle'],
  ['Lemon Drizzle','c-sweet',3.50,0.70,'🍋',9,4,[],[1,3,6],'Sharp lemon glaze'],
  ['Choc Chip Cookie','c-sweet',2.20,0.35,'🍪',3,6,[],[1,3,6,12],'Baked fresh every two hours'],
  ['Banana Bread','c-sweet',3.40,0.60,'🍌',7,4,['m-warm'],[1,3,6,9],'Toasted, with salted butter'],
 ]
};
const CAT_RETAIL={
 cats:[
  {id:'c-home',name:'Home & candles',emoji:'🕯️',color:'#9A6FB0'},
  {id:'c-stat',name:'Stationery',emoji:'✏️',color:'#3E7CB1'},
  {id:'c-kitch',name:'Kitchen',emoji:'🍽️',color:'#D07A3A'},
  {id:'c-gift',name:'Gifts',emoji:'🎁',color:'#C94F6D'},
  {id:'c-acc',name:'Bags & accessories',emoji:'👜',color:'#4E9A7A'},
 ],
 mods:[{id:'m-wrap',name:'Gift wrap',req:false,multi:false,opts:[['Gift wrapped',2.5],['No wrap',0]]}],
 items:[
  ['Fig Soy Candle','c-home',18,6.5,'🕯️',14,6,['m-wrap'],[],'40-hour burn, cotton wick'],
  ['Linen Cushion Cover','c-home',24,9,'🛋️',9,4,[],[],'Stonewashed linen, 45cm'],
  ['Ceramic Bud Vase','c-home',32,12,'🏺',5,3,['m-wrap'],[],'Hand-thrown stoneware'],
  ['Reed Diffuser','c-home',22,7,'🌿',11,4,['m-wrap'],[],'Cedar and sea salt'],
  ['A5 Dot Notebook','c-stat',12,3.8,'📓',30,8,[],[],'160 pages, lay-flat binding'],
  ['Brass Pen','c-stat',16,5.5,'🖊️',18,4,['m-wrap'],[],'Refillable, lasts for years'],
  ['Greeting Card','c-stat',3.5,0.9,'💌',60,9,[],[],'Blank inside, recycled card'],
  ['Weekly Planner','c-stat',14,4.6,'🗓️',12,4,[],[],'Undated, 52 weeks'],
  ['Enamel Mug','c-kitch',11,3.9,'☕',22,6,['m-wrap'],[],'Speckled enamel, 350ml'],
  ['Olive Wood Board','c-kitch',28,10,'🪵',6,3,['m-wrap'],[],'Each one unique'],
  ['Tea Towel Set','c-kitch',12.5,4,'🧺',16,4,[],[],'Set of two, organic cotton'],
  ['Gift Wrap Sheet','c-gift',2.5,0.6,'🎁',80,7,[],[],'Recyclable kraft paper'],
  ['Scented Soap Bar','c-gift',6.5,2,'🧼',26,6,[],[],'Vegan, palm-oil free'],
  ['Jigsaw Puzzle','c-gift',19,7.2,'🧩',7,3,['m-wrap'],[],'1000 pieces, illustrated'],
  ['Canvas Tote','c-acc',15,4.5,'👜',20,5,[],[],'Heavyweight cotton canvas'],
  ['Silk Scarf','c-acc',38,14,'🧣',4,2,['m-wrap'],[],'Printed mulberry silk'],
  ['Leather Cardholder','c-acc',26,8.5,'💳',10,3,['m-wrap'],[],'Vegetable-tanned leather'],
 ]
};
function sampleStaff(hosp){return[
 {name:'Priya Shah',role:'manager',position:'Manager',pin:'1111',rate:13.5},
 {name:'Tom Walsh',role:'staff',position:hosp?'Barista':'Sales assistant',pin:'2222',rate:11.44},
 {name:'Leah Okafor',role:'staff',position:hosp?'Front of house':'Sales assistant',pin:'3333',rate:11.44},
 {name:'Marco Rossi',role:'staff',position:hosp?'Chef':'Stock & sales',pin:'4444',rate:12.2},
];}
function defaultTables(){return[
 ['t1','1',2,'round','s',5,9],['t2','2',2,'round','s',18,9],['t3','3',2,'round','s',31,9],
 ['t4','4',4,'square','m',5,38],['t5','5',4,'square','m',20,38],['t6','6',4,'square','m',35,38],
 ['t7','7',6,'rect','l',5,70],['t8','8',4,'square','m',26,70],
 ['t9','9',4,'round','m',66,8],['t10','10',4,'round','m',82,8],['t11','11',6,'rect','l',66,44],['t12','12',2,'round','s',84,76]
].map(([id,name,seats,shape,size,x,y])=>({id,name,seats,shape,size,x,y}));}
const PERMS=[['pos','Take payments'],['discounts','Give discounts'],['refunds','Refund and void orders'],['kitchen','Use the kitchen display'],['orders','See order history'],['products','Edit items and stock'],['customers','Manage customers'],['cash','Open and close the cash drawer'],['reports','See reports'],['team','Manage the team'],['assistant','Ask the assistant'],['settings','Change settings']];
const permLabel=p=>(PERMS.find(x=>x[0]===p)||[p,p])[1];
function defaultRoles(){const all=PERMS.map(p=>p[0]);return{owner:{label:'Owner',perms:all},manager:{label:'Manager',perms:all.filter(p=>p!=='settings')},staff:{label:'Staff',perms:['pos','kitchen','orders','customers','assistant']}};}
const ACCENTS={
 marigold:{c:'#FFB400',ink:'#1D1500',name:'Marigold'},
 cobalt:{c:'#3D5AFE',ink:'#FFFFFF',name:'Cobalt'},
 mint:{c:'#1FC7A0',ink:'#00261D',name:'Mint'},
 coral:{c:'#FF6B57',ink:'#2B0A05',name:'Coral'},
 violet:{c:'#8B5CF6',ink:'#FFFFFF',name:'Violet'},
};

/* ---------- Money maths ---------- */
function lineUnit(l){return r2(l.price+sum(l.mods||[],m=>m.p));}
function lineTotal(l){return r2(lineUnit(l)*l.qty);}
function totalsFor(items,discount,s){
  s=s||S.settings;
  const subtotal=r2(sum(items,lineTotal));
  let disc=0;
  if(discount){disc=discount.kind==='pct'?r2(subtotal*discount.value/100):Math.min(subtotal,r2(discount.value));}
  const after=r2(subtotal-disc),rate=(+s.taxRate||0)/100;
  let tax,total;
  if(s.taxInclusive!==false){total=after;tax=r2(after-after/(1+rate));}
  else{tax=r2(after*rate);total=r2(after+tax);}
  return{subtotal,disc,tax,total,count:sum(items,l=>l.qty)};
}

/* ---------- Store ---------- */
const KEY='meridian-pos:v1';
let S=null;
let memStore=null;
// Orders are stored as compact arrays: about 45% smaller than plain objects
const OF=['id','no','ts','opened','status','type','source','empId','custId','table','subtotal','discAmt','tax','total','tip','pts','note','closedBy'];
function packOrder(o){
  const a=OF.map(k=>o[k]==null||o[k]===''?0:o[k]);
  if(a[3]===a[2])a[3]=0;
  a.push(o.payments.map(p=>[p.m==='cash'?0:1,p.a]));
  a.push(o.items.map(l=>{const x=[l.pid,l.name,l.price,l.cost||0,l.qty,(l.mods||[]).map(m=>[m.g,m.n,m.p])];if(l.note)x.push(l.note);return x;}));
  a.push(o.discount||0,o.refund||0);
  return a;
}
function unpackOrder(a){
  const o={};OF.forEach((k,i)=>{const v=a[i];o[k]=v===0&&!['no','ts','subtotal','discAmt','tax','total','tip','pts'].includes(k)?null:v;});
  if(!o.opened)o.opened=o.ts;if(o.note==null)o.note='';
  const n=OF.length;
  o.payments=(a[n]||[]).map(p=>({m:p[0]===0?'cash':'card',a:p[1]}));
  o.items=(a[n+1]||[]).map(x=>({pid:x[0],name:x[1],price:x[2],cost:x[3],qty:x[4],mods:(x[5]||[]).map(m=>({g:m[0],n:m[1],p:m[2]})),note:x[6]||'',sent:true,uid:uid('l')}));
  o.discount=a[n+2]||null;o.refund=a[n+3]||null;
  return o;
}
function loadState(){
  try{const raw=localStorage.getItem(KEY);if(raw){const st=JSON.parse(raw);if(st&&st._packed){st.orders=st.orders.map(unpackOrder);delete st._packed;}return st;}}catch(e){console.warn('Could not read saved data',e);}
  return memStore?clone(memStore):null;
}
let saveTimer=null,storageWarned=false;
function save(){clearTimeout(saveTimer);saveTimer=setTimeout(saveNow,300);}
function saveNow(){clearTimeout(saveTimer);if(!S)return;try{localStorage.setItem(KEY,JSON.stringify({...S,orders:S.orders.map(packOrder),_packed:1}));}catch(e){memStore=S;if(!storageWarned){storageWarned=true;setTimeout(()=>toast('This browser isn’t keeping data, so changes last until you close the page','warn',{ms:6000}),600);}}}
function wipeState(){try{localStorage.removeItem(KEY);}catch(e){}memStore=null;S=null;}

/* ---------- Business builder ---------- */
function buildBusiness(cfg){
  const hosp=cfg.type!=='retail';
  const C=hosp?CAT_HOSP:CAT_RETAIL;
  const sample=cfg.catalog!=='empty';
  const owner={id:uid('e'),name:(cfg.ownerName||'Owner').trim(),role:'owner',position:'Owner',pin:cfg.ownerPin||'1234',rate:0,color:EMP_COLORS[0],active:true};
  const st={v:1,onboarded:true,demo:!!cfg.demo,created:Date.now(),seq:1001,
    settings:{name:(cfg.name||'My business').trim(),type:cfg.type,address:cfg.address||'',phone:cfg.phone||'',vatNo:cfg.vatNo||'',
      currency:cfg.currency||'£',taxName:cfg.taxName||'VAT',taxRate:+cfg.taxRate||0,taxInclusive:cfg.taxInclusive!==false,
      accent:cfg.accent||'marigold',theme:cfg.theme||'system',receiptFooter:'Thank you, see you soon',showTaxLine:true,showBarcode:true,
      tables:hosp,kitchen:hosp,tipping:hosp,kioskEnabled:true,kioskUpsell:true,kioskEatIn:hosp,kioskWelcome:hosp?'Hungry? Start here.':'Browse and pay here.',
      autoLock:10,loyalty:{on:true,earn:1,redeemPts:100,redeemVal:5},openHour:hosp?7:9,closeHour:18,defaultFloat:150},
    roles:defaultRoles(),categories:[],modGroups:[],products:[],employees:[owner],shifts:[],customers:[],orders:[],tickets:[],
    tables:hosp?defaultTables():[],held:[],stockLog:[],drawer:{open:null,history:[]}};
  if(sample){
    st.categories=clone(C.cats);
    st.modGroups=clone(C.mods);
    st.products=C.items.map((a,i)=>({id:'p'+(i+1),name:a[0],cat:a[1],price:a[2],cost:a[3],emoji:a[4],stock:a[5],low:a[5]==null?null:5,w:a[6],mods:a[7]||[],allergens:(a[8]||[]).map(k=>ALLERGENS[k]),desc:a[9]||'',sku:String(5060412000000+(i+1)*37),available:true,kiosk:true}));
  }
  if(cfg.sampleStaff)sampleStaff(hosp).forEach((e,i)=>st.employees.push({id:uid('e'),...e,color:EMP_COLORS[i+1],active:true}));
  if(sample&&cfg.history)genHistory(st);
  return st;
}

function genHistory(st){
  const rng=mulberry32(4271),R=(a,b)=>a+rng()*(b-a),RI=(a,b)=>Math.floor(R(a,b+1));
  const s=st.settings,hosp=s.type!=='retail',now=Date.now();
  const FN=['Aisha','Ben','Chloe','Daniel','Ella','Farah','George','Hannah','Imran','Jess','Kieran','Lucy','Mo','Nadia','Oliver','Poppy','Rahul','Sophie','Tariq','Uma','Victor','Will','Yasmin','Zoe','Hamza','Grace','Ryan','Maya','Callum','Iris','Amir','Bethany','Connor','Divya','Ethan','Fatima','Gemma','Harvey','Isla','Jamal','Keira','Liam','Megan','Nathan','Olivia','Priti','Quinn','Rosie','Sami','Tilly','Usman','Vera','Wes','Xander','Yusuf','Zara','Ava','Leon','Mia','Noah'];
  const LN=['Khan','Patel','Jones','Smith','Hughes','Begum','Clarke','Ahmed','Evans','Murphy','Taylor','Hussain','Wright','Price','Walker','Morgan','Ali','Bennett'];
  const custW=[];
  for(let i=0;i<FN.length;i++){
    const f=FN[i],l=LN[Math.floor(rng()*LN.length)];
    st.customers.push({id:uid('c'),name:f+' '+l,phone:'07'+String(RI(100000000,999999999)),email:(f+'.'+l).toLowerCase()+'@example.com',created:now-RI(70,420)*DAY,points:0,visits:0,spend:0,last:null,notes:''});
    custW.push(Math.pow(rng(),2.6)+0.02);
  }
  const owner=st.employees[0],staff=st.employees.filter(e=>e.role!=='owner');
  const mgr=st.employees.find(e=>e.role==='manager')||owner;
  const HW=hosp?{7:.55,8:1.45,9:1.25,10:.95,11:.85,12:1.55,13:1.45,14:.85,15:.7,16:.6,17:.4}:{9:.5,10:.8,11:1,12:1.3,13:1.4,14:1.1,15:1,16:.9,17:.7};
  const hours=Object.keys(HW).map(Number);
  const DOW=[1.22,.84,.9,.94,1,1.16,1.38];
  const DAYS=63;
  const G=Object.fromEntries(st.modGroups.map(g=>[g.id,g]));
  const prods=st.products;
  const orders=[];
  const milkW={Whole:.44,'Semi-skimmed':.2,Oat:.26,Almond:.06,Soya:.04};
  function mkLine(p,mods,qty){return{key:p.id+'|'+mods.map(m=>m.n).join(','),pid:p.id,name:p.name,price:p.price,cost:p.cost,qty,mods,note:'',uid:uid('l'),sent:true};}
  const slim=l=>({pid:l.pid,name:l.name,price:l.price,cost:l.cost,qty:l.qty,mods:l.mods.map(m=>({g:m.g,n:m.n,p:m.p}))});
  function makeOrder(ts,h,empId){
    const boost=hosp?(h<11?{'c-coffee':2.3,'c-bake':1.9,'c-bfast':1.6,'c-lunch':.08,'c-sweet':.5}:h<15?{'c-lunch':2.5,'c-cold':1.6,'c-coffee':1.1,'c-bfast':.45,'c-bake':.5}:{'c-coffee':1.5,'c-sweet':2.1,'c-tea':1.5,'c-lunch':.3,'c-bfast':.05}):{};
    const nItems=pickW(rng,[1,2,3,4],k=>({1:.36,2:.36,3:.19,4:.09})[k]);
    const items=[];
    for(let k=0;k<nItems;k++){
      const p=pickW(rng,prods,x=>x.w*(boost[x.cat]??1));
      const mods=[];
      (p.mods||[]).forEach(gid=>{const g=G[gid];if(!g)return;
        if(gid==='m-size'){if(rng()<.32)mods.push({g:gid,n:'Large',p:.5});}
        else if(gid==='m-milk'){const o=pickW(rng,g.opts,x=>milkW[x[0]]||.1);if(o[0]!=='Whole')mods.push({g:gid,n:o[0],p:o[1]});}
        else if(g.req){const o=g.opts[Math.floor(rng()*g.opts.length)];mods.push({g:gid,n:o[0],p:o[1]});}
        else if(rng()<.14){const o=g.opts[Math.floor(rng()*g.opts.length)];mods.push({g:gid,n:o[0],p:o[1]});}
      });
      const key=p.id+'|'+mods.map(m=>m.n).join(',');
      const ex=items.find(l=>l.key===key);
      if(ex)ex.qty++;else items.push(mkLine(p,mods,rng()<.08?2:1));
    }
    const kiosk=hosp&&rng()<.22;
    const type=hosp?(kiosk?(rng()<.7?'takeaway':'dine'):pickW(rng,['takeaway','dine','delivery'],t=>({takeaway:.5,dine:.44,delivery:.06})[t])):'instore';
    const cust=rng()<.13?pickW(rng,st.customers,c=>custW[st.customers.indexOf(c)]):null;
    let discount=null;const rd=rng();
    if(!kiosk&&rd<.045)discount={kind:'pct',value:10,reason:'Regular'};else if(!kiosk&&rd<.055)discount={kind:'pct',value:50,reason:'Staff'};
    const t=totalsFor(items,discount,s);
    const tip=hosp&&type==='dine'&&rng()<.28?r2(Math.max(.5,Math.round(t.total*.2)/2)):0;
    const grand=r2(t.total+tip);
    const pm=kiosk?'card':pickW(rng,['card','cash','split'],m=>({card:.78,cash:.18,split:.04})[m]);
    let payments;
    if(pm==='split'){const half=r2(Math.round(grand*50)/100);payments=[{m:'card',a:half},{m:'cash',a:r2(grand-half)}];}
    else payments=[{m:pm,a:grand}];
    const o={id:uid('o'),no:0,ts,opened:ts-(type==='dine'&&!kiosk?RI(15,55)*MIN:0),items,type,table:type==='dine'&&!kiosk&&st.tables.length?st.tables[Math.floor(rng()*st.tables.length)].id:null,
      custId:cust?cust.id:null,empId:kiosk?null:empId,source:kiosk?'kiosk':'pos',discount,discAmt:t.disc,subtotal:t.subtotal,tax:t.tax,total:t.total,tip,payments,status:'paid',pts:0};
    if(rng()<.007){o.status='refunded';o.refund={ts:ts+RI(3,40)*MIN,by:mgr.id,reason:'Customer complaint',restock:false};}
    if(cust&&o.status==='paid'){o.pts=Math.floor(o.total*s.loyalty.earn);cust.points+=o.pts;cust.visits++;cust.spend=r2(cust.spend+o.total);cust.last=Math.max(cust.last||0,ts);}
    o.items=o.items.map(slim);
    return o;
  }
  for(let d=DAYS-1;d>=0;d--){
    const day=dayStart(-d),dow=new Date(day).getDay();
    const shifts=[];
    staff.forEach(e=>{
      if(rng()>(e.role==='manager'?.74:.5))return;
      const mid=rng()<.45;
      const start=day+((s.openHour-.5)+(mid?3.5:0))*HOUR+RI(-8,8)*MIN;
      const end=start+(mid?5.5:7.5)*HOUR+RI(-10,25)*MIN;
      if(start>now)return;
      shifts.push({id:uid('sh'),emp:e.id,in:start,out:end>now?null:end});
    });
    if(d>0&&rng()<.4){const start=day+10*HOUR;shifts.push({id:uid('sh'),emp:owner.id,in:start,out:start+4*HOUR});}
    st.shifts.push(...shifts);
    const n=Math.round((hosp?92:34)*DOW[dow]*(1+(DAYS-1-d)*.0045)*R(.86,1.14));
    for(let i=0;i<n;i++){
      const h=pickW(rng,hours,x=>HW[x]);
      const ts=day+h*HOUR+Math.floor(rng()*HOUR);
      if(ts>now-3*MIN)continue;
      const on=shifts.filter(x=>x.in<=ts&&(x.out||now)>=ts);
      orders.push(makeOrder(ts,h,on.length?on[Math.floor(rng()*on.length)].emp:(staff[0]||owner).id));
    }
  }
  orders.sort((a,b)=>a.ts-b.ts);
  orders.forEach((o,i)=>o.no=1001+i);
  st.orders=orders;
  st.seq=1001+orders.length;
  st.customers.forEach(c=>{c.points=Math.round(c.points*.35);});
  // Live service: open tables, kitchen queue and an open cash drawer
  if(hosp){
    const P=n=>prods.find(p=>p.name===n);
    const L=(n,qty,mods=[])=>{const p=P(n);return mkLine(p,mods.map(([g,nm,pr])=>({g,n:nm,p:pr})),qty);};
    const who=(staff[1]||staff[0]||owner).id;
    const mk=(extra,items)=>{const t=totalsFor(items,null,s);const o={id:uid('o'),no:st.seq++,ts:now,opened:now,items,type:'dine',table:null,custId:null,empId:who,source:'pos',discount:null,discAmt:0,subtotal:t.subtotal,tax:t.tax,total:t.total,tip:0,payments:[],status:'open',pts:0,...extra};if(o.status==='paid')o.payments=[{m:'card',a:o.total}];st.orders.push(o);return o;};
    const tk=(o,mins,status,lines)=>st.tickets.push({id:uid('k'),orderId:o.id,no:o.no,ts:now-mins*MIN,status,type:o.type,table:o.table,source:o.source,items:(lines||o.items).map(l=>({name:l.name,qty:l.qty,mods:(l.mods||[]).map(m=>m.n),note:l.note||'',done:status==='ready'})),doneTs:status==='done'?now-mins*MIN+12*MIN:null});
    const o1=mk({table:'t5',opened:now-38*MIN,ts:now-38*MIN},[L('Full Breakfast',2,[['m-eggs','Poached',0]]),L('Flat White',1,[['m-milk','Oat',.4]]),L('English Breakfast',1)]);
    tk(o1,36,'done');
    const o2=mk({table:'t10',opened:now-9*MIN,ts:now-9*MIN},[L('Avocado Toast',1,[['m-eggs','Poached',0]]),L('Latte',2,[['m-size','Large',.5]]),L('Fresh Orange Juice',1)]);
    tk(o2,8,'prep');
    const o3=mk({table:'t2',opened:now-74*MIN,ts:now-74*MIN},[L('Cappuccino',2),L('Almond Croissant',2,[['m-warm','Warmed',0]])]);
    tk(o3,72,'done');
    const o4=mk({status:'paid',type:'delivery',ts:now-13*MIN,opened:now-13*MIN},[L('Chicken Club',2),L('Soup of the Day',1),L('Cloudy Lemonade',2)]);
    tk(o4,13,'prep');
    const o5=mk({status:'paid',type:'takeaway',source:'kiosk',empId:null,ts:now-4*MIN,opened:now-4*MIN},[L('Iced Latte',1,[['m-milk','Oat',.4]]),L('Cinnamon Swirl',1)]);
    tk(o5,4,'new');
    const o6=mk({status:'paid',type:'takeaway',ts:now-1*MIN,opened:now-1*MIN},[L('Flat White',2),L('Bacon Bap',1)]);
    tk(o6,1,'new');
    const o7=mk({status:'paid',type:'takeaway',ts:now-6*MIN,opened:now-6*MIN,custId:st.customers[3].id},[L('Mocha',1),L('Banana Bread',1,[['m-warm','Warmed',0]])]);
    tk(o7,6,'ready');
  }
  // Number every order in time order so receipts read naturally
  st.orders.sort((a,b)=>a.ts-b.ts);
  st.orders.forEach((o,i)=>o.no=1001+i);
  st.tickets.forEach(t=>{const o=st.orders.find(x=>x.id===t.orderId);if(o)t.no=o.no;});
  st.seq=1001+st.orders.length;
  // Cash drawer: today's session plus a week of closed sessions
  const openAt=dayStart(0)+(s.openHour-.25)*HOUR;
  const cashFor=(a,b)=>sum(st.orders.filter(o=>o.ts>=a&&o.ts<b&&o.status!=='open'),o=>sum(o.payments.filter(p=>p.m==='cash'),p=>p.a));
  const vars=[0,0,-.5,1.2,-4.8,.3,0];
  for(let d=7;d>=1;d--){
    const a=dayStart(-d)+(s.openHour-.25)*HOUR,b=dayStart(-d)+(s.closeHour+.25)*HOUR;
    const expected=r2(s.defaultFloat+cashFor(a,b)),v=vars[d-1];
    st.drawer.history.push({id:uid('dr'),ts:a,closedTs:b,float:s.defaultFloat,moves:[],expected,counted:r2(expected+v),variance:v,by:mgr.id,closedBy:mgr.id});
  }
  if(now>openAt)st.drawer.open={id:uid('dr'),ts:openAt,float:s.defaultFloat,by:mgr.id,moves:hosp?[{ts:openAt+95*MIN,kind:'out',amount:12.5,reason:'Milk top-up from the corner shop',by:mgr.id}]:[]};
  // Stock history
  prods.filter(p=>p.stock!=null).slice(0,6).forEach((p,i)=>st.stockLog.push({id:uid('sl'),ts:dayStart(-1)+7*HOUR+i*4*MIN,pid:p.id,name:p.name,change:12+i*2,kind:'receive',reason:'Morning delivery',by:mgr.id,after:p.stock}));
  const bw=prods.find(p=>p.stock!=null);
  if(bw)st.stockLog.push({id:uid('sl'),ts:dayStart(-1)+17*HOUR,pid:bw.id,name:bw.name,change:-3,kind:'waste',reason:'End of day waste',by:mgr.id,after:bw.stock});
}
