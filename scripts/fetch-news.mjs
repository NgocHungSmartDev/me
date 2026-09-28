import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE=process.env.NEWS_SOURCE_URL||'https://www.kongehuset.dk/umbraco/api/NewsArchiveApi/Initialize?culture=da';
const SITE='https://www.kongehuset.dk';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'data','news.json');
let previous=null;
try{previous=JSON.parse(await readFile(output,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}

const now=new Date().toISOString();
const save=async data=>{await mkdir(path.dirname(output),{recursive:true});await writeFile(output,`${JSON.stringify(data,null,2)}\n`,'utf8')};

try{
  const response=await fetch(SOURCE,{headers:{'user-agent':'Kongehuset-News-Monitor/1.0'}});
  if(!response.ok)throw new Error(`Kongehuset API returned HTTP ${response.status} ${response.statusText}`);
  const sourceItems=await response.json();
  if(!Array.isArray(sourceItems)||!sourceItems.length)throw new Error('Kongehuset API returned an empty or invalid article list');
  const previousByUrl=new Map((previous?.articles??[]).map(item=>[item.url,item]));
  const articles=sourceItems.map(item=>{const relativeUrl=item?.Link?.Url;if(!relativeUrl||!item?.Title)return null;const url=new URL(relativeUrl,SITE).href;return{id:url,title:item.Title.trim(),url,date:item.Date||'',type:item.TypeLabel||'Khác',firstSeenAt:previousByUrl.get(url)?.firstSeenAt||now}}).filter(Boolean);
  const comparable=value=>JSON.stringify(value.map(({firstSeenAt,...item})=>item));
  const contentChanged=!previous||comparable(previous.articles)!==comparable(articles);
  const recovered=previous?.status?.state==='error';
  const needsStatusUpdate=previous?.status?.state!=='ok';
  if(!contentChanged&&!needsStatusUpdate){console.log(`No changes (${articles.length} articles).`);process.exit(0)}
  await save({source:'https://www.kongehuset.dk/nyhedsarkiv/',monitoringStartedAt:previous?.monitoringStartedAt||now,updatedAt:contentChanged?now:previous.updatedAt,status:{state:'ok',message:'',changedAt:needsStatusUpdate?now:(previous?.status?.changedAt||now)},articles});
  console.log(`Saved ${articles.length} articles${recovered?' and cleared the previous error':''}.`);
}catch(error){
  const message=error?.stack||error?.message||String(error);
  console.error(message);
  const sameError=previous?.status?.state==='error'&&previous.status.message===message;
  if(!sameError)await save({source:'https://www.kongehuset.dk/nyhedsarkiv/',monitoringStartedAt:previous?.monitoringStartedAt||now,updatedAt:previous?.updatedAt||now,status:{state:'error',message,changedAt:now},articles:previous?.articles||[]});
  process.exitCode=1;
}
