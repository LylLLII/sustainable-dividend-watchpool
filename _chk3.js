
// ============ 数据 ============
let pool = { meta:{ valuation_bands:[], disclaimer:"" }, stocks:[] };
const LS_KEY = 'watchpool_v1';

function loadPool(){
  const ls = localStorage.getItem(LS_KEY);
  if(ls){ try{ pool = JSON.parse(ls); return; }catch(e){} }
  fetch('data/watchpool.json').then(r=>r.json()).then(d=>{ pool = d; renderAll(); }).catch(()=>{
    toast('⚠️ 无法加载 data/watchpool.json，请通过本仓库页面访问');
  });
}
function persist(){ localStorage.setItem(LS_KEY, JSON.stringify(pool)); }

// ============ 行情 ============
let quotes = {};
let quoteLoading = false;

function codeList(){ return pool.stocks.map(s=>s.code).join(','); }

function refreshQuotes(){
  if(quoteLoading) return;
  const codes = codeList();
  if(!codes){ renderAll(); return; }
  quoteLoading = true;
  document.getElementById('quote-time').textContent = '行情加载中...';
  const script = document.createElement('script');
  script.src = 'https://qt.gtimg.cn/q=' + codes;
  script.onload = () => {
    quotes = collectQuotes(codes);
    quoteLoading = false;
    const t = new Date();
    document.getElementById('quote-time').textContent = '行情时间 ' + t.toLocaleTimeString('zh-CN',{hour12:false});
    renderAll();
    script.remove();
  };
  script.onerror = () => {
    quoteLoading = false;
    document.getElementById('quote-time').textContent = '行情获取失败，请检查网络';
    script.remove();
  };
  document.body.appendChild(script);
}

function collectQuotes(codes){
  const q = {};
  codes.split(',').forEach(c => {
    const v = window['v_' + c];
    if(!v) return;
    const p = v.split('~');
    const isHK = c.startsWith('hk');
    const isUS = c.startsWith('us');
    // A股字段：3现价 31涨跌 32涨跌幅 33最高 34最低 39 PE(TTM) 46 PB 64 TTM股息率 67/68 52周高低
    // 港股/美股字段结构不同，TTM股息率/PE/PB 部分不可靠，港股用静态dividendRatioTtm兜底
    const rec = {
      name: p[1], price: parseFloat(p[3]),
      chg: parseFloat(p[31]), chgPct: parseFloat(p[32]),
      high: parseFloat(p[33]), low: parseFloat(p[34])
    };
    if(!isHK && !isUS){
      rec.pe = parseFloat(p[39]);
      rec.pb = parseFloat(p[46]);
      rec.ttmYield = parseFloat(p[64]);
      rec.high52 = parseFloat(p[67]) || parseFloat(p[33]);
      rec.low52 = parseFloat(p[68]) || parseFloat(p[34]);
    }
    q[c] = rec;
  });
  return q;
}

// ============ 渲染 ============
const BANDS = [
  { min:8,   label:'极端低估·重点研究', cls:'band-extreme' },
  { min:7,   label:'深度低估', cls:'band-deep' },
  { min:6,   label:'明显低估', cls:'band-cheaper' },
  { min:5,   label:'开始低估', cls:'band-cheap' },
  { min:0,   label:'正常/偏贵', cls:'band-normal' }
];

function bandOf(y){
  if(!isFinite(y)) return BANDS[4];
  for(const b of BANDS){ if(y >= b.min) return b; }
  return BANDS[4];
}

function renderAll(){ renderStats(); renderTable(); }

function filteredStocks(){
  const kw = (document.getElementById('search').value||'').trim().toLowerCase();
  const f = document.getElementById('filter').value;
  return pool.stocks.filter(s=>{
    if(kw && !(s.name.toLowerCase().includes(kw) || s.code.toLowerCase().includes(kw))) return false;
    const q = quotes[s.code]; const y = q && s.expDps>0 ? s.expDps/q.price*100 : -1;
    if(f==='cheap' && y<5) return false;
    if(f==='deeper' && y<6) return false;
    if(f==='deep' && y<7) return false;
    if(f==='extreme' && y<8) return false;
    return true;
  }).sort((a,b)=>{
    const qa=quotes[a.code], qb=quotes[b.code];
    const ya = qa&&a.expDps>0 ? a.expDps/qa.price : -1;
    const yb = qb&&b.expDps>0 ? b.expDps/qb.price : -1;
    const sort = document.getElementById('sort').value;
    if(sort==='yield-desc') return yb-ya;
    if(sort==='yield-asc') return ya-yb;
    return a.name.localeCompare(b.name,'zh');
  });
}

function renderStats(){
  const rows = pool.stocks.map(s=>{ const q=quotes[s.code]; return { s, q, y: q&&s.expDps>0? s.expDps/q.price*100 : -1 }; });
  const valid = rows.filter(r=>r.y>=0);
  const avg = valid.length ? valid.reduce((a,r)=>a+r.y,0)/valid.length : 0;
  document.getElementById('stat-count').textContent = pool.stocks.length;
  document.getElementById('stat-avg').innerHTML = avg>0 ? avg.toFixed(2)+'<small>%</small>' : '—';
  document.getElementById('stat-cheap').textContent = valid.filter(r=>r.y>=5).length;
  document.getElementById('stat-deeper').textContent = valid.filter(r=>r.y>=6).length;
  document.getElementById('stat-deep').textContent = valid.filter(r=>r.y>=7).length;
}

function nextExDate(s){
  // 找最近一个晚于今天的除息日；没有则显示最近一次
  const today = new Date().toISOString().slice(0,10);
  const hist = s.divHist || [];
  let next = null;
  for(const h of hist){ if(h.exDate > today && (!next || h.exDate < next)) next = h.exDate; }
  return next;
}

function renderTable(){
  const tb = document.getElementById('tbody');
  const list = filteredStocks();
  if(!list.length){ tb.innerHTML = '<tr class="loading-row"><td colspan="17">没有符合条件的股票</td></tr>'; return; }
  const today = new Date().toISOString().slice(0,10);
  tb.innerHTML = list.map(s=>{
    const q = quotes[s.code];
    const y = q && s.expDps>0 ? s.expDps/q.price*100 : null;
    const b = y!=null ? bandOf(y) : BANDS[4];
    const chgCls = !q ? 'flat' : (q.chg>0?'up':(q.chg<0?'down':'flat'));
    const chgTxt = !q ? '—' : (q.chg>0?'+':'')+q.chg.toFixed(2)+' ('+(q.chg>0?'+':'')+q.chgPct.toFixed(2)+'%)';
    // TTM股息率：A股接口自动；港股/美股用静态兜底
    let ttmYield = null;
    if(q && q.ttmYield!=null && !isNaN(q.ttmYield)) ttmYield = q.ttmYield;
    else if(s.dividendRatioTtm!=null) ttmYield = s.dividendRatioTtm;
    const ttmTxt = ttmYield!=null ? ttmYield.toFixed(2)+'%' : '—';
    // 52周股息率区间（用预期分红）与百分位
    const hi = q ? (q.high52||q.high) : 0, lo = q ? (q.low52||q.low) : 0;
    let hist = '—', pctTxt = '—';
    if(hi>0 && lo>0 && s.expDps>0 && y!=null){
      const yHi = s.expDps/lo*100, yLo = s.expDps/hi*100;   // 价格低→股息率高
      hist = yLo.toFixed(1)+'% ~ '+yHi.toFixed(1)+'%';
      if(yHi>yLo){
        const pct = Math.max(0, Math.min(100, (y - yLo)/(yHi - yLo)*100));
        pctTxt = pct.toFixed(0)+'%';
      }
    }
    // 派息率参考 = TTM股息率 × PE (参考 DividendRanks 分红可持续性思路)
    let payout = null;
    if(ttmYield!=null && q && q.pe>0) payout = ttmYield * q.pe / 100;
    const payoutTxt = payout!=null ? (payout*100).toFixed(0)+'%' : '—';
    // 参考加仓价
    const targets = s.expDps>0 ? [
      {y:5,label:'5%建仓'},{y:6,label:'6%加'},{y:7,label:'7%重'},{y:8,label:'8%重点'}
    ].map(t=>{ const p=s.expDps/t.y*100; return '<span title="'+t.label+'" style="margin-right:6px">'+t.label+'<b style="color:var(--primary)">'+p.toFixed(2)+'</b></span>'; }).join('') : '—';
    // 除息日
    const ex = nextExDate(s);
    const exTxt = ex ? (ex<=today ? '—' : (ex.slice(0,10)+ (ex<=today?'':'') )) : '—';
    const exSoon = ex && ex<=today ? '' : (ex && ex > today && (new Date(ex)-new Date(today))/86400000 <= 45 ? ' soon' : '');
    const marketTag = '<span class="market-tag">'+s.market+'</span>';
    // 类别（MR Dang C32 股息率安全边际分级法）：资源类≥7%红线，稳健类≥5%
    const isResource = (s.category||'').startsWith('资源类');
    const redline = isResource ? '<span class="redline" title="C32：资源类股息率安全边际≥7%">7%红线</span>' : '';
    const catTxt = s.category ? '<span class="cat-tag" title="C32股息率安全边际分级法">'+esc(s.category)+'</span>' : '';
    // 超额收益率 = 预期股息率 - 10年国债收益率（C4第④步对比国债）
    const bondYield = parseFloat(document.getElementById('bondYield').value) || 1.70;
    const excess = y!=null ? y - bondYield : null;
    const excessTxt = excess!=null
      ? `<span class="excess ${excess>=0?'pos':'neg'}" title="预期股息率(${y.toFixed(2)}%) − 10年国债(${bondYield.toFixed(2)}%)">${excess>0?'+':''}${excess.toFixed(2)}%</span>`
      : '—';
    return `<tr>
      <td><span class="stock-name">${esc(s.name)}</span><span class="stock-code">${esc(s.code)}</span>${marketTag}${catTxt}</td>
      <td class="${chgCls}" style="font-size:15px;font-weight:600">${q? q.price.toFixed(2) : '—'}</td>
      <td class="${chgCls}">${chgTxt}</td>
      <td><span class="ttm-yield">${ttmTxt}</span></td>
      <td>${y!=null ? `<span class="yield ${y>=7?'up':''}">${y.toFixed(2)}%</span>${redline}` : '<span class="flat">—</span>'}</td>
      <td>${excessTxt}</td>
      <td>${y!=null ? `<span class="band ${b.cls}">${b.label}</span>` : '—'}</td>
      <td><span class="history-range">${hist}</span></td>
      <td><span class="percentile" title="当前预期股息率在52周区间中的位置，越接近100%越处于历史高位">${pctTxt}</span></td>
      <td>${q && q.pe>0 ? q.pe.toFixed(1) : '—'}</td>
      <td>${q && q.pb>0 ? q.pb.toFixed(2) : '—'}</td>
      <td>${payoutTxt}</td>
      <td><span class="price-target">${targets}</span></td>
      <td><span class="ex-date${exSoon}">${exTxt}</span></td>
      <td>${catTxt}</td>
      <td class="note" title="${esc(s.note||'')}">${esc(s.note||'—')}</td>
      <td>
        <button class="btn sm" onclick="openEditModal(${pool.stocks.indexOf(s)})">编辑</button>
        <button class="btn sm danger" onclick="removeStock(${pool.stocks.indexOf(s)})">删除</button>
      </td>
    </tr>`;
  }).join('');
}

function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ============ 添加 / 编辑 ============
function openAddModal(){
  document.getElementById('modal-title').textContent = '添加股票';
  document.getElementById('edit-index').value = -1;
  ['f-code','f-name','f-dps','f-note'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('f-price').value='';
  document.getElementById('modal').classList.add('show');
}
function openEditModal(i){
  const s = pool.stocks[i];
  document.getElementById('modal-title').textContent = '编辑 ' + s.name;
  document.getElementById('edit-index').value = i;
  document.getElementById('f-code').value = s.code;
  document.getElementById('f-name').value = s.name;
  document.getElementById('f-price').value = quotes[s.code] ? quotes[s.code].price : '';
  document.getElementById('f-dps').value = s.expDps||'';
  document.getElementById('f-note').value = s.note||'';
  document.getElementById('modal').classList.add('show');
}
function closeModal(){ document.getElementById('modal').classList.remove('show'); }

function autoFill(){
  const code = document.getElementById('f-code').value.trim();
  if(!code) return;
  const v = window['v_'+code];
  if(v){
    const p = v.split('~');
    document.getElementById('f-name').value = p[1];
    document.getElementById('f-price').value = parseFloat(p[3])||'';
    return;
  }
  const script = document.createElement('script');
  script.src = 'https://qt.gtimg.cn/q=' + code;
  script.onload = () => {
    const v = window['v_'+code];
    if(v){ const p=v.split('~'); document.getElementById('f-name').value=p[1]; document.getElementById('f-price').value=parseFloat(p[3])||''; }
    script.remove();
  };
  document.body.appendChild(script);
}

function saveStock(){
  const i = parseInt(document.getElementById('edit-index').value);
  const code = document.getElementById('f-code').value.trim();
  const name = document.getElementById('f-name').value.trim();
  const dps = parseFloat(document.getElementById('f-dps').value);
  const note = document.getElementById('f-note').value.trim();
  if(!code || !/^(sh|sz|hk|us)[a-zA-Z0-9]+$/.test(code)){ toast('⚠️ 代码格式不正确，如 sh601088'); return; }
  if(!(dps>0)){ toast('⚠️ 请填写预期每股分红'); return; }
  const obj = { code, name: name||code, market: code.startsWith('sh')?'A股':code.startsWith('sz')?'A股':code.startsWith('hk')?'港股':'美股', expDps: dps, note };
  if(i>=0){ pool.stocks[i] = {...pool.stocks[i], ...obj}; toast('✅ 已保存'); }
  else {
    if(pool.stocks.some(s=>s.code===code)){ toast('⚠️ 该股票已在观察池中'); return; }
    pool.stocks.push(obj); toast('✅ 已加入观察池');
  }
  persist(); closeModal(); refreshQuotes();
}
function removeStock(i){
  if(!confirm('确定从观察池移除 '+pool.stocks[i].name+' 吗？')) return;
  pool.stocks.splice(i,1); persist(); renderAll();
  if(!pool.stocks.length){ quotes={}; }
  else refreshQuotes();
}

// ============ 导出 ============
function exportJSON(){
  const blob = new Blob([JSON.stringify(pool,null,2)],{type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'watchpool_export_'+new Date().toISOString().slice(0,10)+'.json';
  a.click();
  toast('✅ 已导出 JSON（含本地修改）');
}

// ============ 其他 ============
let toastTimer;
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2200); }
document.getElementById('modal').addEventListener('click', e=>{ if(e.target.id==='modal') closeModal(); });

// 启动
loadPool();
refreshQuotes();
setInterval(()=>{ refreshQuotes(); }, 30000);
