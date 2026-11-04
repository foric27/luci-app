#!/usr/bin/env node
/*
 * page-render-selftest.js - offline rendering check for the traffic page.
 *
 * The interesting failure this catches is one no syntax check can see: LuCI's
 * E() ends up in document.createElement(), which never produces an SVG element.
 * A donut or chart built that way is created happily, passes node --check, and
 * then renders as nothing at all - an empty card on the page.
 *
 * It loads the real view file with a stub DOM that records namespaces, drives
 * the real draw()/drawSeries()/drawStatus() paths, and asserts what landed in
 * the tree.
 *
 *   node tools/page-render-selftest.js
 */
const fs = require('fs');
const path = require('path');
const VIEW = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'traffic', 'overview.js');
const src = fs.readFileSync(VIEW, 'utf8')
  .replace(/^'use strict';\s*$/m, '').replace(/^'require [^']+';\s*$/gm, '');
const SVG='http://www.w3.org/2000/svg', XHTML='http://www.w3.org/1999/xhtml';
const seen={ns:{}, htmlUsed:0, wrongNs:[], tags:{}};
function mk(ns,tag,attrs,children){
  seen.ns[ns==null?'null':ns]=(seen.ns[ns==null?'null':ns]||0)+1;
  seen.tags[tag]=(seen.tags[tag]||0)+1;
  if(ns===XHTML && ['svg','g','circle','path','line','text'].includes(tag)) seen.wrongNs.push(tag);
  const n={tag,ns,attrs:{},children:[],parentNode:null,_text:'',style:{},
    setAttribute(k,v){ this.attrs[k]=v; }, removeAttribute(k){ delete this.attrs[k]; },
    _listeners:{},
    addEventListener(type,fn){ this._listeners[type]=fn; },
    removeEventListener(type){ delete this._listeners[type]; }, focus(){},
    appendChild(c){ if(c.parentNode)c.parentNode.removeChild(c); c.parentNode=this; this.children.push(c); return c; },
    // the strip re-appends boxes that are out of order, so the stub needs this
    insertBefore(c,ref){ if(c.parentNode)c.parentNode.removeChild(c);
      const i=ref?this.children.indexOf(ref):-1;
      if(i<0)this.children.push(c); else this.children.splice(i,0,c);
      c.parentNode=this; return c; },
    removeChild(c){ const i=this.children.indexOf(c); if(i>=0)this.children.splice(i,1); c.parentNode=null; return c; },
    get firstChild(){ return this.children[0]||null; },
    // a real DOM replaces every child when textContent is assigned
    set textContent(v){ this._text=String(v); this.children=[]; },
    get textContent(){ return this._text; },
    get classList(){ return {add(){},remove(){}}; },
    // a real element's className is '' until something sets it, not undefined
    set className(v){ this.attrs['class']=v; }, get className(){ return this.attrs['class']||''; }
  };
  for(const k in (attrs||{})) n.attrs[k]=attrs[k];
  (children||[]).forEach(c=>n.appendChild(c));
  return n;
}
function E(tag,attrs,children){ return mk(XHTML,tag,attrs,children); }
// capture what injectCss() puts into the <style> element
global.__capturedCss = '';
const documentStub={
  createElement(t){
    const n=mk(XHTML,t);
    if(t==='style') n.appendChild=function(c){ global.__capturedCss += (c && c._text) || ''; };
    return n;
  },
  createElementNS(ns,t){ return mk(ns,t); },
  createTextNode(t){ const n=mk(null,'#text'); n._text=String(t); return n; },
  getElementById(){ return null; },
  addEventListener(){}, removeEventListener(){},
  head:{ appendChild(n){ if(n && n.id==='tf-css') global.__capturedCss=global.__capturedCss||''; } },
  hidden:false
};
const imageRequests=[];
const imageObjects=[];
function ImageStub(){
  let source='';
  const img=mk(XHTML,'img');
  imageObjects.push(img);
  Object.defineProperty(img,'src',{get(){return source;},set(v){
    source=v;imageRequests.push(v);
    // Browsers defer a detached lazy image. An onload-only append must not
    // deadlock: recording its URL alone does not prove that it is displayed.
    queueMicrotask(()=>{
      if(img.loading==='lazy'&&!img.parentNode)return;
      if(img.onload)img.onload();
    });
  }});
  return img;
}
const factory=new Function('view','rpc','dom','poll','_','E','L','document','Image','confirm',
  src.replace(/return view\.extend\(/,
    'global.__injectCss = injectCss;\n' +
    'global.__iconTest = {makeIcon:makeIcon,loadWebsites:loadWebsiteIndex,refreshWebsites:refreshWebsiteIcons,setPending:function(p){iconIndexPromise=p;shippedIcons={};cachedIcons=null;},' +
    'setShipped:function(m){shippedIcons=m;},setDomains:function(m){domainIcons=m;},setWebsites:function(m){websiteIcons=m;cachedIcons={};shippedIndexFailed=false;}};\nreturn view.extend('));
const viewStub={extend(o){ viewStub.__obj=o; return o; }};
const domStub={content(node,ch){ node.children=[]; (Array.isArray(ch)?ch:[ch]).forEach(x=>{ if(x) node.appendChild(x); }); }};
const _id=s=>s;
factory(viewStub,{declare(){return ()=>Promise.resolve({});}},domStub,{add(){}},_id,
  E,{bind(f,c){return f.bind(c);},resource(p){return p;},env:{}},documentStub,ImageStub,()=>true);
const view=viewStub.__obj;
let fail=0; const chk=(c,m)=>{ console.log(`  ${c?'PASS':'FAIL'} ${m}`); if(!c)fail++; };
const walk=(n,fn)=>{ fn(n); (n.children||[]).forEach(c=>walk(c,fn)); };
const texts=(root)=>{ const a=[]; (root.children||[]).forEach(c=>walk(c,n=>{ if(n.tag==='span'&&n._text)a.push(n._text); })); return a; };
const count=(root,tag)=>{ let k=0; (root.children||[]).forEach(c=>walk(c,n=>{ if(n.tag===tag)k++; })); return k; };
// the strip's boxes, in order: one caption/value pair each
const boxes=root=>{ const a=[]; walk(root,c=>{
  if(String((c.attrs||{}).class||'').split(' ').includes('tf-stat')){
    const spans=c.children.filter(x=>x.tag==='span');
    a.push({cap:spans[0]&&spans[0]._text,val:spans[1]&&spans[1]._text});
  }
}); return a; };
const txt=n=>{ let s=''; (function go(x){ if(!x||typeof x!=='object')return;
  if(x._text)s+=x._text+' '; ((x.children)||[]).forEach(go); })(n); return s; };

function freshView(){
  // the ring is drawn into the figure inside .tf-donut, and the strip/diag
  // composers are methods on the view, so the fake has to be view-prototyped
  // and nested the way render() builds it
  const donutFigEl=E('div'), donutEl=E('div',{'class':'tf-donut'});
  donutEl.appendChild(donutFigEl);
  return Object.assign(Object.create(view), {
           rowsEl:E('tbody'), donutEl:donutEl, donutFigEl:donutFigEl, donutTotalEl:E('div'),
           legendEl:E('div'), totalEl:E('div'), diagEl:E('div'), diagCardEl:E('div'),
           statusEl:E('div'), chartEl:E('div'), chartNote:E('span'),
           rateDown:E('b'), rateUp:E('b'), packetsDown:E('b'), packetsUp:E('b'), liveNote:E('small'),
           // draw() rewrites the hero caption on every refresh.
           heroCapEl:E('div') });
}
const items=[{name:'YouTube',down:1e6,up:1e5,bytes:11e5,clients:3,top:'192.168.2.5',top_bytes:5e5},
             {name:'Google',down:9e5,up:9e4,bytes:99e4,clients:5,top:'192.168.2.7',top_bytes:4e5},
             {name:'CDN',down:8e5,up:8e4,bytes:88e4,clients:9,top:'192.168.2.9',top_bytes:3e5}];
const stats={total:11e5+99e4+88e4,down:27e5,up:27e4,topText:'192.168.2.5 1.2 MiB',clientCount:12};

console.log('=== draw(): кольцевая диаграмма идёт по реальному пути рендеринга ===');
for(const k in seen.ns) delete seen.ns[k]; seen.wrongNs=[];
const v=freshView();
view.draw.call(v,items,stats);
const donutCount=count(v.donutEl,'svg');
chk(donutCount===1, `в donutEl 1 svg（${donutCount})`);
const svgNode=(function find(n){ if(n.tag==='svg')return n; for(const c of (n.children||[])){ const r=find(c); if(r)return r; } return null; })(v.donutEl);
chk(svgNode && svgNode.ns===SVG, `корневой элемент кольца в пространстве имён SVG（ns=${svgNode&&svgNode.ns===SVG?'SVG':'HTML'})`);
chk(svgNode && svgNode.attrs.viewBox==='0 0 168 168', `viewBox = ${svgNode&&svgNode.attrs.viewBox}`);
chk(svgNode && svgNode.attrs.width == 168, `есть внутренняя ширина ${svgNode&&svgNode.attrs.width}（иначе карточка схлопнется в пустую коробку)`);
chk(count(v.donutEl,'circle')===3, `3 секторных круга（${count(v.donutEl,'circle')})`);
chk(seen.wrongNs.length===0, `ни один SVG-тег не создан как HTML-элемент（исключений ${seen.wrongNs.join(',')||'нет'})`);
console.log(`  статистика пространств имён: SVG=${seen.ns[SVG]||0}, XHTML=${seen.ns[XHTML]||0}`);

console.log('=== Малые сектора кольца отделены от нераспознанного ===');
const vMicro=freshView();
view.draw.call(vMicro,[
  {name:'Large',down:12000,up:0,bytes:12000},
  {name:'Proto',down:7000,up:0,bytes:7000},
  {name:'Tiny',down:1000,up:0,bytes:1000}
],{total:1000000,down:1000000,up:0,shareTotal:20000,shareDown:20000,shareUp:0,
  topText:'—',clientCount:1});
chk(!vMicro.legendCache.Tiny && !!vMicro.rowCache.Tiny,
  'приложения меньше 0,5% от итога объединены в легенде, полная таблица сохраняет исходные строки');
chk(!!vMicro.legendCache.Attributed &&
    vMicro.legendCache.Attributed.pct.textContent==='0.1%',
  'малые сектора входят в распознанное, знаменатель по-прежнему весь трафик');
chk(!!vMicro.legendCache.Unattributed &&
    vMicro.legendCache.Unattributed.pct.textContent==='98.0%',
  'нераспознанное и распознанное разделены, проценты сходятся');

console.log('=== При пустых данных кольцо больше не пустая коробка ===');
const v2=freshView();
view.draw.call(v2,[],{total:0,down:0,up:0,topText:'—',clientCount:0});
chk(count(v2.donutEl,'circle')===1, `серая заглушка-круг 1 шт. (${count(v2.donutEl,'circle')})`);
chk(count(v2.donutEl,'text')===1, `текст-заглушка 1 шт. (${count(v2.donutEl,'text')})`);

console.log('=== drawSeries(): кривая пропускной способности ===');
const v3=freshView();
v3.seriesRange='1h';
v3.series={range:'1h',interval:10,points:Array.from({length:120},(_,i)=>[1789530000+i*10,i*1000,i*400])};
view.drawSeries.call(v3);
chk(count(v3.chartEl,'svg')===1, `в chartEl 1 svg（${count(v3.chartEl,'svg')})`);
chk(count(v3.chartEl,'line')===3, `3 линии сетки（${count(v3.chartEl,'line')})`);
chk(count(v3.chartEl,'path')===4, `4 элемента кривая+площадь（${count(v3.chartEl,'path')})`);
chk(count(v3.chartEl,'text')>=5, `текстовых подписей >=5（${count(v3.chartEl,'text')})`);
const csvg=(function find(n){ if(n.tag==='svg')return n; for(const c of (n.children||[])){ const r=find(c); if(r)return r; } return null; })(v3.chartEl);
chk(csvg && csvg.ns===SVG, `корневой элемент кривой в пространстве имён SVG`);
chk(csvg && typeof csvg.attrs.viewBox==='string' && csvg.attrs.viewBox.startsWith('0 0 720'), `viewBox = ${csvg&&csvg.attrs.viewBox}`);

console.log('=== Сглаживание кривой: монотонный кубический Безье ===');
// The curve has to be smooth without being allowed to lie.  A plain spline
// through traffic samples overshoots between a spike and the next low reading -
// below the floor on the way down, and a hump on a flat stretch - which draws
// bytes that were never transferred.  Monotone tangents (Fritsch-Carlson) limit
// each segment so it stays between the two samples it joins, so the shape is
// checked as well as the smoothness.
const curveDs=[], areaDs=[];
walk(v3.chartEl,n=>{ const c=(n.attrs||{}).class||'';
  if(n.tag==='path' && /tf-curve/.test(c)) curveDs.push(n.attrs.d);
  if(n.tag==='path' && /tf-area/.test(c)) areaDs.push(n.attrs.d); });
chk(curveDs.length===2, `два пути кривых（${curveDs.length})`);
chk(curveDs.every(d=>(d.match(/C/g)||[]).length===119 && !/L/.test(d)),
    `по 119 сегментов кубического Безье, без прямых（C=${(curveDs[0]||'').match(/C/g)?.length})`);
chk(areaDs.length===2 && areaDs.every((d,i)=>d.indexOf(curveDs[i])===0),
    'заливка площади использует ту же кривую, а не более прямую');
// every y in the path - samples and Bezier control points alike - has to sit
// inside the plot band, which is what "no overshoot" means once it is drawn
const ysOf=d=>{
  const toks=d.match(/[MCL]|-?\d+(?:\.\d+)?/g)||[]; const ys=[]; let cur=null, k=0;
  for(const t of toks){
    if(t==='M'||t==='L'||t==='C'){ cur=t; k=0; continue; }
    k++; if(cur==='M'||cur==='L'){ if(k===2) ys.push(Number(t)); }
    else if(cur==='C'){ if(k%2===0) ys.push(Number(t)); }
  }
  return ys;
};
const plotTop=14, plotBottom=14+(190-14-22);
const allY=curveDs.concat(areaDs).flatMap(ysOf);
const bad=allY.filter(y=>y<plotTop-0.6||y>plotBottom+0.6);
chk(allY.length>100 && bad.length===0,
    `все y внутри области графика（${allY.length} шт., за пределами ${bad.length}${bad.length?' , например '+bad.slice(0,3).join(','):''})`);

console.log('=== Ось времени, пропуски выборки и отдельный пик ===');
const chartPaths=root=>{const a=[];walk(root,n=>{if(n.tag==='path')a.push(n);});return a;};
const vGap=freshView();
vGap.seriesRange='1h';
vGap.series={range:'1h',interval:10,points:[
  [1000,1000,0],[1010,2000,0],[1100,3000,0],[1110,4000,0]]};
view.drawSeries.call(vGap);
const gapCurve=chartPaths(vGap.chartEl).find(n=>n.attrs.class==='tf-curve tf-curve-down');
const gapArea=chartPaths(vGap.chartEl).find(n=>n.attrs.class==='tf-area-down');
chk(gapCurve && (gapCurve.attrs.d.match(/M/g)||[]).length===2,
  'пропуск больше интервала выборки разрывает кривую на две');
chk(gapArea && (gapArea.attrs.d.match(/Z/g)||[]).length===2,
  'заливка площади тоже разрывается на пропуске');
const starts=gapCurve && [...gapCurve.attrs.d.matchAll(/M([\d.]+)/g)].map(x=>Number(x[1]));
chk(starts && starts[1]-starts[0]>500,
  `ось X отражает реальный пропуск 90 секунд（${starts&&starts.join(',')})`);
const vPeak=freshView();
vPeak.seriesRange='1h';
vPeak.series={range:'1h',interval:10,points:[[1000,1000,0,0,0,0],
  [1010,1000,0,1000000,0,1],[1020,1000,0,0,0,0]]};
view.drawSeries.call(vPeak);
const peakSvg=vPeak.chartEl.children[0];
const peakTicks=[];walk(peakSvg,n=>{if(n.tag==='text'&&n.attrs.class==='tf-chart-tick')peakTicks.push(n._text);});
chk(peakTicks.some(t=>/128 B\/s/.test(t)) && !peakTicks.some(t=>/977 KiB\/s/.test(t)),
  `ось Y использует среднюю скорость интервала, а не 1-секундный пик（${peakTicks.join(', ')})`);
let peakMarks=0;walk(peakSvg,n=>{if((n.attrs.class||'').includes('tf-peak-mark'))peakMarks++;});
chk(peakMarks>0 && vPeak.chartNote.textContent.includes('977 KiB/s'),
  '1-секундный пик имеет отдельную метку и точное значение');
const vManyPeaks=freshView();
vManyPeaks.seriesRange='1h';
vManyPeaks.series={range:'1h',interval:10,points:Array.from({length:80},(_,i)=>
  [1000+i*10,1000,1000,100000+i*1000,120000+i*1000,1])};
view.drawSeries.call(vManyPeaks);
let peakMarkCount=0;walk(vManyPeaks.chartEl,n=>{
  if((n.attrs.class||'').includes('tf-peak-mark'))peakMarkCount++;
});
chk(peakMarkCount<=2, `в каждом направлении отмечается только самый сильный 1-секундный пик（${peakMarkCount} меток)`);

console.log('=== Оси рисуются и без выборок (чтобы не было пустой карточки) ===');
const v4=freshView();
v4.seriesRange='1h'; v4.series={range:'1h',interval:10,points:[]};
view.drawSeries.call(v4);
chk(count(v4.chartEl,'svg')===1 && count(v4.chartEl,'line')===3, `при пустых данных оси есть：svg=${count(v4.chartEl,'svg')}, line=${count(v4.chartEl,'line')}`);
chk(count(v4.chartEl,'div')>=1, `и есть подсказка «пока нет выборок»（${count(v4.chartEl,'div')})`);

console.log('=== Строка состояния: состояние, четыре ключевых числа, вспомогательная информация ===');
const v5=freshView();
view.drawStatus.call(v5,{collected_at:Math.floor(Date.now()/1000),interval:10,flows:1234,
  dnsmap_lines:5678,pending:3,acct:1,version:'0.1.23-r1'},items);
view.drawSummary.call(v5,[{cap:'Bucket',val:'24'},{cap:'Browser clients',val:'1.2 MiB'},
  {cap:'Router and tunnel',val:'0 B'},{cap:'Devices',val:'12'},{cap:'Apps and sites',val:'7'}]);
const b5=boxes(v5.statusEl);
chk(b5.length===10, 'все исходные показания показаны напрямую');
chk(v5.statusEl.children.length===3,'строка состояния разделена на три области');
const core=boxes(v5.stripMetrics);
chk(core.map(x=>x.cap).join('|')==='Flows|DNS mappings|Devices|Apps and sites','порядок четырёх ключевых показателей как в оригинале');
chk(core.map(x=>x.val).join('|')==='1,234|5,678|12|7','ключевые значения взяты из реальных данных');
chk(boxes(v5.stripMeta).map(x=>x.cap).join('|')==='Bucket|Browser clients|Collector version|Router and tunnel|Counting method','вся вспомогательная информация показана напрямую');
chk(txt(v5.stripState).includes('Updates every 10 seconds'),'подсказка обновления соответствует интервалу сбора');
const meta=v5.stripMeta, firstCore=v5.stripMetrics.children[0];
view.drawStatus.call(v5,{collected_at:Math.floor(Date.now()/1000),interval:10,flows:2345,dnsmap_lines:6789,pending:3,acct:1},items);
chk(v5.stripMeta===meta && count(v5.statusEl,'details')===0,'обновление сохраняет вспомогательную область без сворачивания');
chk(v5.stripMetrics.children[0]===firstCore && boxes(v5.stripMetrics)[0].val==='2,345','ключевые числа обновляются на месте');
const vOnly=freshView();
view.drawStatus.call(vOnly,{collected_at:Math.floor(Date.now()/1000),interval:10,flows:1,dnsmap_lines:1,acct:1},items);
chk(boxes(vOnly.statusEl).length===5,'до загрузки итогов окна устройства и трафик не выдумываются');
chk(b5.some(b=>b.val==='5,678'),'число записей DNS-сопоставлений показано напрямую');
chk(b5.some(b=>b.val==='nft counters'),'источник счётчиков сохранён');
const summaryFirst=freshView();
const summary=[{cap:'Bucket',val:'24'},{cap:'Browser clients',val:'1.2 MiB'},
  {cap:'Router and tunnel',val:'0 B'},{cap:'Devices',val:'12'},{cap:'Apps and sites',val:'7'}];
view.drawSummary.call(summaryFirst,summary);
chk(boxes(summaryFirst.stripMetrics).map(x=>x.cap).join('|')==='Devices|Apps and sites','если итоги пришли раньше, ключевые числа не переносятся во вспомогательную область');
chk(!summaryFirst.stripMeta.children.some(n=>n.className.includes('tf-stat-version')),'если состояние не пришло, чтения туннеля не получают стиль версии');
view.drawStatus.call(summaryFirst,{collected_at:Math.floor(Date.now()/1000),interval:10,flows:1,dnsmap_lines:2,acct:1},items);
chk(boxes(summaryFirst.stripMetrics).length===4 && boxes(summaryFirst.statusEl).length===10,'когда состояние приходит позже, десять показаний объединяются правильно');
chk(summaryFirst.stripMeta.children.filter(n=>n.className.includes('tf-stat-version')).length===1,'стиль версии только у показания версии');
view.drawStatus.call(summaryFirst,{collected_at:Math.floor(Date.now()/1000),interval:20,flows:1,dnsmap_lines:2,acct:1},items);
chk(txt(summaryFirst.stripRefresh)==='Updates every 20 seconds ','подсказка обновления меняется вместе с реальным интервалом');
console.log('=== Строка примечаний: условные показания не входят в полосу ===');
chk(txt(v5.diagEl).indexOf('Waiting to resolve')>=0, `ожидающие разрешения в строке примечаний（${txt(v5.diagEl).trim()})`);
chk(txt(v5.diagEl).indexOf('3')>=0, 'число ожидающих разрешения видно');
chk(v5.diagCardEl.style.display==='', 'строка примечаний показывается, когда есть содержимое');
const v9=freshView();
view.drawStatus.call(v9,{collected_at:Math.floor(Date.now()/1000),interval:10,flows:1,
  dnsmap_lines:1,pending:0,acct:1,version:'0.1.23-r1'},items);
chk(txt(v9.diagEl).trim()==='', 'без условий примечание не создаётся');
chk(v9.diagCardEl.style.display==='none', 'при пустой строке примечаний вся карточка скрыта');
// "Bucket" used to label two different readings, which only showed once the two
// strips were merged into one row: the archived-hour count and the hour being
// accumulated.  The second is a tooltip on the first now: as a note of its own it
// put a whole card at the bottom of the page to carry one raw bucket label.
const v10=freshView();
view.drawStatus.call(v10,{collected_at:Math.floor(Date.now()/1000),interval:10,flows:1,
  dnsmap_lines:1,pending:0,acct:1,hour:'2026-09-17T10'},items);
view.drawSummary.call(v10,[{cap:'Bucket',val:'24'},{cap:'Browser clients',val:'1 B'},
  {cap:'Router and tunnel',val:'0 B'},{cap:'Devices',val:'1'}]);
chk(txt(v10.diagEl).trim()==='', 'текущий час больше не занимает строку примечаний');
chk(v10.diagCardEl.style.display==='none', 'в обычном сценарии карточка примечаний не показывается');
const bucketRow=v10.statRows.find(r=>r.k._text==='Bucket').row;
chk(bucketRow && String((bucketRow.attrs||{}).title||'').indexOf('2026-09-17T10')>=0,
    `текущий час находится в подсказке периода（${bucketRow&&bucketRow.attrs.title})`);
chk(boxes(v10.statusEl).filter(b=>b.cap==='Bucket').length===1, 'только один блок периода');
const v8=freshView();
view.drawStatus.call(v8,{collected_at:Math.floor(Date.now()/1000),interval:10,flows:1,
  dnsmap_lines:1,pending:0,acct:0,acct_error:'nft is not installed'},items);
chk(boxes(v8.statusEl).some(b=>b.val==='conntrack'), 'при откате в полосе указан источник conntrack');
chk(txt(v8.diagEl).indexOf('Counter error')>=0 && txt(v8.diagEl).indexOf('nft is not installed')>=0,
    'причина отката видна в строке примечаний (не тихий сбой)');
// the box the strip reserved for the box own addresses is gone: it was the one
// reading long enough to force one box wider than the rest
chk(txt(v5.statusEl).indexOf('Router addresses')===-1, 'в полосе больше нет собственных адресов роутера');
chk(!/shortAddrs/.test(src), 'больше нет функции сокращения, существовавшей только для этого');
const v6=freshView();
view.drawStatus.call(v6,{collected_at:0,interval:0,flows:0,dnsmap_lines:0,pending:0},[]);
chk(txt(v6.statusEl).indexOf('Collector has not produced a snapshot yet')>=0,
    `без снимка есть явная подсказка（${txt(v6.statusEl).slice(0,40)})`);
chk(boxes(v6.statusEl).length===5, `без снимка пять показаний состояния на месте（${boxes(v6.statusEl).length})`);

console.log('=== Верхние живые скорости: один образец WAN, Mbps и PPS ===');
const flat=n=>{ let s=''; (function go(x){ if(typeof x==='string'){ s+=x; return; } if(x&&x._text)s+=x._text; ((x&&x.children)||[]).forEach(go); })(n); return s; };
const mkView=(o)=>Object.assign(Object.create(view),freshView(),o||{});
const rv=mkView({});
view.renderHourly.call(rv,{hours:[{hour:'h0',apps:[{name:'YouTube',down:36000,up:18000}],clients:[],router:0}]});
chk(flat(rv.rateDown)==='' && flat(rv.rateUp)==='', 'вид диапазона не перезаписывает мгновенную скорость');
const live=mkView({});
const wanSample={at:Math.floor(Date.now()/1000),monotonic_ms:1000,source:'iface',device:'eth2',ready:1,dt:1,
  bps_down:125000000,bps_up:25000000,pps_down:100000,pps_up:20000};
view.renderRealtime.call(live,wanSample);
chk(flat(live.rateDown)==='1000.0 Mbps' && flat(live.rateUp)==='200.00 Mbps','скорость WAN в байтах показывается в десятичных Mbps');
chk(flat(live.packetsDown)==='100,000 PPS' && flat(live.packetsUp)==='20,000 PPS','PPS и полоса используют один образец интерфейса');
view.renderHourly.call(live,{hours:[{hour:'h0',apps:[],clients:[],router:0}]});
chk(flat(live.rateDown)==='1000.0 Mbps','смена окна статистики не перезаписывает мгновенную скорость WAN');
view.renderRealtime.call(live,Object.assign({},wanSample,{bps_down:0,bps_up:0,pps_down:0,pps_up:0}));
chk(flat(live.rateDown)==='0.00 Mbps' && flat(live.packetsDown)==='0 PPS','измеренный ноль сохраняется');
view.renderRealtime.call(live,Object.assign({},wanSample,{at:wanSample.at-30}));
chk(flat(live.rateDown)==='—' && flat(live.packetsDown)==='—','устаревший образец очищает все четыре мгновенных показания');
view.renderRealtime.call(live,null);
chk(flat(live.rateUp)==='—' && flat(live.packetsUp)==='—','при сбое нет отката к среднему за период');

console.log('=== Структура страницы: один выпадающий список, ширины в colgroup ===');
const page=view.render.call(Object.assign(Object.create(view),freshView()),{});
const colClasses=[]; walk(page,n=>{ if(n.tag==='col') colClasses.push((n.attrs||{}).class); });
chk(colClasses.length===6, `в таблице 6 <col>（${colClasses.length})`);
chk(colClasses[0]==='tf-col-app', `первый <col> — столбец имени（${colClasses[0]})`);
// При фиксированной раскладке именно col задаёт реальную ширину в браузере; правила темы для th/td до него не достают,
// поэтому столбец имени не сжимается в многоточие, а байтовые столбцы не занимают всю карточку
const selects=[]; walk(page,n=>{ if(n.tag==='select') selects.push(n); });
chk(selects.length===0, `на странице больше нет нативного <select> (${selects.length} шт.)`);
const ddBtn=[]; walk(page,n=>{ if(n.tag==='button'&&/tf-dd-btn/.test((n.attrs||{}).class||'')) ddBtn.push(n); });
chk(ddBtn.length===1, `элемент диапазона — нарисованная кнопка (${ddBtn.length} шт.)`);
chk(/listbox/.test(String((ddBtn[0]&&ddBtn[0].attrs||{}).role||'')+String((ddBtn[0]&&ddBtn[0].attrs||{})['aria-haspopup']||'')),
    'нарисованный список имеет семантику listbox');
const ddItems=[]; walk(page,n=>{ if(/tf-dd-item/.test((n.attrs||{}).class||'')) ddItems.push(n); });
chk(ddItems.length===5, `в списке 5 вариантов диапазона（${ddItems.length})`);
// The hero lays its three captions out on one row and the three readings on the
// next.  Three caption/reading pairs as their own columns read worse: with the
// bottoms aligned the captions come out at three different heights, because a
// 1.7rem line box and a 1.05rem one do not start at the same y.
const heroStats=[]; walk(page,n=>{ if((n.attrs||{}).class==='tf-hero-stats') heroStats.push(n); });
chk(heroStats.length===1, `hero — одна сетка（${heroStats.length})`);
chk(heroStats[0] && heroStats[0].children.length===10,
    `в сетке 10 ячеек: пять заголовков, затем пять показаний（${heroStats[0]&&heroStats[0].children.length})`);
const heroOrder=(heroStats[0]?heroStats[0].children:[]).map(c=>(c.attrs||{}).class);
chk(heroOrder.slice(0,5).every(c=>/tf-hero-cap/.test(c)),
    `первые пять ячеек — заголовки（${heroOrder.slice(0,5).join(' / ')})`);
chk(/tf-grand-total/.test(heroOrder[5]||'') && heroOrder.slice(6).every(c=>/tf-rate/.test(c)),
    `последние пять — итог, приём, отдача и PPS приёма/отдачи（${heroOrder.slice(5).join(' / ')})`);
// the two cards the merge produced: one strip, and the note line under the table
const cardClasses=[]; walk(page,n=>{ if(/tf-card/.test((n.attrs||{}).class||'')) cardClasses.push((n.attrs||{}).class); });
chk(cardClasses.some(c=>/tf-stat-card/.test(c)), 'есть карточка строки состояния');
chk(cardClasses.some(c=>/tf-diag-card/.test(c)), 'есть карточка примечаний под таблицей');
chk(!cardClasses.some(c=>/tf-status-card|tf-meta-card/.test(c)), 'две прежние карточки объединены и больше не существуют');
// the donut has a hole to put the total in
const donutCenter=[]; walk(page,n=>{ if((n.attrs||{}).class==='tf-donut-center') donutCenter.push(n); });
chk(donutCenter.length===1 && donutCenter[0].children.length===2,
    `в центре кольца два слоя: итог + заголовок（${donutCenter.length})`);

console.log('=== Уровень следует за диапазоном, по умолчанию день ===');
const pv=Object.assign(Object.create(view),freshView());
view.render.call(pv,{});
chk(pv.range==='24', `диапазон по умолчанию — день（${pv.range})`);
chk(pv.seriesRange==='24h', `кривая по умолчанию читает уровень 24 часа（${pv.seriesRange})`);
// Каждый уровень окна должен соответствовать своей гранулярности
for(const [r,want] of [['1','1h'],['12','12h'],['24','24h'],['168','7d']]){
  pv.setSeriesRange('1h');
  pv.setRange(r);
  chk(pv.seriesRange===want, `диапазон ${r} → уровень ${want}（${pv.seriesRange})`);
}
// «С момента запуска» — не окно: кривая остаётся суточной и не сжимается до 1 часа
pv.setSeriesRange('1h');
pv.setRange('session');
chk(pv.seriesRange==='24h', `кривая сессионного диапазона всё ещё 24 часа（${pv.seriesRange})`);

console.log('=== Внедрённый CSS: баланс скобок и скруглённые элементы ===');
// render() already injects once, so reset: otherwise these assertions run against
// two concatenated copies and a single replace() no longer removes every match
global.__capturedCss='';
global.__injectCss();
const css=global.__capturedCss||'';
chk(css.length>1500, `таблица стилей внедрена（${css.length} символов)`);
const open=(css.match(/\{/g)||[]).length, close=(css.match(/\}/g)||[]).length;
chk(open===close, `баланс фигурных скобок（{ ${open} / } ${close})`);
chk(!/;\s*;/.test(css), 'нет двойных точек с запятой (пустых объявлений)');
// The phone hero keeps the total on a row of its own: its caption and its figure
// each span both columns, so the figure cannot be squeezed beside the caption by
// авто-столбец сетки. Именно это сжатие заставляло «Итог» стоять далеко слева от
// "354 MiB" on one row looked like at 486px, and the 1.45rem shrink was there to
// work around the same narrow column, so it goes with the fix.
chk(css.includes('grid-template-columns:repeat(2,minmax(0,1fr))') &&
    css.includes('nth-child(1){grid-area:1/1/2/3;}') &&
    css.includes('nth-child(6){grid-area:2/1/3/3;margin-bottom:.5rem;}'),
    'на узком экране итог занимает строку, полоса и PPS идут парами');
chk(!css.includes('.tf-hero-stats::after'), 'больше не используется псевдоэлемент-разделитель, занимающий ячейку сетки');
// The page carries one range control, not two: the chart tier is derived from
// the range, so the only dropdown on the page is the picker in the hero.
for(const sel of ['.tf-page .tf-range','.tf-page .tf-dd-menu','.tf-page .tf-col-app',
                  '.tf-page .tf-stat-strip','.tf-page .tf-stat-metrics','.tf-page .tf-diag',
                  '.tf-page .tf-hero-stats','.tf-page .tf-donut-center',
                  '.tf-page .tf-curve-down','.tf-page .tf-curve-up',
                  '.tf-page .tf-area-down','.tf-page .tf-area-up']){
  const re=new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\{([^}]*)\\}');
  chk(re.test(css), `есть ${sel} правило`);
}
chk(!/\.tf-chart-ctl/.test(css), 'дублирующий элемент уровня на графике удалён');
// The pill shape comes from the .tf-range rule that both dropdowns share, which
// is what makes the chart control read as the same control as the one in the
// hero rather than a second, differently-styled select.
const pill=css.match(/\.tf-page \.tf-range\{([^}]*)\}/);
chk(!!pill && /border-radius:999px/.test(pill[1]), '.tf-range скруглён (пилюля 999px)');
// A presentation attribute cannot read a custom property, so every colour the
// page draws has to come from a rule: the curve kept its light-mode blue on a
// dark page until these four moved out of the SVG attributes.
chk(/--tf-area-down/.test(css) && /--tf-area-up/.test(css), 'у заливки кривой два набора переменных, светлый и тёмный');
const hardDown=(css.match(/#00a8e8/g)||[]).length;
const varDown=(css.match(/--tf-down:#00a8e8;/g)||[]).length;
chk(hardDown===varDown, `жёстко заданный цвет приёма встречается только в определении переменной（всего ${hardDown} раз, из них ${varDown} — определения)`);
const hardUp=(css.match(/#26c281/g)||[]).length;
const varUp=(css.match(/--tf-up:#26c281;/g)||[]).length;
chk(hardUp===varUp, `жёстко заданный цвет отдачи встречается только в определении переменной（всего ${hardUp} раз, из них ${varUp} — определения)`);
// the strip has to reach both edges without leaving a ragged gap, and the boxes
// have to stay the same size
chk(/\.tf-page \.tf-stat-metrics\{[^}]*grid-template-columns:repeat\(4,120px\)[^}]*gap:28px[^}]*text-align:center/.test(css), 'ключевые показатели: фиксированная ширина 120px, отступ 28px, каждый центрирован');
chk(!/tf-stat-card\.tf-stat-warn\{display:block/.test(css),'на телефоне предупреждающая полоса состояния не показывается');
// The page must style its own controls and nothing else: a rule against a LuCI
// core class would restyle the core view action buttons on every other page.
// The buttons here therefore carry app classes (tf-*) rather than core ones.
chk(css.indexOf('.cbi-')===-1, 'таблица стилей не переопределяет селекторы базовых классов LuCI');
chk(!/\.cbi-/.test(css) && !/cbi-button/.test(css), 'не упоминаются базовые классы кнопок');
// keyboard users still need a visible focus ring on the dropdowns that no
// longer inherit one from a core control class
chk(/\.tf-range:focus-visible/.test(css) && /outline:2px solid/.test(css),
    'нарисованный элемент сохраняет кольцо фокуса клавиатуры');
// The same rule as above, enforced over the whole sheet rather than one class:
// every selector has to be anchored on this page own classes (tf-*), including
// the dark-mode ones, so no part of the stylesheet can reach core markup.
const bare=(()=>{
  const body=css.replace(/\/\*[\s\S]*?\*\//g,'');
  const out=[];
  for(const chunk of body.split('}')){
    const i=chunk.lastIndexOf('{');
    if(i<0) continue;
    for(const sel of chunk.slice(0,i).split(',')){
      const s=sel.trim();
      if(s && !/\.tf-/.test(s)) out.push(s);
    }
  }
  return out;
})();
chk(bare.length===0, `все селекторы ограничены tf-*（не ограничено ${bare.length} шт.${bare.length?': '+bare.slice(0,3).join(' / '):''})`);
chk(/appearance:none/.test(css), 'у списка убран нативный вид (чтобы нарисовать скруглённую стрелку)');
chk(/data:image\/svg\+xml/.test(css), 'используется встроенная SVG-стрелка (без лишних запросов)');
const darkRules=(css.match(/\.dark \.tf-page \.tf-range/g)||[]).length;
chk(darkRules>=1, 'стрелка тёмного режима переопределяется отдельно');
chk(!/\.tf-page, \[data-darkmode[^{]*\.tf-range/.test(css), 'селектор потомков тёмного режима не применяется ошибочно только к последнему элементу списка');

console.log('=== Авторитетный итог: при iface — счётчики интерфейса, без iface — откат к атрибуции ===');
// Раньше страница показывала сумму атрибутированных байтов приложений как «Итог». При flow offloading
// netfilter/conntrack обходится, и эта сумма составляет лишь несколько процентов реального объёма (на практике 147 MiB против 2579 MiB),
// причём на странице ничто об этом не говорило. Теперь сборщик кладёт счётчики интерфейса из /proc/net/dev в summary.iface —
// это точный итог сессии независимо от разгрузки; при отсутствии поля нужно откатываться к totals.
const TOT={down:2.0e8,up:5.0e7,router:1e7,client_count:7,exact:10,bucket:5,residual:3};
const IFACE={dev:'eth2',down:3.0e9,up:1.0e9};
const ATTR=TOT.down+TOT.up, CARRIED=IFACE.down+IFACE.up;
const sharePct=(100*ATTR/CARRIED).toFixed(1)+'%';
const sumOf=(o)=>Object.assign({collected_at:1700000000,interval:10,flows:10,dnsmap_lines:10,
  pending:0,acct:1,version:'0.1.90-r1',hour:'2026-09-17T10',totals:TOT,
  clients:[{name:'Mac',ip:'192.168.2.21',bytes:1.5e8}],apps:[]},o||{});

const vIf=mkView({});
const clientReading=v=>(boxes(v.statusEl).find(b=>b.cap==='Browser clients')||{}).val;
const vClientSession=mkView({});
view.renderLive.call(vClientSession,sumOf({totals:Object.assign({},TOT,{client_bytes:4096}),
  clients:[{ip:'192.168.2.1',bytes:1024}]}));
chk(clientReading(vClientSession)==='4.00 KiB','итог клиентов за запуск берёт полный client_bytes, а не сумму категорий или усечённый список топ-клиентов');
const vClientRange=mkView({});
view.renderHourly.call(vClientRange,{hours:[
  {hour:'h0',apps:[{name:'YouTube',down:100,up:0}],clients:[{ip:'192.168.2.1',bytes:1024}]},
  {hour:'h1',apps:[{name:'YouTube',down:200,up:0}],clients:[{ip:'192.168.2.1',bytes:2048},{ip:'192.168.2.2',bytes:1024}]}
]});
chk(clientReading(vClientRange)==='4.00 KiB','итог клиентов за диапазон суммирует байты клиентов диапазона, а не атрибуцию приложений');
const vClientZero=mkView({});
view.renderLive.call(vClientZero,sumOf({totals:Object.assign({},TOT,{client_bytes:0})}));
chk(clientReading(vClientZero)==='0 B','при нулевом трафике клиентов нет отката к трафику приложений');
view.renderLive.call(vIf, sumOf({iface:IFACE,offload:1}));
chk(flat(vIf.totalEl)==='3.73 GiB', `итог берётся из счётчиков интерфейса, а не из атрибуции（${flat(vIf.totalEl)})`);
chk(flat(vIf.grandRow.cells.down)==='2.79 GiB' && flat(vIf.grandRow.cells.up)==='954 MiB',
    `итоговая строка приёма/отдачи тоже из счётчиков интерфейса（${flat(vIf.grandRow.cells.down)} / ${flat(vIf.grandRow.cells.up)})`);
chk(flat(vIf.heroCapEl)==='total', `заголовок «Всего» только когда итог действительно из интерфейса（${flat(vIf.heroCapEl)})`);
// Показание кольца теперь имеет тот же источник, что и его сектора — это итог, кольцо рисует состав всего окна, поэтому центр
// должен быть тем числом, которое делится, а не суммой сегментов; заголовок следует за источником итога и совпадает с hero.
// render() создаёт два узла центра кольца, draw() их заполняет, поэтому здесь нужно выполнить оба: заголовок берётся из реально
// созданных узлов, а не из тестовой заглушки.
const vIfPage=mkView({});
view.render.call(vIfPage,{});
view.renderLive.call(vIfPage, sumOf({iface:IFACE,offload:1}));
const dcap=[]; walk(vIfPage.donutEl,n=>{ if((n.attrs||{}).class==='tf-donut-cap') dcap.push(n); });
chk(flat(vIfPage.donutTotalEl)===flat(vIfPage.totalEl) && flat(vIfPage.donutTotalEl)==='3.73 GiB' &&
    dcap.length===1 && flat(dcap[0])==='total',
    `центр кольца — итог, то же число и слово, что в hero（${flat(vIfPage.donutTotalEl)} / ${flat(dcap[0])})`);
// Заголовок списка справа от кольца не может использовать «Приложение» из шапки таблицы и больше не является «Распознанным трафиком»:
// в кольце теперь есть сегмент нераспознанного, и этот список описывает состав всего кольца.
const pageIf=view.render.call(Object.assign(Object.create(view),freshView()),{});
const lcap=[]; walk(pageIf,n=>{ if((n.attrs||{}).class==='tf-legend-cap') lcap.push(n); });
chk(lcap.length===1 && flat(lcap[0])==='Traffic breakdown',
    `заголовок списка кольца — «Состав трафика», а не «Распознанный трафик» или «Приложение»（${flat(lcap[0])})`);
// «Распознано X%»: доля трафика текущего запуска, которую уровень атрибуции смог назвать, от реально перенесённого объёма.
chk(txt(vIf.diagEl).indexOf('Attributed')>=0 && txt(vIf.diagEl).indexOf(sharePct)>=0,
    `строка диагностики показывает долю распознанного ${sharePct}（${txt(vIf.diagEl).trim()})`);
const aRow=(vIf.diagRows||[]).filter(r=>r.k&&r.k._text==='Attributed')[0];
chk(aRow && /tf-warn/.test(aRow.v.className), 'при низкой доле строка предупреждающего цвета (не тихо)');
// Предупреждение о разгрузке удалено целиком: оно выставляло внутреннее состояние сборщика (offload) туда, где читатель смотрит цифры,
// а вопрос «итог из счётчиков интерфейса или из атрибуции» теперь решает сам заголовок (Всего / Распознано), и отдельная
// фраза-предупреждение больше не нужна. Поэтому в сессионном и диапазонном видах, при offload=1 и offload=0, в диагностике
// не должно появляться этого текста. Проверка обратная: утверждаем, что его нет, а не удаляем проверку — иначе его возвращение
// останется незамеченным.
const OFFLOAD_WORDS=['flow offloading is on','Counter mode','Counting mode','режим подсчёта'];
const offloadWords=t=>OFFLOAD_WORDS.filter(w=>t.indexOf(w)>=0);
// Предпосылка непустоты: при одном и том же снимке диагностика действительно что-то рисует, иначе «нет предупреждения» — истина на пустом множестве.
chk(txt(vIf.diagEl).indexOf('Attributed')>=0,
    `диагностика сессионного вида непуста, поэтому «нет предупреждения» ниже — не пустое множество（${txt(vIf.diagEl).trim()})`);
chk(offloadWords(txt(vIf.diagEl)).length===0,
    `при offload=1 в сессионном виде нет текста о разгрузке（${txt(vIf.diagEl).trim()})`);
const vIf0=mkView({});
view.renderLive.call(vIf0, sumOf({iface:IFACE,offload:0}));
chk(offloadWords(txt(vIf0.diagEl)).length===0,
    `при offload=0 тоже нет (ни одно из значений не появляется: ${txt(vIf0.diagEl).trim()})`);

const vNo=mkView({});
view.renderLive.call(vNo, sumOf({}));
chk(flat(vNo.totalEl)==='238 MiB' && flat(vNo.grandRow.cells.total)==='238 MiB',
    `без iface откат к totals（${flat(vNo.totalEl)})`);
// Граница: iface существует, но все счётчики равны 0 (только что загрузились/сбросили), а также мусорные значения в iface не должны превращаться в NaN.
const vZero=mkView({});
view.renderLive.call(vZero, sumOf({iface:{dev:'eth2',down:0,up:0}}));
chk(flat(vZero.totalEl)==='0 B' && flat(vZero.totalEl).indexOf('NaN')===-1,
    `при нулевых счётчиках 0 B, а не NaN（${flat(vZero.totalEl)})`);
chk(txt(vZero.diagEl).indexOf('Attributed')===-1, 'при нулевом объёме доля не делится на ноль');
const vJunk=mkView({});
view.renderLive.call(vJunk, sumOf({iface:{dev:'eth2',down:'x',up:null}}));
chk(flat(vJunk.totalEl)==='238 MiB' && flat(vJunk.totalEl).indexOf('NaN')===-1,
    `при недопустимом iface откат к totals（${flat(vJunk.totalEl)})`);
chk(flat(vNo.heroCapEl)==='Attributed' && flat(vNo.grandRow.label)==='Attributed',
    `атрибуция больше не называет себя «Всего»（${flat(vNo.heroCapEl)} / ${flat(vNo.grandRow.label)})`);
chk(txt(vNo.diagEl).indexOf('Attributed')===-1 && flat(vNo.donutTotalEl)==='238 MiB',
    'без iface доля распознанного не выдумывается, показание кольца не меняется');

console.log('=== Кольцо представляет итог: один сегмент нераспознанного, на карточке один знаменатель ===');
// Два разных знаменателя на одной карточке — именно та проблема, которую исправляем: кольцо когда-то показывало 100% = 2.78 GiB распознанного, а
// строка над ним — 7.32 GiB, поэтому SSL/TLS на одной карточке был одновременно 46.1% и 17.5%, и на странице
// ничто не объясняло, чей это 100%. Теперь каждый сегмент кольца делится на итог, нераспознанное занимает остаток,
// кольцо остаётся полным кругом, а легенда и таблица используют один и тот же знаменатель.
// 12 приложений (два сверх топ-10) плюс счётчик интерфейса, намного больший атрибуции, покрывают сразу три вида сегментов:
// топ-10, остальные приложения, нераспознанное.
const BIGAPPS=Array.from({length:12},(_,i)=>({name:'App'+String(i+1).padStart(2,'0'),
  down:(12-i)*8e7, up:(12-i)*2e7, clients:i, top:'', top_bytes:0}));
const BIGDOWN=BIGAPPS.reduce((s,a)=>s+a.down,0);
const BIGUP=BIGAPPS.reduce((s,a)=>s+a.up,0);
const BIGATTR=BIGDOWN+BIGUP;                       // 7.8e9
const BIGIFACE={dev:'eth2',down:10e9,up:4e9};
const BIGTOTAL=BIGIFACE.down+BIGIFACE.up;          // 1.4e10
const BIGUNATTR=BIGTOTAL-BIGATTR;                  // 6.2e9 → 44.3%
const DONUT_C=2*Math.PI*74;                        // в makeDonut r=(168-20)/2
// Каждый сегмент — circle: длина dasharray — нарисованная дуга, dashoffset — расстояние от начала сегмента до нуля окружности.
// Каждый сегмент сокращён на 2px для разделителя, поэтому (len + 2) / C — его реальная доля окружности; а конец последнего
// сегмента должен отстоять от начала ровно на эти 2px — это измеримая форма утверждения «кольцо замкнуто» в данном изменении.
const slices=v=>{ const out=[]; walk(v.donutEl,n=>{ if(n.tag==='circle'&&(n.attrs||{}).stroke){
  const a=String(n.attrs['stroke-dasharray']).split(' ');
  out.push({ stroke:String(n.attrs.stroke), len:parseFloat(a[0]),
    off:Math.max(-(parseFloat(n.attrs['stroke-dashoffset'])||0),0) }); } }); return out; };
const fracOf=s=>(s.len+2)/DONUT_C;
const ringEnd=bs=>bs.length?bs[bs.length-1].off+bs[bs.length-1].len:0;
const closed=bs=>bs.length>0 && Math.abs(ringEnd(bs)-(DONUT_C-2))<1;
const PALCOL=((src.match(/var PALETTE = \[([\s\S]*?)\];/)||[])[1]||'').match(/#[0-9a-f]{6}/g)||[];
const GREY='#9aa5b1';
const greyOf=bs=>bs.filter(s=>s.stroke.toLowerCase()===GREY);
const rowByText=(v,name)=>(v.rowsEl.children||[]).filter(tr=>tr.tag==='tr' &&
  flat((tr.children||[])[0]||{}).indexOf(name)>=0)[0]||null;
const legendRows=v=>{ const out=[]; (v.legendEl.children||[]).forEach(r=>{
  const kids=r.children||[];
  const nm=kids.filter(c=>(c.attrs||{}).class==='tf-legend-name')[0];
  const pc=kids.filter(c=>(c.attrs||{}).class==='tf-legend-pct')[0];
  const dt=kids.filter(c=>(c.attrs||{}).class==='tf-legend-dot')[0];
  out.push({ name:nm?flat(nm):'', pct:pc?flat(pc):'', dot:((dt||{}).attrs||{}).style||'' });
}); return out; };

const vBig=mkView({});
view.render.call(vBig,{});        // узлы центра кольца и легенды создаёт render(), заполняет draw()
view.renderLive.call(vBig, sumOf({apps:BIGAPPS, iface:BIGIFACE, offload:1,
  totals:{down:BIGDOWN,up:BIGUP,router:0,client_count:1,exact:1,bucket:1,residual:0}}));
const bs=slices(vBig), bg=greyOf(bs);
// По старой схеме здесь было только 11 сегментов (топ-10 + остальные приложения), а 100% кольца равнялись 7.8e9, а не 1.4e10
chk(bs.length===12 && bg.length===1 && PALCOL.indexOf(GREY)===-1 &&
    Math.abs(fracOf(bg[0])-BIGUNATTR/BIGTOTAL)<0.002 && closed(bs),
    `кольцо = топ-10 + остальные приложения + нераспознанное, всего 12 сегментов; нераспознанное — единственный нейтрально-серый сегмент и занимает ${(100*BIGUNATTR/BIGTOTAL).toFixed(1)}%; сегменты замыкаются в полный круг (сегментов ${bs.length}, серых ${bg.length}${bg.length?'='+(100*fracOf(bg[0])).toFixed(1)+'%':''}, конец от начала ${bs.length?(DONUT_C-ringEnd(bs)).toFixed(1):'—'}px)`);
// Дуга самого большого сегмента считается от итога: по старой схеме это 15.4% (от 7.8e9), а не 8.6%
chk(bs.length>0 && Math.abs(fracOf(bs[0])-(BIGAPPS[0].down+BIGAPPS[0].up)/BIGTOTAL)<0.002,
    `длина дуги первого сегмента = байты приложения / итог（${bs.length?(100*fracOf(bs[0])).toFixed(1):'—'}% , должно быть 8,6%)`);
const bigCaps=[]; walk(vBig.donutEl,n=>{ if((n.attrs||{}).class==='tf-donut-cap') bigCaps.push(n); });
chk(flat(vBig.donutTotalEl)==='13.0 GiB' && flat(vBig.totalEl)==='13.0 GiB' &&
    bigCaps.length===1 && flat(bigCaps[0])==='total',
    `центр кольца — тот же итог, что в hero, то же число и слово（${flat(vBig.donutTotalEl)} / ${bigCaps.length?flat(bigCaps[0]):'（нет)'})`);
// таблица: строка нераспознанного, байты = итог − распознано, процент тоже от итога
const uRow=rowByText(vBig,'Unattributed');
chk(!!uRow && flat(uRow.children[1])==='5.77 GiB (44.3%)',
    `в таблице есть строка нераспознанного, байты = итог − распознано（${uRow?flat(uRow.children[1]):'(нет этой строки)'})`);
// Она идёт сразу после строки «Весь трафик»: остаток итоговой строки должен быть рядом с ней, а не в конце таблицы через 300 строк
const btrs=(vBig.rowsEl.children||[]).filter(c=>c.tag==='tr');
chk(btrs.length>1 && /tf-grand/.test((btrs[0].attrs||{}).class||'') &&
    /tf-unattr/.test((btrs[1].attrs||{}).class||''),
    `строка нераспознанного сразу после всего трафика (строка 1 ${btrs[0]&&(btrs[0].attrs||{}).class} / строка 2 ${btrs[1]&&(btrs[1].attrs||{}).class})`);
const a1Row=rowByText(vBig,'App01');
chk(!!a1Row && flat(a1Row.children[1])==='1.12 GiB (8.6%)',
    `процент строки приложения тоже считается от итога（${a1Row?flat(a1Row.children[1]):'(нет этой строки)'} , по старой схеме было 15,4%)`);
// легенда: все 12 сегментов (включая остальные приложения и нераспознанное), поэтому сумма процентов 100%
const lg=legendRows(vBig);
const lsum=lg.reduce((s,r)=>s+parseFloat(r.pct),0);
chk(lg.length===12 && Math.abs(lsum-100)<0.15,
    `легенда перечисляет все 12 сегментов, сумма процентов ${lsum.toFixed(1)}% (старая схема перечисляла только топ-10, сумма не доходила до 100%)`);
const lgU=lg.filter(r=>r.name==='Unattributed')[0];
chk(!!lgU && lgU.pct==='44.3%' && lgU.dot.indexOf(GREY)>=0,
    `строка нераспознанного в легенде использует тот же серый и тот же знаменатель（${lgU?lgU.name+' '+lgU.pct+' / '+lgU.dot:'(нет этой строки)'})`);

console.log('=== Вид диапазона: нераспознанное появляется только при наличии строк устройства в архиве ===');
// Основа вида диапазона может быть собственными счётчиками устройств этого диапазона (архив хранит строку wan за каждый час). В этом случае кольцу
// тоже нужен сегмент нераспознанного; а если в архиве нет строк устройства, итог равен атрибуции, нераспознанное = 0, и кольцо должно полностью
// совпадать со старой схемой — ни лишнего сегмента 0%, ни недостающего.
const RH2=iface=>[{hour:'h0',apps:[{name:'YouTube',down:36000,up:18000},
  {name:'QUIC',down:1000,up:500}],clients:[],router:0,iface:iface}];
const RDOWN=3e6, RUP=1e6, RTOTAL=RDOWN+RUP, RATTR=36000+18000+1000+500;
const vRIf=mkView({});
view.renderHourly.call(vRIf,{hours:RH2({dev:'wan',down:RDOWN,up:RUP})});
const rs=slices(vRIf), rg=greyOf(rs);
chk(rs.length===3 && rg.length===1 &&
    Math.abs(fracOf(rg[0])-(RTOTAL-RATTR)/RTOTAL)<0.002 && closed(rs),
    `кольцо вида диапазона тоже основано на счётчиках устройства этого диапазона, нераспознанное занимает ${(100*(RTOTAL-RATTR)/RTOTAL).toFixed(1)}%; сегменты замыкаются в полный круг (сегментов ${rs.length}, серых ${rg.length}, конец от начала ${rs.length?(DONUT_C-ringEnd(rs)).toFixed(1):'—'}px)`);
const vRNo=mkView({});
view.renderHourly.call(vRNo,{hours:RH2(undefined)});
const ns=slices(vRNo);
chk(ns.length===2 && greyOf(ns).length===0 && closed(ns) &&
    flat(vRNo.donutTotalEl)==='54.2 KiB' && flat(vRNo.totalEl)==='54.2 KiB',
    `без строк устройства в архиве нераспознанное = 0: не рисуется лишний сегмент 0%, кольцо полностью совпадает со старой схемой (сегментов ${ns.length}, серых ${greyOf(ns).length}, конец от начала ${ns.length?(DONUT_C-ringEnd(ns)).toFixed(1):'—'}px, центр кольца ${flat(vRNo.donutTotalEl)})`);

console.log('=== Мгновенная скорость: статистический итог не участвует в мгновенной скорости WAN ===');
const rMix=mkView({});
view.renderRealtime.call(rMix,wanSample);
view.renderLive.call(rMix,sumOf({iface:{dev:'eth2',down:1e9,up:1e8},totals:{down:1e12,up:1e11}}));
chk(flat(rMix.rateDown)==='1000.0 Mbps' && flat(rMix.rateUp)==='200.00 Mbps','рост атрибутированного итога не мешает мгновенной скорости интерфейса');

console.log('=== Протокольные корзины в одной таблице с приложениями (больше не отдельным блоком) ===');
// SSL/TLS, QUIC, HTTP, DNS, STUN — эти «имена приложений» на самом деле резервные метки атрибуции, занимающие
// около трети атрибутированного трафика. Когда-то их вынесли из таблицы в отдельный блок «протоколы (не приложения)»,
// но этот вариант отвергли: на роутере с разгрузкой значительная часть трафика приходится на SSL/TLS / QUIC /
// Other, и после изъятия сумма таблицы оказывалась намного меньше итога над ней, а читатель ждал «один список,
// отсортированный по байтам». Протокольные корзины остаются строками основной таблицы; ниже проверяются таблица, кольцо и счётчики,
// а не удалённый пустой блок протоколов.
const PICKS=[{name:'YouTube',down:1e6,up:1e5,clients:3,top:'192.168.2.5',top_bytes:5e5},
             {name:'QUIC',down:6e5,up:1e4,proto:1},
             {name:'DNS',down:2e5,up:1e4,proto:1}];
const inRows=(v,n)=>!!(v.rowCache||{})[n];
const rowCls=(v,n)=>((v.rowCache||{})[n]||{tr:{attrs:{}}}).tr.attrs.class||'';
const vP=mkView({});
view.renderLive.call(vP, sumOf({apps:PICKS,
  totals:Object.assign({},TOT,{down:1.8e6,up:1.2e5}),
  clients:[{name:'Mac',ip:'192.168.2.21',bytes:1e6}]}));
chk(inRows(vP,'QUIC') && inRows(vP,'DNS') && inRows(vP,'YouTube'),
    `протокольные корзины в одной таблице с приложениями（в таблице: ${Object.keys(vP.rowCache||{}).join('|')})`);
// Имя — голая строка в span, txt() собирает только _text, поэтому для table нужно использовать flat()
const tableRows=(vP.rowsEl.children||[]).filter(c=>c.tag==='tr' &&
  !/tf-grand/.test((c.attrs||{}).class||'') && !/tf-unattr/.test((c.attrs||{}).class||''));
chk(Object.keys(vP.rowCache||{}).length===PICKS.length && tableRows.length===PICKS.length,
    `в таблице действительно по одной строке, ничего не убрано（rowCache ${Object.keys(vP.rowCache||{}).length}，<tr> ${tableRows.length}/${PICKS.length})`);
chk(flat(vP.rowsEl).indexOf('QUIC')>=0 && flat(vP.rowsEl).indexOf('DNS')>=0,
    `в тексте таблицы приложений видны протокольные корзины（${flat(vP.rowsEl).trim().slice(-64)})`);
// «Это корзина» и «это не приложение» теперь разные вещи: строки протокольных корзин в таблице по-прежнему имеют метку корзины (курсивное имя и глиф
// зависят от неё), но она больше не является строкой отдельного блока
chk(/tf-isbucket/.test(rowCls(vP,'QUIC')) && !/tf-isbucket/.test(rowCls(vP,'YouTube')),
    `строки протокольных корзин имеют метку корзины, реальные приложения — нет (QUIC=${rowCls(vP,'QUIC')} / YouTube=${rowCls(vP,'YouTube')||'(пусто)'})`);
chk((boxes(vP.statusEl).filter(b=>b.cap==='Apps and sites')[0]||{}).val==='1',
    `ячейка «Приложения и сайты» считает только приложения и сайты（${(boxes(vP.statusEl).filter(b=>b.cap==='Apps and sites')[0]||{}).val})`);
// список кольца — состав «распознанного трафика», протокольные корзины используют те же метки, что основная таблица。
const legProto=(vP.legendCache||{})['QUIC'];
chk(!!legProto && /tf-isbucket/.test((legProto.row.attrs||{}).class||''),
    `в списке кольца у протокольной корзины есть метка корзины（${legProto&&legProto.row.attrs.class})`);
chk(!!vP.legendCache['YouTube'] && !/tf-isbucket/.test((vP.legendCache['YouTube'].row.attrs||{}).class||''),
    'в списке кольца реальные приложения тоже без метки корзины');
// Строки часов архива содержат только имя, без метки proto: вид диапазона идёт тем же путём, QUIC по-прежнему попадает в таблицу приложений
const vPH=mkView({});
view.renderHourly.call(vPH,{hours:[{hour:'h0',apps:[{name:'YouTube',down:36000,up:18000},
  {name:'QUIC',down:1000,up:500}],clients:[],router:0}]});
chk(inRows(vPH,'QUIC') && inRows(vPH,'YouTube'),
    `вид диапазона тоже включает протокольные корзины в таблицу приложений（в таблице: ${Object.keys(vPH.rowCache||{}).join('|')})`);

console.log('=== Популярные клиенты: абсурдные проценты между окнами больше не печатаются ===');
// apptop в архиве хранит накопленные за сессию байты клиента, а байты часа в той же строке — только за этот час;
// деление одного на другое и было источником «долей» вроде 114.7%/2458%.
const vT=mkView({});
view.draw.call(vT,[{name:'YouTube',down:1e6,up:0,bytes:1e6,clients:2,top:'192.168.2.9',top_bytes:5e8}],
  {total:1e6,down:1e6,up:0,topText:'—',clientCount:2});
chk(/%/.test(flat(vT.rowCache['YouTube'].cells.top))===false &&
    flat(vT.rowCache['YouTube'].cells.top).indexOf('192.168.2.9')>=0,
    `если байты клиента больше байтов строки, пропорция не выводится（${flat(vT.rowCache['YouTube'].cells.top)})`);
const vT2=mkView({});
view.draw.call(vT2,[{name:'YouTube',down:1e6,up:0,bytes:1e6,clients:2,top:'192.168.2.9',top_bytes:5e5}],
  {total:1e6,down:1e6,up:0,topText:'—',clientCount:2});
chk(/\(50\.0%\)/.test(flat(vT2.rowCache['YouTube'].cells.top)),
    `пропорция в одном окне выводится как обычно（${flat(vT2.rowCache['YouTube'].cells.top)})`);
const vG=mkView({});
view.renderLive.call(vG, sumOf({clients:[{name:'Mac',ip:'192.168.2.21',bytes:4e8}]}));
chk(/%/.test(flat(vG.grandRow.cells.top))===false && flat(vG.grandRow.cells.top).indexOf('Mac')>=0,
    `если доля клиента в итоговой строке больше 100%, она тоже не печатается（${flat(vG.grandRow.cells.top)})`);
const vG2=mkView({});
view.renderLive.call(vG2, sumOf({totals:Object.assign({},TOT,{client_bytes:2.5e8}),
  clients:[{name:'Mac',ip:'192.168.2.21',bytes:1.5e8}]}));
chk(/\(60\.0%\)/.test(flat(vG2.grandRow.cells.top)),
    `итоговая строка считает долю от итога клиентов того же источника（${flat(vG2.grandRow.cells.top)})`);
const vG3=mkView({});
view.renderLive.call(vG3,sumOf({clients:[{name:'Mac',ip:'192.168.2.21',bytes:1.5e8}]}));
chk(!/%/.test(flat(vG3.grandRow.cells.top)),
  'пока нет итога клиентов, атрибуция приложений не используется как знаменатель');
// Популярный клиент итоговой строки принадлежит окну самой строки, и ячейка сама указывает, какому именно
chk(String((vG2.grandRow.cells.top.attrs||{}).title||'').indexOf('current run')>=0,
    `клиент в итоговой строке сессионного вида помечен как текущий запуск（${(vG2.grandRow.cells.top.attrs||{}).title})`);

console.log('=== Граница сессия/диапазон: вид диапазона никогда не заимствует iface сессии ===');
// iface — накопленное за сессию из /proc/net/dev, часы архива приходят из уровня атрибуции (roll_hour хранит
// totals.tsv), поэтому у вида диапазона нет соответствующего итога интерфейса. Поместить итог сессии под метку 7 дней было бы
// новой выдуманной цифрой — именно такой проблемой мы и занимаемся.
const RSU=sumOf({iface:IFACE,offload:1});
const vR=mkView({summary:RSU});
view.renderHourly.call(vR,{hours:[{hour:'h0',apps:[{name:'YouTube',down:36000,up:18000},
  {name:'QUIC',down:1000,up:500}],clients:[{ip:'192.168.2.5',bytes:50000}],router:0}]});
view.drawStatus.call(vR, RSU, vR.lastItems||[]);
chk(flat(vR.totalEl)==='54.2 KiB' && flat(vR.totalEl)!=='3.73 GiB',
    `вид диапазона использует атрибутированные байты своего диапазона（${flat(vR.totalEl)})`);
chk(flat(vR.heroCapEl)==='Attributed' && flat(vR.grandRow.label)==='Attributed',
    `итог вида диапазона помечен как распознанный（${flat(vR.heroCapEl)} / ${flat(vR.grandRow.label)})`);
chk(txt(vR.diagEl).indexOf('Attributed')===-1,
    `вид диапазона не показывает сессионную долю распознанного（${txt(vR.diagEl).trim()})`);
chk(offloadWords(txt(vR.diagEl)).length===0,
    `в виде диапазона тоже нет текста о разгрузке（${txt(vR.diagEl).trim()||'(диагностика пуста)'})`);
// Диагностика снимка vR изначально пуста, «нет предупреждения» на пустом множестве истинно, поэтому создаём снимок с непустой
// диагностикой: pending>0 выведет «ожидание разрешения», а текст о разгрузке всё равно не появится. Заодно подтверждаем, что в виде диапазона
// протокольные корзины тоже идут через таблицу приложений (выше vPH проверял только таблицу, здесь — полный цикл отрисовки)
const RSU2=sumOf({iface:IFACE,offload:1,pending:5});
const vR2=mkView({summary:RSU2});
view.renderHourly.call(vR2,{hours:[{hour:'h0',apps:[{name:'YouTube',down:36000,up:18000},
  {name:'QUIC',down:1000,up:500}],clients:[{ip:'192.168.2.5',bytes:50000}],router:0}]});
view.drawStatus.call(vR2, RSU2, vR2.lastItems||[]);
chk(txt(vR2.diagEl).indexOf('Waiting to resolve')>=0,
    `диагностика вида диапазона действительно непуста, поэтому «нет предупреждения» ниже — не пустое множество（${txt(vR2.diagEl).trim()})`);
chk(offloadWords(txt(vR2.diagEl)).length===0,
    `при непустой диагностике вида диапазона текста о разгрузке тоже нет（${txt(vR2.diagEl).trim()})`);
chk(inRows(vR2,'QUIC'),
    `после полного цикла отрисовки вида диапазона протокольные корзины всё ещё в таблице приложений（в таблице: ${Object.keys(vR2.rowCache||{}).join('|')})`);
chk(String((vR.grandRow.cells.top.attrs||{}).title||'').indexOf('selected range')>=0,
    `клиент в итоговой строке вида диапазона помечен выбранным диапазоном（${(vR.grandRow.cells.top.attrs||{}).title})`);

console.log('=== Тексты: у всех _() на странице есть китайские записи ===');
console.log('=== Объединение сайтов и показ малого трафика ===');
const vSites=mkView({});
view.draw.call(vSites,[{name:'Samsung',down:3000,up:0,bytes:3000}],
  {total:3000,down:3000,up:0,topText:'—',clientCount:1});
chk(!vSites.rowCache.Samsung.toggle, 'если сначала есть только брендовая строка, элемент раскрытия не показывается');
view.draw.call(vSites,[
  {name:'samsungcloudcn.com',down:1000,up:0,bytes:1000},
  {name:'samsung.com.cn',down:2000,up:0,bytes:2000},
  {name:'Samsung',down:3000,up:0,bytes:3000},
  {name:'WangSuKeJi',down:1000,up:0,bytes:1000}
],{total:1e8,down:1e8,up:0,shareTotal:7000,topText:'—',clientCount:1});
chk(!!vSites.rowCache.Samsung && flat(vSites.rowCache.Samsung.cells.total).indexOf('5.86 KiB')>=0,
  'проверенные домены Samsung объединены в Samsung, итог трафика верен');
chk(!!vSites.rowCache.Samsung && /<0\.1%/.test(flat(vSites.rowCache.Samsung.cells.total)),
  'ненулевая малая доля показывается как <0.1%');
chk(!!vSites.rowCache.Samsung && !!vSites.rowCache.Samsung.toggle,
  'объединённая строка предоставляет элемент раскрытия доменов');
const groupCell=vSites.rowCache.Samsung.tr.children[0];
chk(groupCell.children[0].attrs.class==='tf-icon' &&
    groupCell.children[1].attrs.class==='tf-app-name' &&
    groupCell.children[2]===vSites.rowCache.Samsung.toggle,
  'объединённая строка расположена как иконка, имя, кнопка раскрытия');
if(vSites.rowCache.Samsung && vSites.rowCache.Samsung.toggle &&
   vSites.rowCache.Samsung.toggle._listeners.click)
  vSites.rowCache.Samsung.toggle._listeners.click();
chk(!!vSites.rowCache['domain:Samsung:samsungcloudcn.com'] &&
    !!vSites.rowCache['domain:Samsung:samsung.com.cn'],
  'после раскрытия видны исходные домены');
chk(!!vSites.rowCache.WangSuKeJi && !vSites.rowCache.WangSuKeJi.children,
  'общий CDN не объединяется с Samsung');
const vOtherSites=mkView({});
view.draw.call(vOtherSites,[
  {name:'producthunt.com',down:800,up:0,bytes:800},
  {name:'brandfetch.io',down:700,up:0,bytes:700},
  {name:'trip.com',down:600,up:0,bytes:600},
  {name:'qrstuuvwxyzab.com',down:500,up:0,bytes:500}
],{total:2600,down:2600,up:0,topText:'—',clientCount:1});
chk(!!vOtherSites.rowCache['Product Hunt'] && !!vOtherSites.rowCache.Brandfetch &&
    !!vOtherSites.rowCache['Trip.com'],
  'другие проверенные брендовые домены тоже показывают бренд');
chk(!!vOtherSites.rowCache['qrstuuvwxyzab.com'],
  'домены с неизвестной принадлежностью сохраняют исходное имя');
const vBucketCount=mkView({});
view.renderLive.call(vBucketCount,sumOf({apps:[{name:'YouTube',down:1000,up:0},
  {name:'QUIC',down:1000,up:0,proto:1}]}));
chk((boxes(vBucketCount.statusEl).filter(b=>b.cap==='Apps and sites')[0]||{}).val==='1',
  'число приложений не включает протокольные корзины');
const rangeCountHead=mk(XHTML,'th');
const vRangeCount=mkView({clientsHead:rangeCountHead});
view.renderHourly.call(vRangeCount,{hours:[
  {hour:'h0',apps:[{name:'YouTube',down:100,up:0,clients:2}],clients:[]},
  {hour:'h1',apps:[{name:'YouTube',down:100,up:0,clients:3}],clients:[]}
]});
chk(flat(vRangeCount.rowCache.YouTube.cells.clients)==='3' &&
    flat(rangeCountHead)==='Peak clients/hour',
  'число клиентов приложения за диапазон явно помечено как пик за один час, а не уникальные за все часы');
const sessionCountHead=mk(XHTML,'th');
const vSessionCount=mkView({clientsHead:sessionCountHead});
view.draw.call(vSessionCount,[{name:'YouTube',down:100,up:0,bytes:100,clients:2}],
  {total:100,down:100,up:0,topScope:'session'});
chk(flat(sessionCountHead)==='Client count',
  'текущий запуск по-прежнему показывает число клиентов в сессии');
const vSmallTop=mkView({});
view.draw.call(vSmallTop,[{name:'YouTube',down:1000,up:0,bytes:1000,
  top:'192.168.2.9',top_bytes:500}],{total:1000,down:1000,up:0,
  topText:'—',clientCount:1,topScope:'range'});
chk(!/%/.test(flat(vSmallTop.rowCache.YouTube.cells.top)),
  'показание клиентов архива не считает долю строки между разными окнами');
chk(flat(vSmallTop.rowCache.YouTube.cells.top).trim()==='192.168.2.9',
  'строка приложения архива показывает только личность клиента, без байтов другого окна');
// Новый текст должен одновременно попасть в каталоги, иначе в китайском интерфейсе появится английский msgid
function loadCatalog(file){
  const map={}; const unesc=s=>s.replace(/\\n/g,'\n').replace(/\\"/g,'"').replace(/\\\\/g,'\\');
  const unq=s=>{ const m=/^\s*"([\s\S]*)"\s*$/.exec(s); return m?m[1]:''; };
  let id=null,str=null,mode=null;
  const put=()=>{ if(id&&str) map[unesc(id)]=unesc(str); id=null; str=null; mode=null; };
  for(const raw of fs.readFileSync(file,'utf8').split(/\r?\n/)){
    const line=raw.trim();
    if(!line||line[0]==='#') continue;
    if(line.startsWith('msgid ')){ put(); id=unq(line.slice(6)); mode='id'; }
    else if(line.startsWith('msgstr ')){ str=unq(line.slice(7)); mode='str'; }
    else if(line[0]==='"'){ if(mode==='id') id+=unq(line); else if(mode==='str') str+=unq(line); }
  }
  put(); return map;
}
const PO=loadCatalog(path.join(__dirname,'..','po','zh_Hans','traffic.po'));
const ids=new Set();
for(const m of src.matchAll(/_\(\s*'([^']*)'/g)) ids.add(m[1]);
const missing=[...ids].filter(s=>s&&PO[s]===undefined);
chk(ids.size>40, `страница использует ${ids.size} строк _()`);
chk(missing.length===0, `каждая строка _() есть в traffic.po (отсутствует ${missing.length}${missing.length?': '+missing.slice(0,4).join(' | '):''})`);

console.log('=== Если индекс иконок приходит позже, существующие иконки доустанавливаются ===');
let finishIndex;
const pendingIndex=new Promise(resolve=>{finishIndex=resolve;});
global.__iconTest.setPending(pendingIndex);
const iconBox=global.__iconTest.makeIcon('Samsung');
global.__iconTest.setShipped({samsung:1,stripe:1,cdn:1,producthunt:1,'trip-com':1,brandfetch:1,'1password':1,rockstargames:1});
global.__iconTest.setDomains({'1password.com':'1password'});
finishIndex();
pendingIndex.then(()=>{
  chk(imageRequests.some(u=>u.indexOf('samsung.svg')>=0),
    'если индекс приходит после создания строк первого круга, всё равно запрашивается существующая иконка Samsung');
  chk(!!iconBox, 'контейнер иконки всегда существует');
  global.__iconTest.makeIcon('stripe.com');
  global.__iconTest.makeIcon('WangSuKeJi');
  global.__iconTest.makeIcon('producthunt.com');
  global.__iconTest.makeIcon('trip.com');
  global.__iconTest.makeIcon('brandfetch.io');
  global.__iconTest.makeIcon('login.1password.com');
  global.__iconTest.makeIcon('Rockstar');
  return Promise.resolve();
}).then(()=>{
  chk(iconBox.children.some(n=>n.tag==='img'),
    'после прихода индекса иконка действительно добавляется на страницу, а не только задаётся адрес');
  chk(imageObjects.filter(n=>n.src).every(n=>n.parentNode),
    'иконка из пакета не застревает навсегда на буквенной заглушке из-за ленивой загрузки вне страницы');
  chk(imageRequests.some(u=>u.indexOf('stripe.svg')>=0),
    'простой корневой домен неучтённого сервиса может переиспользовать локальную брендовую иконку');
  chk(imageRequests.some(u=>u.indexOf('cdn.svg')>=0),
    'Wangsu использует нейтральный CDN-глиф и не выдаёт себя за бренд сайта');
  chk(['producthunt.svg','trip-com.svg','brandfetch.svg'].every(f=>
    imageRequests.some(u=>u.indexOf(f)>=0)),
    'добавленная брендовая иконка может использоваться соответствующим сайтом');
  chk(imageRequests.some(u=>u.indexOf('1password.svg')>=0),
    'индекс доменов пакета может загрузить проверенную иконку сайта для поддомена');
  chk(imageRequests.some(u=>u.indexOf('rockstargames.svg')>=0),
    'имя издателя в каталоге сопоставляется с добавленной игровой иконкой');
  const unknownIcon=global.__iconTest.makeIcon('qrstuuvwxyzab.com');
  chk(flat(unknownIcon).indexOf('QR')>=0,
    'домен без иконки показывает различимую двухбуквенную метку');
  global.__iconTest.setWebsites({'comfylink.com':'comfylink.com.png?v=100','starrydyn.com':'starrydyn.com.ico?v=100', 'vector.com':'vector.com.svg?v=100'});
  const pngBox=global.__iconTest.makeIcon('comfylink.com');
  const icoBox=global.__iconTest.makeIcon('starrydyn.com');
  const svgBox=global.__iconTest.makeIcon('vector.com');
  global.__iconTest.setWebsites({'example.com':'example.com.png?v=1',
    'api.example.com':'api.example.com.ico?v=2',
    'example.co.uk':'example.co.uk.png','co.uk':'co.uk.png',
    'example.com.cn':'example.com.cn.png','com.cn':'com.cn.png',
    'unknown.xyz':'unknown.xyz.png','github.io':'github.io.png',
    'stripe.com':'stripe.com.png'});
  let requestStart=imageRequests.length;
  global.__iconTest.makeIcon('api.example.com');
  global.__iconTest.makeIcon('v1.api.example.com');
  global.__iconTest.makeIcon('www.example.com');
  global.__iconTest.makeIcon('api.example.co.uk');
  global.__iconTest.makeIcon('api.example.com.cn');
  chk(JSON.stringify(imageRequests.slice(requestStart))===JSON.stringify([
    '/traffic-site-icons/api.example.com.ico?v=2',
    '/traffic-site-icons/api.example.com.ico?v=2',
    '/traffic-site-icons/example.com.png?v=1',
    '/traffic-site-icons/example.co.uk.png',
    '/traffic-site-icons/example.com.cn.png']),
    'кэш сайтов сначала использует точный домен, затем ближайший безопасный родительский');
  requestStart=imageRequests.length;
  ['api.unrelated.co.uk','api.unrelated.com.cn','api.unknown.xyz','tenant.github.io']
    .forEach(name=>global.__iconTest.makeIcon(name));
  chk(imageRequests.length===requestStart,
    'кэш родительского домена не пересекает публичные суффиксы и границы общего хостинга; для неизвестных суффиксов — только точный кэш');
  global.__iconTest.setDomains({'1password.com':'1password','stripe.com':'stripe'});
  global.__iconTest.makeIcon('api.stripe.com');
  chk(imageRequests[imageRequests.length-1].includes('stripe.svg'),
    'кэш родительского домена сайта не перекрывает брендовую иконку из пакета');
  chk(imageRequests.includes('/traffic-site-icons/comfylink.com.png?v=100') &&
      imageRequests.includes('/traffic-site-icons/starrydyn.com.ico?v=100') &&
      imageRequests.includes('/traffic-site-icons/vector.com.svg?v=100'),
    'кэш сайтов PNG / ICO / SVG читается с роутера из того же источника с версией обновления');
  return Promise.resolve().then(async ()=>{
    chk([pngBox,icoBox,svgBox].every(box=>box.children.some(n=>n.tag==='img')),
      'после загрузки PNG / ICO / SVG сайта буквенная заглушка действительно заменяется');
    const originalFetch=global.fetch;
    global.fetch=async()=>({ok:true,text:async()=>Array.from({length:300},(_,i)=>
      `site${i}.com\tsite${i}.com.png\t100`).join('\n')});
    const fullIndex=await global.__iconTest.loadWebsites();
    chk(Object.keys(fullIndex).length===300 && fullIndex['site299.com'],
      'страница читает весь индекс кэша, не обрезая после 256 сайтов');
    global.__iconTest.setWebsites({});
    const refreshedBox=global.__iconTest.makeIcon('api.example.com');
    refreshedBox.getAttribute=key=>refreshedBox.attrs[key];
    let replacement=null;
    refreshedBox.parentNode={replaceChild(next,old){
      if(old===refreshedBox) replacement=next;
    }};
    documentStub.querySelectorAll=()=>[refreshedBox];
    global.fetch=async()=>({ok:true,text:async()=>
      'example.com\texample.com.png\t3'});
    await global.__iconTest.refreshWebsites();
    chk(replacement && imageRequests[imageRequests.length-1]===
      '/traffic-site-icons/example.com.png?v=3',
      'после прихода индекса кэша родительского домена уже показанные строки поддоменов автоматически заменяют иконку');
    delete documentStub.querySelectorAll;
    global.fetch=originalFetch;
    console.log(fail?`\n  ${fail} элементов с ошибкой`:'\n  все проверки рендеринга страницы пройдены');
    process.exit(fail?1:0);
  });
});
