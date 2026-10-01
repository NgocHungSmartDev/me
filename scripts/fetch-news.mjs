import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'data','news.json');
const now=new Date().toISOString();
let previous=null;
try{previous=JSON.parse(await readFile(output,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}

const oldArticles=(previous?.articles||[]).map(item=>({...item,source:item.source||'kongehuset'}));
const previousByUrl=new Map(oldArticles.map(item=>[item.url,item]));
const sourceDefinitions={
  kongehuset:{name:'Kongehuset',url:'https://www.kongehuset.dk/nyhedsarkiv/',country:'denmark',language:'da'},
  tv2:{name:'TV 2 Nyheder',url:'https://nyheder.tv2.dk/',country:'denmark',language:'da'},
  kungahuset:{name:'Kungahuset',url:'https://www.kungahuset.se/nyheter',country:'sweden',language:'sv'},
  svenskdam:{name:'Svensk Damtidning',url:'https://www.svenskdam.se/',country:'sweden',language:'sv'},
  kongehusetNo:{name:'Det Norske Kongehus',url:'https://www.kongehuset.no/nyheter',country:'norway',language:'no'}
};

const decodeHtml=value=>String(value||'')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
  .replace(/<[^>]+>/g,' ')
  .replace(/&nbsp;|&#160;/gi,' ')
  .replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
  .replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
  .replace(/&#(\d+);/g,(_,code)=>String.fromCodePoint(Number(code)))
  .replace(/&#x([\da-f]+);/gi,(_,code)=>String.fromCodePoint(parseInt(code,16)))
  .replace(/\s+/g,' ').trim();

async function fetchKongehuset(){
  const endpoint=process.env.KONGEHUSET_SOURCE_URL||'https://www.kongehuset.dk/umbraco/api/NewsArchiveApi/Initialize?culture=da';
  const response=await fetch(endpoint,{headers:{'user-agent':'Denmark-News-Monitor/1.0'}});
  if(!response.ok)throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const items=await response.json();
  if(!Array.isArray(items)||!items.length)throw new Error('API returned an empty or invalid article list');
  return items.map(item=>{const relativeUrl=item?.Link?.Url;if(!relativeUrl||!item?.Title)return null;const url=new URL(relativeUrl,'https://www.kongehuset.dk').href;return{id:url,source:'kongehuset',title:item.Title.trim(),url,date:item.Date||'',type:item.TypeLabel||'Khác'}}).filter(Boolean);
}

async function fetchTv2(){
  const endpoint=process.env.TV2_SOURCE_URL||'https://nyheder.tv2.dk/';
  const response=await fetch(endpoint,{headers:{'user-agent':'Denmark-News-Monitor/1.0'}});
  if(!response.ok)throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const html=await response.text();
  const scripts=[...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let list=[];
  for(const match of scripts){try{const data=JSON.parse(match[1]);if(data?.['@type']==='CollectionPage'&&Array.isArray(data?.mainEntity?.itemListElement)){list=data.mainEntity.itemListElement;break}}catch{}}
  if(!list.length)throw new Error('Could not find the JSON-LD news ItemList on the TV 2 page');
  return list.map(item=>{if(!item?.url||!item?.name)return null;const url=new URL(item.url,'https://nyheder.tv2.dk').href;const parts=new URL(url).pathname.split('/').filter(Boolean);const dateMatch=url.match(/\/(\d{4})-(\d{2})-(\d{2})-/);const firstPart=parts[0]||'';const group=firstPart==='live'?'Live':(/^\d{4}-\d{2}-\d{2}-/.test(firstPart)?'Nyheder':(firstPart||'Nyheder'));return{id:url,source:'tv2',title:item.name.trim(),url,date:dateMatch?`${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}`:'—',type:group.charAt(0).toUpperCase()+group.slice(1)}}).filter(Boolean);
}

async function fetchKungahuset(){
  const endpoint=process.env.KUNGAHUSET_SOURCE_URL||'https://www.kungahuset.se/nyheter';
  const response=await fetch(endpoint,{headers:{'user-agent':'Nordic-Royal-News-Monitor/1.0'}});
  if(!response.ok)throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const html=await response.text();
  const items=[];
  for(const match of html.matchAll(/<li\b[^>]*class=["'][^"']*sv-channel-item[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)){
    const block=match[1];
    const link=block.match(/<a\b[^>]*href=["']([^"']*\/arkiv\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const time=block.match(/<time\b[^>]*datetime=["']([^"']+)["'][^>]*>([\s\S]*?)<\/time>/i);
    if(!link||!time)continue;
    const url=new URL(decodeHtml(link[1]),'https://www.kungahuset.se').href;
    const type=decodeHtml(block.match(/kh-news-module__content--archive[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1])||'Nyheter';
    items.push({id:url,source:'kungahuset',title:decodeHtml(link[2]),url,date:decodeHtml(time[2]),publishedAt:time[1],type});
  }
  if(!items.length)throw new Error('Could not find news cards on the Kungahuset page');
  return items;
}

async function fetchSvenskdam(){
  const endpoint=process.env.SVENSKDAM_SOURCE_URL||'https://www.svenskdam.se/';
  const response=await fetch(endpoint,{headers:{'user-agent':'Nordic-Royal-News-Monitor/1.0'}});
  if(!response.ok)throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const html=await response.text();
  const nextDataMatch=html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if(!nextDataMatch)throw new Error('Could not find __NEXT_DATA__ on the Svensk Damtidning page');
  const pageData=JSON.parse(nextDataMatch[1])?.props?.pageProps?.pageData;
  const teasers=[];
  const visit=node=>{if(!node||typeof node!=='object')return;if(node.type==='articleTeaser')teasers.push(node);for(const child of Array.isArray(node.children)?node.children:[])visit(child)};
  visit(pageData);
  const seen=new Set();
  const items=teasers.map(item=>{
    const article=item?.data||{};
    if(!article.title||!article.publishedUrl)return null;
    const url=new URL(article.publishedUrl,'https://www.svenskdam.se').href;
    if(seen.has(url))return null;
    seen.add(url);
    const publishedAt=article.publishedDate||'';
    const date=publishedAt?new Intl.DateTimeFormat('vi-VN',{timeZone:'Europe/Stockholm'}).format(new Date(publishedAt)):'—';
    const category=String(article.category||'Nyheter');
    const type=category.charAt(0).toLocaleUpperCase('sv')+category.slice(1);
    return{id:url,source:'svenskdam',title:decodeHtml(article.title),url,date,publishedAt,type};
  }).filter(Boolean);
  if(!items.length)throw new Error('Svensk Damtidning returned no article teasers');
  return items;
}

async function fetchKongehusetNo(){
  const endpoint=process.env.KONGEHUSET_NO_SOURCE_URL||'https://www.kongehuset.no/for-pressen/rss';
  const headers={'user-agent':'Nordic-Royal-News-Monitor/1.0','accept':'application/atom+xml, application/rss+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.7'};
  let response=await fetch(endpoint,{headers});
  if((response.status===403||response.status===429)&&!process.env.KONGEHUSET_NO_SOURCE_URL){
    response=await fetch(`https://r.jina.ai/http://${new URL(endpoint).host}${new URL(endpoint).pathname}`,{headers:{'user-agent':headers['user-agent']}});
  }
  if(!response.ok)throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const xml=await response.text();
  const entries=[...xml.matchAll(/<(entry|item)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  const items=entries.map(match=>{
    const entry=match[2];
    const title=decodeHtml(entry.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]).replace(/\s+-\s+(?:no|en)$/i,'').trim();
    const linkMatch=entry.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
    const linkText=decodeHtml(entry.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1]);
    const relativeUrl=decodeHtml(linkMatch?.[1]||linkText);
    const publishedAt=decodeHtml(entry.match(/<(?:published|updated|pubDate)\b[^>]*>([\s\S]*?)<\/(?:published|updated|pubDate)>/i)?.[1]);
    if(!title||!relativeUrl)return null;
    const url=new URL(relativeUrl,'https://www.kongehuset.no').href;
    const category=decodeHtml(entry.match(/<category\b[^>]*term=["']([^"']+)["'][^>]*>/i)?.[1]);
    const pathname=new URL(url).pathname;
    const type=category||(/\/presse\//i.test(pathname)?'Pressemelding':/\/tale/i.test(pathname)?'Tale':'Nyheter');
    const date=publishedAt?new Intl.DateTimeFormat('vi-VN',{timeZone:'Europe/Oslo'}).format(new Date(publishedAt)):'—';
    return{id:url,source:'kongehusetNo',title,url,date,publishedAt,type};
  }).filter(Boolean);
  if(!items.length)throw new Error('The Norwegian Royal House Atom feed returned no entries');
  return items;
}

const fetchers={kongehuset:fetchKongehuset,tv2:fetchTv2,kungahuset:fetchKungahuset,svenskdam:fetchSvenskdam,kongehusetNo:fetchKongehusetNo};
const articles=[];
const sources={};
let failed=false;

for(const [id,definition] of Object.entries(sourceDefinitions)){
  const previousSource=previous?.sources?.[id]||(id==='kongehuset'&&previous?.status?{status:previous.status}:null);
  const monitoringStartedAt=previousSource?.monitoringStartedAt||(id==='kongehuset'?previous?.monitoringStartedAt:null)||now;
  try{
    const fetched=await fetchers[id]();
    articles.push(...fetched.map(item=>({...item,firstSeenAt:previousByUrl.get(item.url)?.firstSeenAt||now})));
    sources[id]={...definition,monitoringStartedAt,status:{state:'ok',message:'',changedAt:previousSource?.status?.state==='ok'?(previousSource.status.changedAt||now):now}};
    console.log(`${definition.name}: ${fetched.length} articles.`);
  }catch(error){
    failed=true;
    const message=error?.message||String(error);
    articles.push(...oldArticles.filter(item=>item.source===id));
    const unchanged=previousSource?.status?.state==='error'&&previousSource.status.message===message;
    sources[id]={...definition,monitoringStartedAt,status:{state:'error',message,changedAt:unchanged?previousSource.status.changedAt:now}};
    console.error(`${definition.name}: ${message}`);
  }
}

async function translateTitles(titles,sourceLanguage){
  const separator='\n§§§\n';
  const text=titles.join(separator);
  let translated='';
  let googleError='';
  try{
    const base=process.env.TRANSLATE_SOURCE_URL||'https://translate.googleapis.com/translate_a/single';
    const url=new URL(base);url.searchParams.set('client','gtx');url.searchParams.set('sl',sourceLanguage);url.searchParams.set('tl','vi');url.searchParams.set('dt','t');url.searchParams.set('q',text);
    const response=await fetch(url,{headers:{'user-agent':'Denmark-News-Monitor/1.0'}});
    if(!response.ok)throw new Error(`Google HTTP ${response.status} ${response.statusText}`);
    const data=await response.json();translated=data?.[0]?.map(part=>part?.[0]||'').join('').trim();
  }catch(error){googleError=error?.message||String(error)}
  if(!translated){
    const url=new URL('https://api.mymemory.translated.net/get');url.searchParams.set('q',text);url.searchParams.set('langpair',`${sourceLanguage}|vi`);
    const response=await fetch(url,{headers:{'user-agent':'Denmark-News-Monitor/1.0'}});
    if(!response.ok)throw new Error(`${googleError}; MyMemory HTTP ${response.status} ${response.statusText}`);
    const data=await response.json();
    if(data?.responseStatus!==200)throw new Error(`${googleError}; MyMemory: ${data?.responseDetails||'invalid response'}`);
    translated=decodeHtml(data?.responseData?.translatedText||'');
  }
  if(!translated)throw new Error('Translation service returned an empty result');
  const results=translated.split(/\s*§§§\s*/);
  if(results.length!==titles.length)throw new Error(`Translation batch returned ${results.length} results instead of ${titles.length}`);
  return results.map(value=>value.trim());
}

let translationFailures=0;
let translationMessage='';
const pending=articles.filter(item=>{const old=previousByUrl.get(item.url);if(old?.title===item.title&&old?.titleVi&&!/&#(?:\d+|x[\da-f]+);/i.test(old.titleVi)){item.titleVi=old.titleVi;return false}return true});
const batches=[];
for(const item of pending){const language=sourceDefinitions[item.source]?.language||'da';const current=batches.at(-1);if(!current||current.language!==language||current.items.reduce((sum,value)=>sum+value.title.length,0)+item.title.length+5>350)batches.push({language,items:[item]});else current.items.push(item)}
for(const batch of batches){
  try{const translations=await translateTitles(batch.items.map(item=>item.title),batch.language);batch.items.forEach((item,itemIndex)=>{item.titleVi=translations[itemIndex];delete item.translationError})}catch(error){translationMessage=error?.message||String(error);translationFailures+=batch.items.length;batch.items.forEach(item=>{item.titleVi='';item.translationError=translationMessage})}
}
const previousTranslation=previous?.translation?.status;
const translationState=translationFailures?'error':'ok';
const translationStatus={state:translationState,message:translationFailures?`${translationFailures} tiêu đề chưa dịch được. Lỗi gần nhất: ${translationMessage}`:'',changedAt:previousTranslation?.state===translationState&&previousTranslation?.message===(translationFailures?`${translationFailures} tiêu đề chưa dịch được. Lỗi gần nhất: ${translationMessage}`:'')?(previousTranslation.changedAt||now):now};
if(translationFailures)failed=true;

const comparable=data=>JSON.stringify(data,(key,value)=>key==='updatedAt'?undefined:value);
const data={monitoringStartedAt:previous?.monitoringStartedAt||now,updatedAt:now,sources,translation:{status:translationStatus},articles};
if(previous&&comparable({...data,updatedAt:previous.updatedAt})===comparable(previous)){
  console.log('No data or status changes.');
}else{
  await mkdir(path.dirname(output),{recursive:true});
  await writeFile(output,`${JSON.stringify(data,null,2)}\n`,'utf8');
  console.log(`Saved ${articles.length} total articles.`);
}
if(failed)process.exitCode=1;
